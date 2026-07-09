// DOM wiring for the QR studio + redirect management panel. One shared
// `options` object (qr/types.ts) is the single source of truth: presets
// seed it, every individual control mutates it directly, and any change
// triggers a full re-render (qr-code-styling `.update()` + our canvas
// wrapper for the bits it doesn't natively support).
import QRCodeStyling from 'qr-code-styling';
import {
  listRedirects,
  createRedirect,
  updateRedirect,
  deleteRedirect,
  listStyleVersions,
  saveStyleVersion,
  type RedirectDto,
  type StyleVersionDto,
} from './api.js';
import { REDIRECT_BASE_URL } from './constants.js';
import { defaultOptions, type AppQrOptions, type DotRadiusStep, type DotType } from './qr/types.js';
import { resolveOptionsForTarget } from './qr/styleForSlug.js';
import { contrastRatio, isLowContrast } from './qr/contrast.js';
import { shouldWarnLogoCoverage } from './qr/coverage.js';
import { resolveErrorCorrectionLevel } from './qr/eccPolicy.js';
import { loadIconAsDataUrl } from './qr/iconLoader.js';
import { getRawDataAsCanvas, applyOverallRadius, applyImageBorder, exportCanvas } from './qr/wrapper.js';
import { decodeAndVerify } from './qr/testScan.js';
import { createColorSwatchPicker, type ColorSwatchPickerHandle } from './ui/colorSwatchPicker.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

/**
 * Appends `url` to `el` as alternating text nodes and real `<wbr>` elements,
 * inserting a break opportunity immediately after every `/`, `.`, and `-`
 * (the standard "safe to break here" URL characters). `<wbr>` is a real DOM
 * element the browser renders invisibly and excludes from copy-pasted text
 * (unlike a zero-width-space character, which would corrupt anything copied
 * from the link) — so the visible/copyable text stays byte-identical to
 * `url` while gaining break points `overflow-wrap: anywhere` alone can't
 * find on its own for URLs with a long unbroken prefix (e.g. the short-link
 * base URL, which at mobile widths can consume nearly the whole line before
 * the variable slug even starts, forcing a mid-word break without this).
 * Built with createTextNode/createElement — never innerHTML — matching the
 * XSS-safe discipline used throughout `renderRedirectList()`.
 */
function appendWrappableUrlText(el: HTMLElement, url: string): void {
  const segments = url.split(/(?<=[/.-])/);
  for (const segment of segments) {
    el.append(document.createTextNode(segment));
    el.append(document.createElement('wbr'));
  }
}

/**
 * Builds a `<a>` for a redirect-card "Short link"/"Points to" value that
 * opens `href` in a new tab. `.href` is set as a DOM property — never
 * string-templated into innerHTML — matching the XSS-safe discipline used
 * throughout `renderRedirectList()`. Visible text is built via
 * `appendWrappableUrlText()` so long values wrap at `/`, `.`, `-` boundaries
 * instead of arbitrary mid-word breaks.
 */
function createExternalLinkValue(href: string, className: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = className;
  appendWrappableUrlText(a, href);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

// Maps each of the 6 dot Style values onto the nearest of the 3 stepped Radius
// options. Lets the Style→Radius sync be bidirectional: when the Style
// dropdown is changed directly, the Radius dropdown updates to the matching
// step instead of showing a stale value. Display-only — it never changes what
// actually renders (dotsOptions.type stays whatever the Style is).
const STYLE_TO_RADIUS_STEP: Record<DotType, DotRadiusStep> = {
  square: 'square',
  rounded: 'rounded',
  classy: 'rounded',
  'classy-rounded': 'extra-rounded',
  dots: 'extra-rounded',
  'extra-rounded': 'extra-rounded',
};

const PRESETS: Record<string, Partial<AppQrOptions>> = {
  classic: {
    dotsOptions: { type: 'square', color: '#000000' },
    cornersSquareOptions: { type: 'square', color: '#000000' },
    cornersDotOptions: { type: 'square', color: '#000000' },
    backgroundOptions: { enabled: true, color: '#ffffff' },
    appExtensions: { overallRadiusPx: 0, border: { enabled: false, thicknessPx: 4, radiusPx: 0, color: '#000000' } },
  },
  rounded: {
    dotsOptions: { type: 'rounded', color: '#1c2541' },
    cornersSquareOptions: { type: 'extra-rounded', color: '#1c2541' },
    cornersDotOptions: { type: 'dot', color: '#1c2541' },
    backgroundOptions: { enabled: true, color: '#f5f6fa' },
    appExtensions: { overallRadiusPx: 24, border: { enabled: false, thicknessPx: 4, radiusPx: 24, color: '#1c2541' } },
  },
  bold: {
    dotsOptions: { type: 'extra-rounded', color: '#ffffff' },
    cornersSquareOptions: { type: 'dot', color: '#ffffff' },
    cornersDotOptions: { type: 'dot', color: '#ffffff' },
    backgroundOptions: { enabled: true, color: '#e63946' },
    appExtensions: {
      overallRadiusPx: 32,
      border: { enabled: true, thicknessPx: 8, radiusPx: 32, color: '#e63946' },
    },
  },
};

type View = 'list' | 'detail' | 'qr-studio' | 'settings';

type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'cuearcode-theme';

// Placeholder `data` for the brief pre-boot instant before any redirect has
// been fetched and a slug selected — QR Studio is always entered bound to a
// real slug (via Detail view's "Generate QR Code" or the version gallery),
// so this value is never actually shown to the user; it only seeds the
// (hidden) initial render so `options` is never in an invalid state.
const INITIAL_PLACEHOLDER_DATA = `${REDIRECT_BASE_URL}/example`;

export function initUi(): void {
  let options: AppQrOptions = defaultOptions(INITIAL_PLACEHOLDER_DATA);
  let redirects: RedirectDto[] = [];
  let selectedSlug: string | null = null;
  let qr: QRCodeStyling | undefined;

  // Detail view is currently showing this slug (or null when not on that view).
  let detailSlug: string | null = null;
  // Which detail-view slug QR Studio was opened *from*, so its back button
  // returns there rather than jumping all the way to the top-level list.
  let qrStudioOrigin: string | null = null;
  // Which preset (Classic/Rounded/Bold) was most recently clicked, for the
  // preset buttons' selected-state feedback. Deliberately doesn't try to
  // track whether the user has since manually diverged from that preset by
  // tweaking an individual control — it's honest "this is the preset you
  // last clicked" feedback, not a full style-diffing feature.
  let lastAppliedPreset: string | null = null;

  const els = {
    // Nav + views
    navRedirects: byId<HTMLAnchorElement>('nav-redirects'),
    navSettings: byId<HTMLAnchorElement>('nav-settings'),
    viewList: byId<HTMLElement>('view-list'),
    viewDetail: byId<HTMLElement>('view-detail'),
    viewQrStudio: byId<HTMLElement>('view-qr-studio'),
    viewSettings: byId<HTMLElement>('view-settings'),

    // List view
    newRedirectToggle: byId<HTMLButtonElement>('new-redirect-toggle'),
    newRedirectCancel: byId<HTMLButtonElement>('new-redirect-cancel'),
    createForm: byId<HTMLFormElement>('create-redirect-form'),
    newSlugDomain: byId<HTMLSelectElement>('new-slug-domain'),
    newSlug: byId<HTMLInputElement>('new-slug'),
    newDisplayName: byId<HTMLInputElement>('new-display-name'),
    newTargetUrl: byId<HTMLInputElement>('new-target-url'),
    createStatus: byId<HTMLParagraphElement>('create-redirect-status'),
    redirectList: byId<HTMLUListElement>('redirect-list'),

    // Detail view
    detailBackBtn: byId<HTMLButtonElement>('detail-back-btn'),
    detailDisplayName: byId<HTMLHeadingElement>('detail-display-name'),
    detailSlug: byId<HTMLElement>('detail-slug'),
    detailForm: byId<HTMLFormElement>('detail-form'),
    detailDisplayNameInput: byId<HTMLInputElement>('detail-display-name-input'),
    detailTargetUrlInput: byId<HTMLInputElement>('detail-target-url-input'),
    detailSaveStatus: byId<HTMLParagraphElement>('detail-save-status'),
    detailRedirectUrl: byId<HTMLAnchorElement>('detail-redirect-url'),
    detailGenerateQrBtn: byId<HTMLButtonElement>('detail-generate-qr-btn'),
    detailDeleteBtn: byId<HTMLButtonElement>('detail-delete-btn'),
    detailQrGallerySection: byId<HTMLElement>('detail-qr-gallery-section'),
    detailQrGallery: byId<HTMLUListElement>('detail-qr-gallery'),

    // QR Studio view
    qrBackBtn: byId<HTMLButtonElement>('qr-back-btn'),
    qrDisplayName: byId<HTMLHeadingElement>('qr-display-name'),
    qrSlug: byId<HTMLElement>('qr-slug'),
    qrData: byId<HTMLElement>('qr-data'),

    dotStyle: byId<HTMLSelectElement>('dot-style'),
    dotRadiusStep: byId<HTMLSelectElement>('dot-radius-step'),
    dotColorMount: byId<HTMLElement>('dot-color-mount'),
    cornerSquareStyle: byId<HTMLSelectElement>('corner-square-style'),
    cornerSquareColorMount: byId<HTMLElement>('corner-square-color-mount'),
    cornerDotStyle: byId<HTMLSelectElement>('corner-dot-style'),
    cornerDotColorMount: byId<HTMLElement>('corner-dot-color-mount'),

    bgEnabled: byId<HTMLInputElement>('bg-enabled'),
    bgColorMount: byId<HTMLElement>('bg-color-mount'),

    margin: byId<HTMLInputElement>('margin'),
    marginValue: byId<HTMLSpanElement>('margin-value'),
    overallRadius: byId<HTMLInputElement>('overall-radius'),
    overallRadiusValue: byId<HTMLSpanElement>('overall-radius-value'),

    borderEnabled: byId<HTMLInputElement>('border-enabled'),
    borderThickness: byId<HTMLInputElement>('border-thickness'),
    borderThicknessValue: byId<HTMLSpanElement>('border-thickness-value'),
    borderRadius: byId<HTMLInputElement>('border-radius'),
    borderRadiusValue: byId<HTMLSpanElement>('border-radius-value'),
    borderColorMount: byId<HTMLElement>('border-color-mount'),

    iconFile: byId<HTMLInputElement>('icon-file'),
    iconRemove: byId<HTMLButtonElement>('icon-remove'),
    iconSize: byId<HTMLInputElement>('icon-size'),
    iconSizeValue: byId<HTMLSpanElement>('icon-size-value'),
    iconStatus: byId<HTMLParagraphElement>('icon-status'),

    eccLevel: byId<HTMLSelectElement>('ecc-level'),

    preview: byId<HTMLCanvasElement>('qr-preview'),
    warnings: byId<HTMLDivElement>('warnings'),

    testScanBtn: byId<HTMLButtonElement>('test-scan-btn'),
    testScanResult: byId<HTMLParagraphElement>('test-scan-result'),

    exportFormat: byId<HTMLSelectElement>('export-format'),
    exportBtn: byId<HTMLButtonElement>('export-btn'),
    exportStatus: byId<HTMLParagraphElement>('export-status'),

    saveStyleBtn: byId<HTMLButtonElement>('save-style-btn'),
    saveStyleStatus: byId<HTMLParagraphElement>('save-style-status'),
    styleHistory: byId<HTMLUListElement>('style-history'),

    // Settings view
    themeSelect: byId<HTMLSelectElement>('theme-select'),
  };

  // ---- Color swatch pickers (Dots/Corners/Background/Border color controls) ----
  //
  // Each replaces what used to be a bare <input type="color">: mounted into
  // its `*-color-mount` container, wired to update `options` and re-render on
  // change (same behavior the raw inputs' 'input' listeners used to provide),
  // and kept in sync via `.setColor()` from `syncControlsFromOptions()`.
  const dotColorPicker: ColorSwatchPickerHandle = createColorSwatchPicker({
    initialColor: options.dotsOptions.color,
    label: 'Dot color',
    onChange: (color) => {
      options.dotsOptions.color = color;
      scheduleRender();
    },
  });
  els.dotColorMount.appendChild(dotColorPicker.element);

  const cornerSquareColorPicker: ColorSwatchPickerHandle = createColorSwatchPicker({
    initialColor: options.cornersSquareOptions.color,
    label: 'Corner square color',
    onChange: (color) => {
      options.cornersSquareOptions.color = color;
      scheduleRender();
    },
  });
  els.cornerSquareColorMount.appendChild(cornerSquareColorPicker.element);

  const cornerDotColorPicker: ColorSwatchPickerHandle = createColorSwatchPicker({
    initialColor: options.cornersDotOptions.color,
    label: 'Corner dot color',
    onChange: (color) => {
      options.cornersDotOptions.color = color;
      scheduleRender();
    },
  });
  els.cornerDotColorMount.appendChild(cornerDotColorPicker.element);

  const bgColorPicker: ColorSwatchPickerHandle = createColorSwatchPicker({
    initialColor: options.backgroundOptions.color,
    label: 'Background color',
    onChange: (color) => {
      options.backgroundOptions.color = color;
      scheduleRender();
    },
  });
  els.bgColorMount.appendChild(bgColorPicker.element);

  const borderColorPicker: ColorSwatchPickerHandle = createColorSwatchPicker({
    initialColor: options.appExtensions.border.color,
    label: 'Border color',
    onChange: (color) => {
      options.appExtensions.border.color = color;
      scheduleRender();
    },
  });
  els.borderColorMount.appendChild(borderColorPicker.element);

  // ---- View navigation ----

  function showView(view: View): void {
    els.viewList.hidden = view !== 'list';
    els.viewDetail.hidden = view !== 'detail';
    els.viewQrStudio.hidden = view !== 'qr-studio';
    els.viewSettings.hidden = view !== 'settings';
    // "Redirects" stays highlighted for detail/QR-studio too — they're both
    // reached from within the redirects flow, not independent top-level areas.
    els.navRedirects.classList.toggle('active', view === 'list' || view === 'detail' || view === 'qr-studio');
    els.navSettings.classList.toggle('active', view === 'settings');
  }

  // ---- URL routing ----
  //
  // Real URL-path routing for a single-page app, hand-rolled (no router
  // library — the route set is tiny and fixed):
  //   /                        -> list
  //   /redirects/:slug         -> detail
  //   /redirects/:slug/qr      -> qr-studio
  //   /settings                -> settings
  //
  // `navigateTo` is the single choke point every in-app navigation goes
  // through: it updates the visible section (via `showView`) AND keeps
  // `location.pathname` in sync via the History API, so the URL bar, back
  // button, and bookmarks/shared links all stay meaningful. The server's
  // catch-all route (src/server.ts) serves index.html for any of these
  // paths so a direct load/refresh works too.

  interface NavParams {
    slug?: string;
  }

  function pathForView(view: View, params: NavParams): string {
    switch (view) {
      case 'list':
        return '/';
      case 'settings':
        return '/settings';
      case 'detail':
        return `/redirects/${encodeURIComponent(params.slug ?? '')}`;
      case 'qr-studio':
        return `/redirects/${encodeURIComponent(params.slug ?? '')}/qr`;
    }
  }

  /**
   * Updates the visible view AND the URL/history to match. Every call site
   * that used to call `showView(...)` directly now routes through here
   * instead, so the URL can never drift out of sync with what's on screen.
   *
   * `opts.fromPopstate` must be set when re-rendering in response to a
   * `popstate` event (browser back/forward): the browser has *already*
   * updated `location` for us in that case, so calling pushState/
   * replaceState again would either duplicate a history entry or — worse —
   * push a new *forward* entry on every single back-button press, which
   * would break back/forward navigation entirely.
   */
  function navigateTo(view: View, params: NavParams = {}, opts: { replace?: boolean; fromPopstate?: boolean } = {}): void {
    showView(view);
    if (opts.fromPopstate) return;
    const path = pathForView(view, params);
    if (opts.replace) {
      history.replaceState({ view, params }, '', path);
    } else if (path !== location.pathname) {
      history.pushState({ view, params }, '', path);
    }
  }

  type Route =
    | { view: 'list' }
    | { view: 'settings' }
    | { view: 'detail'; slug: string }
    | { view: 'qr-studio'; slug: string };

  function matchRoute(pathname: string): Route {
    const qrMatch = /^\/redirects\/([^/]+)\/qr\/?$/.exec(pathname);
    if (qrMatch) return { view: 'qr-studio', slug: decodeURIComponent(qrMatch[1] ?? '') };
    const detailMatch = /^\/redirects\/([^/]+)\/?$/.exec(pathname);
    if (detailMatch) return { view: 'detail', slug: decodeURIComponent(detailMatch[1] ?? '') };
    if (pathname === '/settings' || pathname === '/settings/') return { view: 'settings' };
    return { view: 'list' };
  }

  /**
   * Re-derives the current view + params from `location.pathname` and
   * renders it — shared by initial boot (once `redirects` has loaded) and
   * the `popstate` handler (browser back/forward). Both of those cases pass
   * `fromPopstate: true`: the URL is already correct, this call should only
   * ever *render* it, never push/replace history for it — except when the
   * URL points at a slug that no longer exists, where we deliberately
   * replace the bad URL with `/` so it doesn't sit in history as a
   * back-button trap.
   */
  async function resolveRoute(opts: { fromPopstate?: boolean } = {}): Promise<void> {
    const route = matchRoute(location.pathname);
    switch (route.view) {
      case 'list':
        navigateTo('list', {}, opts);
        return;
      case 'settings':
        navigateTo('settings', {}, opts);
        return;
      case 'detail': {
        const row = redirects.find((r) => r.slug === route.slug);
        if (!row) {
          navigateTo('list', {}, { replace: true });
          return;
        }
        openDetail(route.slug, opts);
        return;
      }
      case 'qr-studio': {
        const row = redirects.find((r) => r.slug === route.slug);
        if (!row) {
          navigateTo('list', {}, { replace: true });
          return;
        }
        qrStudioOrigin = route.slug;
        await selectSlug(route.slug);
        navigateTo('qr-studio', { slug: route.slug }, opts);
        return;
      }
    }
  }

  window.addEventListener('popstate', () => {
    void resolveRoute({ fromPopstate: true });
  });

  els.navRedirects.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('list');
  });
  els.navSettings.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('settings');
  });

  // ---- Theme (Settings) ----

  function applyTheme(choice: ThemeChoice): void {
    if (choice === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', choice);
    }
  }

  function loadStoredTheme(): ThemeChoice {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  }

  function initTheme(): void {
    // The inline <head> script already stamped data-theme (if a stored
    // override exists) before first paint — this just brings the Settings
    // control's displayed value in sync with that on boot.
    const choice = loadStoredTheme();
    els.themeSelect.value = choice;
  }

  els.themeSelect.addEventListener('change', () => {
    const choice = els.themeSelect.value as ThemeChoice;
    if (choice === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
    applyTheme(choice);
  });

  function syncControlsFromOptions(): void {
    els.qrData.textContent = options.data;
    els.dotStyle.value = options.dotsOptions.type;
    dotColorPicker.setColor(options.dotsOptions.color);
    els.cornerSquareStyle.value = options.cornersSquareOptions.type;
    cornerSquareColorPicker.setColor(options.cornersSquareOptions.color);
    els.cornerDotStyle.value = options.cornersDotOptions.type;
    cornerDotColorPicker.setColor(options.cornersDotOptions.color);
    els.bgEnabled.checked = options.backgroundOptions.enabled;
    bgColorPicker.setColor(options.backgroundOptions.color);
    els.margin.value = String(options.margin);
    els.marginValue.textContent = String(options.margin);
    els.overallRadius.value = String(options.appExtensions.overallRadiusPx);
    els.overallRadiusValue.textContent = String(options.appExtensions.overallRadiusPx);
    els.borderEnabled.checked = options.appExtensions.border.enabled;
    els.borderThickness.value = String(options.appExtensions.border.thicknessPx);
    els.borderThicknessValue.textContent = String(options.appExtensions.border.thicknessPx);
    els.borderRadius.value = String(options.appExtensions.border.radiusPx);
    els.borderRadiusValue.textContent = String(options.appExtensions.border.radiusPx);
    borderColorPicker.setColor(options.appExtensions.border.color);
    els.iconSize.value = String(Math.round(options.imageOptions.imageSizeRatio * 100));
    els.iconSizeValue.textContent = String(Math.round(options.imageOptions.imageSizeRatio * 100));
    els.eccLevel.value = options.qrOptions.errorCorrectionLevel;
    // Keep the stepped Radius selector in sync with the active dot style,
    // mapping the 6 styles onto the 3 steps so the two controls never disagree.
    els.dotRadiusStep.value = STYLE_TO_RADIUS_STEP[options.dotsOptions.type];
  }

  function renderWarnings(): void {
    const warnings: string[] = [];
    const ratio = contrastRatio(options.dotsOptions.color, options.backgroundOptions.color);
    if (options.backgroundOptions.enabled && isLowContrast(ratio)) {
      warnings.push(`Low contrast (${ratio.toFixed(2)}:1) between dot color and background — scanners may struggle.`);
    }
    if (
      shouldWarnLogoCoverage(
        options.imageOptions.imageSizeRatio,
        options.image !== undefined,
        options.qrOptions.errorCorrectionLevel,
      )
    ) {
      warnings.push('Center icon covers a large area without error correction at H — scans may fail.');
    }
    els.warnings.innerHTML = '';
    for (const w of warnings) {
      const p = document.createElement('p');
      p.className = 'warning';
      p.textContent = `⚠ ${w}`;
      els.warnings.appendChild(p);
    }
  }

  // Guards against overlapping renders: qr.getRawData() is async, and rapid
  // input (dragging a slider/color picker) can fire many renderQr() calls
  // before the first one resolves. `scheduleRender()` debounces bursts into
  // one trailing render; `renderGeneration` is a belt-and-braces check so
  // that even if two renders somehow overlap, a stale one can never
  // overwrite a newer one's output.
  let renderGeneration = 0;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRender(): void {
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => void renderQr(), 40);
  }

  async function renderQr(): Promise<void> {
    const myGeneration = ++renderGeneration;

    const libOptions = {
      width: options.width,
      height: options.height,
      type: 'canvas' as const,
      data: options.data,
      margin: options.margin,
      qrOptions: { errorCorrectionLevel: options.qrOptions.errorCorrectionLevel },
      dotsOptions: options.dotsOptions,
      cornersSquareOptions: options.cornersSquareOptions,
      cornersDotOptions: options.cornersDotOptions,
      backgroundOptions: {
        color: options.backgroundOptions.enabled ? options.backgroundOptions.color : 'transparent',
      },
      // Omit the `image` key entirely when unset rather than passing
      // `image: undefined` — with `exactOptionalPropertyTypes` the library's
      // `image?: string` is not the same type as `string | undefined`.
      ...(options.image !== undefined ? { image: options.image } : {}),
      imageOptions: {
        imageSize: options.imageOptions.imageSizeRatio,
        hideBackgroundDots: options.imageOptions.hideBackgroundDots,
        margin: 4,
      },
    };

    if (!qr) {
      qr = new QRCodeStyling(libOptions);
    } else {
      qr.update(libOptions);
    }

    try {
      let canvas = await getRawDataAsCanvas(qr, options.width, options.height);
      if (myGeneration !== renderGeneration) return; // superseded by a newer render

      canvas = applyOverallRadius(canvas, options.appExtensions.overallRadiusPx);
      canvas = applyImageBorder(canvas, options.appExtensions.border, options.appExtensions.overallRadiusPx);

      els.preview.width = canvas.width;
      els.preview.height = canvas.height;
      const ctx = els.preview.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, els.preview.width, els.preview.height);
        ctx.drawImage(canvas, 0, 0);
      }
      renderWarnings();
    } catch (err) {
      if (myGeneration === renderGeneration) {
        console.error('QR render failed', err);
      }
    }
  }

  // ---- Redirect list (cards) ----

  function renderRedirectList(): void {
    els.redirectList.innerHTML = '';

    for (const r of redirects) {
      const li = document.createElement('li');
      li.className = 'redirect-card';

      // Everything below is built via createElement + textContent (and, for
      // the two link values, the `.href` DOM property), never innerHTML
      // interpolation: display_name and target_url are both
      // attacker-influenced (a redirect's label and target), so
      // string-templating either into innerHTML would be a stored-XSS sink.
      // textContent/`.href` escapes everything — same discipline for both
      // fields. target_url is additionally server-validated (isValidTargetUrl
      // in src/routes/redirects.ts) to be a well-formed http(s) URL rejecting
      // `<>"'\`` before it ever reaches here.
      const body = document.createElement('div');
      body.className = 'card-body';
      body.tabIndex = 0;
      body.setAttribute('role', 'button');
      body.setAttribute('aria-label', `View redirect ${r.display_name}`);

      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = r.display_name;
      body.appendChild(title);

      const shortRow = document.createElement('div');
      shortRow.className = 'card-row';
      const shortLabel = document.createElement('span');
      shortLabel.className = 'card-label';
      shortLabel.textContent = 'Short link';
      const shortValue = createExternalLinkValue(r.redirect_url, 'card-value');
      shortRow.append(shortLabel, shortValue);
      body.appendChild(shortRow);

      const targetRow = document.createElement('div');
      targetRow.className = 'card-row';
      const targetLabel = document.createElement('span');
      targetLabel.className = 'card-label';
      targetLabel.textContent = 'Points to';
      const targetValue = createExternalLinkValue(r.target_url, 'card-value card-value-wrap');
      targetRow.append(targetLabel, targetValue);
      body.appendChild(targetRow);

      const openThisDetail = () => openDetail(r.slug);
      body.addEventListener('click', (e) => {
        // Let the short-link/target-url anchors handle their own click
        // (open in a new tab) instead of *also* navigating this card into
        // the Detail view — click events bubble from the anchor up to the
        // card body, so without this guard both actions would fire.
        if ((e.target as HTMLElement | null)?.closest('a')) return;
        openThisDetail();
      });
      body.addEventListener('keydown', (e) => {
        if ((e.target as HTMLElement | null)?.closest('a')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThisDetail();
        }
      });

      li.append(body);
      els.redirectList.appendChild(li);
    }
  }

  async function refreshRedirects(): Promise<void> {
    redirects = await listRedirects();
    renderRedirectList();
  }

  // ---- Detail view ----

  function openDetail(slug: string, navOpts: { replace?: boolean; fromPopstate?: boolean } = {}): void {
    const row = redirects.find((r) => r.slug === slug);
    if (!row) return;
    detailSlug = slug;
    els.detailDisplayName.textContent = row.display_name;
    els.detailSlug.textContent = row.slug;
    els.detailDisplayNameInput.value = row.display_name;
    els.detailTargetUrlInput.value = row.target_url;
    els.detailRedirectUrl.textContent = '';
    appendWrappableUrlText(els.detailRedirectUrl, row.redirect_url);
    // Set via the DOM property (not string-templated into innerHTML) — same
    // XSS-safe discipline as the appendWrappableUrlText() call above.
    // redirect_url is always server-constructed
    // (`${REDIRECT_BASE_URL}/${slug}`), never a user-supplied whole string,
    // so it's inherently safe as an href too.
    els.detailRedirectUrl.href = row.redirect_url;
    els.detailSaveStatus.textContent = '';
    // Clear synchronously so a stale previous slug's gallery never flashes
    // while this slug's versions are still in flight.
    els.detailQrGallery.innerHTML = '';
    els.detailQrGallerySection.hidden = true;
    navigateTo('detail', { slug }, navOpts);
    void refreshDetailQrGallery(slug);
  }

  /** Fetches `slug`'s saved QR style versions and (re)renders the Detail view's gallery. */
  async function refreshDetailQrGallery(slug: string): Promise<void> {
    const versions = await listStyleVersions(slug);
    // The user may have navigated away from this slug's Detail view before
    // the fetch resolved — don't paint a stale gallery over whatever's now showing.
    if (detailSlug !== slug) return;
    renderDetailQrGallery(slug, versions);
  }

  /** Renders the Detail view's "Saved QR styles" gallery — hidden entirely when there's nothing saved yet. */
  function renderDetailQrGallery(slug: string, versions: StyleVersionDto[]): void {
    els.detailQrGallery.innerHTML = '';
    if (versions.length === 0) {
      els.detailQrGallerySection.hidden = true;
      return;
    }
    els.detailQrGallerySection.hidden = false;

    const sorted = [...versions].sort((a, b) => b.version - a.version);
    for (const v of sorted) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gallery-version-btn';
      btn.textContent = `v${v.version} — ${new Date(v.created_at).toLocaleString()}`;
      btn.addEventListener('click', () => {
        qrStudioOrigin = slug;
        void (async () => {
          await selectSlugWithVersion(slug, v.version);
          navigateTo('qr-studio', { slug });
        })();
      });
      li.appendChild(btn);
      els.detailQrGallery.appendChild(li);
    }
  }

  els.detailBackBtn.addEventListener('click', () => {
    navigateTo('list');
  });

  els.detailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      if (!detailSlug) return;
      const slug = detailSlug;
      const row = redirects.find((r) => r.slug === slug);
      if (!row) return;

      const nextDisplayName = els.detailDisplayNameInput.value.trim();
      const nextTargetUrl = els.detailTargetUrlInput.value.trim();
      const updates: { targetUrl?: string; displayName?: string } = {};
      if (nextTargetUrl !== row.target_url) updates.targetUrl = nextTargetUrl;
      if (nextDisplayName !== row.display_name) updates.displayName = nextDisplayName;

      if (Object.keys(updates).length === 0) {
        els.detailSaveStatus.textContent = 'No changes to save.';
        return;
      }

      try {
        const { cloudflare } = await updateRedirect(slug, updates);
        els.detailSaveStatus.textContent = cloudflare.ok
          ? 'Saved.'
          : `Saved locally — Cloudflare sync failed: ${cloudflare.error ?? 'unknown error'}`;
        await refreshRedirects();
        openDetail(slug);
      } catch (err) {
        els.detailSaveStatus.textContent = `Failed to save: ${(err as Error).message}`;
      }
    })();
  });

  els.detailGenerateQrBtn.addEventListener('click', () => {
    if (!detailSlug) return;
    const slug = detailSlug;
    qrStudioOrigin = slug;
    void (async () => {
      await selectSlug(slug);
      navigateTo('qr-studio', { slug });
    })();
  });

  els.detailDeleteBtn.addEventListener('click', () => {
    if (!detailSlug) return;
    const slug = detailSlug;
    void (async () => {
      const deleted = await removeRedirect(slug);
      if (deleted) navigateTo('list');
    })();
  });

  /** Populates the QR Studio identity header (display name + slug) for `slug`. */
  function updateQrIdentity(slug: string, row: RedirectDto | undefined): void {
    els.qrDisplayName.textContent = row ? row.display_name : slug;
    els.qrSlug.textContent = slug;
  }

  /**
   * Loads QR Studio for `slug`. By default loads that slug's latest saved
   * style (or clean defaults if it has none) — this is the existing,
   * established behavior "Generate QR Code" relies on and must not change.
   * Pass `preferredVersion` to instead load one specific older saved
   * version (used by the Detail view's saved-QR gallery).
   */
  async function selectSlug(slug: string, preferredVersion?: number): Promise<void> {
    selectedSlug = slug;
    const row = redirects.find((r) => r.slug === slug);
    updateQrIdentity(slug, row);

    const targetData = row ? row.redirect_url : options.data;
    // Always rebuild from a clean base for the new target — never carry
    // forward whatever the previously-active slug left in `options`. If the
    // slug has saved style history, the relevant version (latest, or
    // `preferredVersion` when given) is merged on top of that clean base;
    // otherwise it's plain defaults.
    const versions = await listStyleVersions(slug);
    options = resolveOptionsForTarget(targetData, versions, preferredVersion);
    // A newly-selected slug never has a "just clicked" preset, regardless
    // of what was last clicked for a previously-viewed slug's QR Studio.
    lastAppliedPreset = null;
    syncPresetSelectedState();
    syncControlsFromOptions();
    scheduleRender();
    renderHistory(versions);
  }

  /** Thin wrapper over `selectSlug` for jumping straight to one specific saved version (Detail view's gallery). */
  function selectSlugWithVersion(slug: string, version: number): Promise<void> {
    return selectSlug(slug, version);
  }

  /** Confirms, deletes, and refreshes the list. Returns whether it actually deleted. */
  async function removeRedirect(slug: string): Promise<boolean> {
    if (!window.confirm(`Delete redirect '${slug}'?`)) return false;
    try {
      const { cloudflare } = await deleteRedirect(slug);
      els.createStatus.textContent = cloudflare.ok
        ? `Deleted '${slug}' (Cloudflare synced).`
        : `Deleted '${slug}' locally — Cloudflare sync failed: ${cloudflare.error ?? 'unknown error'}`;
      if (selectedSlug === slug) selectedSlug = null;
      if (detailSlug === slug) detailSlug = null;
      await refreshRedirects();
      return true;
    } catch (err) {
      els.createStatus.textContent = `Failed to delete '${slug}': ${(err as Error).message}`;
      return false;
    }
  }

  // ---- Create redirect (list view) ----

  // The ID field's base-URL prefix reads as static text (like a phone
  // number's "+44" country-code segment) but is a real <select> underneath —
  // deliberately scoped to a single option for now (only one Cloudflare zone
  // is wired up); more base domains can be added here later without any
  // markup changes. Populated from the shared REDIRECT_BASE_URL constant
  // (scheme stripped for display) rather than hardcoded in HTML, so the two
  // never drift.
  function initSlugDomainOptions(): void {
    els.newSlugDomain.innerHTML = '';
    const opt = document.createElement('option');
    const displayPrefix = `${REDIRECT_BASE_URL.replace(/^https?:\/\//, '')}/`;
    opt.value = displayPrefix;
    opt.textContent = displayPrefix;
    els.newSlugDomain.appendChild(opt);
  }

  // Slug/ID characters are filtered live as the user types — not just on
  // submit — mirroring the server's authoritative pattern
  // (SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/ in
  // src/routes/redirects.ts): strip anything outside [a-z0-9-] and force
  // lowercase, since that pattern is lowercase-only. This is a UX nicety
  // only — the server remains the authoritative validator (it also checks
  // the start/end-character and length rules this simpler live filter
  // doesn't bother enforcing character-by-character).
  const SLUG_UNSAFE_CHARS = /[^a-z0-9-]/g;

  els.newSlug.addEventListener('input', () => {
    const cursorPos = els.newSlug.selectionStart;
    const before = els.newSlug.value;
    const filtered = before.toLowerCase().replace(SLUG_UNSAFE_CHARS, '');
    if (filtered !== before) {
      els.newSlug.value = filtered;
      // We only ever remove characters here, never insert, so clamping the
      // original numeric offset to the new (shorter-or-equal) length keeps
      // the cursor in a sane spot without needing a full diff.
      const pos = Math.min(cursorPos ?? filtered.length, filtered.length);
      els.newSlug.setSelectionRange(pos, pos);
    }
  });

  els.newRedirectToggle.addEventListener('click', () => {
    els.createForm.hidden = !els.createForm.hidden;
    if (!els.createForm.hidden) els.newDisplayName.focus();
  });

  els.newRedirectCancel.addEventListener('click', () => {
    els.createForm.reset();
    els.createForm.hidden = true;
    els.createStatus.textContent = '';
  });

  els.createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const slug = els.newSlug.value.trim();
      const targetUrl = els.newTargetUrl.value.trim();
      const displayName = els.newDisplayName.value.trim();
      try {
        const { cloudflare } = await createRedirect(slug, targetUrl, displayName || undefined);
        els.createStatus.textContent = cloudflare.ok
          ? `Created '${slug}' (Cloudflare synced).`
          : `Created '${slug}' locally — Cloudflare sync failed: ${cloudflare.error ?? 'unknown error'} ` +
            '(expected until the Bulk Redirects list exists).';
        els.createForm.reset();
        els.createForm.hidden = true;
        await refreshRedirects();
      } catch (err) {
        els.createStatus.textContent = `Failed to create redirect: ${(err as Error).message}`;
      }
    })();
  });

  // ---- QR Studio back navigation ----

  els.qrBackBtn.addEventListener('click', () => {
    if (qrStudioOrigin) {
      openDetail(qrStudioOrigin);
    } else {
      navigateTo('list');
    }
  });

  // ---- Preset buttons ----

  const presetButtons = document.querySelectorAll<HTMLButtonElement>('.preset-btn');

  /** Reflects `lastAppliedPreset` onto every preset button's visual + a11y selected-state. */
  function syncPresetSelectedState(): void {
    presetButtons.forEach((btn) => {
      const isSelected = lastAppliedPreset !== null && btn.dataset.preset === lastAppliedPreset;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
  }
  syncPresetSelectedState();

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      if (!key || !(key in PRESETS)) return;
      options = { ...options, ...structuredClone(PRESETS[key]) } as AppQrOptions;
      lastAppliedPreset = key;
      syncPresetSelectedState();
      syncControlsFromOptions();
      scheduleRender();
    });
  });

  // ---- Control wiring ----

  els.dotStyle.addEventListener('change', () => {
    options.dotsOptions.type = els.dotStyle.value as AppQrOptions['dotsOptions']['type'];
    // Mirror the chosen style onto the stepped Radius dropdown so it never
    // shows a stale value (display-only — doesn't affect the render).
    els.dotRadiusStep.value = STYLE_TO_RADIUS_STEP[options.dotsOptions.type];
    scheduleRender();
  });
  els.dotRadiusStep.addEventListener('change', () => {
    const step = els.dotRadiusStep.value as DotRadiusStep;
    options.dotsOptions.type = step;
    els.dotStyle.value = step;
    scheduleRender();
  });
  els.cornerSquareStyle.addEventListener('change', () => {
    options.cornersSquareOptions.type = els.cornerSquareStyle.value as AppQrOptions['cornersSquareOptions']['type'];
    scheduleRender();
  });
  els.cornerDotStyle.addEventListener('change', () => {
    options.cornersDotOptions.type = els.cornerDotStyle.value as AppQrOptions['cornersDotOptions']['type'];
    scheduleRender();
  });
  els.bgEnabled.addEventListener('change', () => {
    options.backgroundOptions.enabled = els.bgEnabled.checked;
    scheduleRender();
  });
  els.margin.addEventListener('input', () => {
    options.margin = Number(els.margin.value);
    els.marginValue.textContent = els.margin.value;
    scheduleRender();
  });
  els.overallRadius.addEventListener('input', () => {
    options.appExtensions.overallRadiusPx = Number(els.overallRadius.value);
    els.overallRadiusValue.textContent = els.overallRadius.value;
    scheduleRender();
  });
  els.borderEnabled.addEventListener('change', () => {
    options.appExtensions.border.enabled = els.borderEnabled.checked;
    scheduleRender();
  });
  els.borderThickness.addEventListener('input', () => {
    options.appExtensions.border.thicknessPx = Number(els.borderThickness.value);
    els.borderThicknessValue.textContent = els.borderThickness.value;
    scheduleRender();
  });
  els.borderRadius.addEventListener('input', () => {
    options.appExtensions.border.radiusPx = Number(els.borderRadius.value);
    els.borderRadiusValue.textContent = els.borderRadius.value;
    scheduleRender();
  });
  els.iconSize.addEventListener('input', () => {
    options.imageOptions.imageSizeRatio = Number(els.iconSize.value) / 100;
    els.iconSizeValue.textContent = els.iconSize.value;
    scheduleRender();
  });
  els.eccLevel.addEventListener('change', () => {
    options.qrOptions.userOverrodeErrorCorrection = true;
    options.qrOptions.errorCorrectionLevel = els.eccLevel.value as AppQrOptions['qrOptions']['errorCorrectionLevel'];
    scheduleRender();
  });

  els.iconFile.addEventListener('change', () => {
    void (async () => {
      const file = els.iconFile.files?.[0];
      if (!file) return;
      els.iconStatus.textContent = 'Loading icon…';
      try {
        options.image = await loadIconAsDataUrl(file);
        options.qrOptions.errorCorrectionLevel = resolveErrorCorrectionLevel(
          true,
          options.qrOptions.errorCorrectionLevel,
          options.qrOptions.userOverrodeErrorCorrection,
        );
        syncControlsFromOptions();
        scheduleRender();
        els.iconStatus.textContent = `Loaded '${file.name}'.`;
      } catch (err) {
        els.iconStatus.textContent = `Icon failed: ${(err as Error).message}`;
      }
    })();
  });

  els.iconRemove.addEventListener('click', () => {
    options.image = undefined;
    els.iconFile.value = '';
    els.iconStatus.textContent = '';
    // qr-code-styling's `.update()` merges options, so a render that simply
    // omits the `image` key leaves the previously-loaded icon in place — it
    // persisted in the live canvas AND in every export until a full reload.
    // Dropping the instance forces the next render to rebuild it from scratch
    // with no image, so removal is reflected everywhere immediately.
    qr = undefined;
    scheduleRender();
  });

  // ---- Test scan ----

  els.testScanBtn.addEventListener('click', () => {
    try {
      const result = decodeAndVerify(els.preview, options.data);
      els.testScanResult.textContent = result.pass
        ? `✓ Scan OK — decoded "${result.decoded}"`
        : `✗ Scan FAILED — decoded "${result.decoded ?? '(nothing detected)'}", expected "${result.expected}"`;
      els.testScanResult.style.color = result.pass ? '' : 'var(--warn)';
    } catch (err) {
      els.testScanResult.textContent = `Test scan error: ${(err as Error).message}`;
    }
  });

  // ---- Export ----

  els.exportBtn.addEventListener('click', () => {
    try {
      const format = els.exportFormat.value === 'jpeg' ? 'jpeg' : 'png';
      const { dataUrl, flattened } = exportCanvas(els.preview, {
        format,
        backgroundEnabled: options.backgroundOptions.enabled,
        backgroundColor: options.backgroundOptions.color,
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${selectedSlug ?? 'cuearcode'}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      a.click();
      els.exportStatus.textContent = flattened
        ? 'Exported — JPG has no transparency, so "no background" was flattened to white.'
        : 'Exported.';
    } catch (err) {
      els.exportStatus.textContent = `Export failed: ${(err as Error).message}`;
    }
  });

  // ---- Save / history ----

  async function refreshHistory(): Promise<void> {
    els.styleHistory.innerHTML = '';
    if (!selectedSlug) return;
    const versions = await listStyleVersions(selectedSlug);
    renderHistory(versions);
  }

  function renderHistory(versions: StyleVersionDto[]): void {
    els.styleHistory.innerHTML = '';
    for (const v of versions) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>v${v.version}</strong> — ${new Date(v.created_at).toLocaleString()}`;
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.textContent = 'Restore into controls';
      restoreBtn.addEventListener('click', () => {
        options = { ...options, ...(v.style as Partial<AppQrOptions>) } as AppQrOptions;
        syncControlsFromOptions();
        scheduleRender();
      });
      actions.appendChild(restoreBtn);
      li.appendChild(actions);
      els.styleHistory.appendChild(li);
    }
  }

  els.saveStyleBtn.addEventListener('click', () => {
    void (async () => {
      if (!selectedSlug) {
        els.saveStyleStatus.textContent = 'Select or create a redirect slug first — history is saved per slug.';
        return;
      }
      try {
        const saved = await saveStyleVersion(selectedSlug, options);
        els.saveStyleStatus.textContent = `Saved as v${saved.version}.`;
        await refreshHistory();
      } catch (err) {
        els.saveStyleStatus.textContent = `Save failed: ${(err as Error).message}`;
      }
    })();
  });

  // ---- Boot ----

  initTheme();
  initSlugDomainOptions();
  syncControlsFromOptions();
  scheduleRender();

  // Show the correct view section immediately, synchronously, purely from
  // the URL — before any data has loaded. This is what prevents a flash of
  // the List view when deep-linking straight into /redirects/:slug (or its
  // /qr variant): the right section is visible right away, just not yet
  // populated (detail/QR-studio content needs `redirects`, fetched below).
  showView(matchRoute(location.pathname).view);

  void (async () => {
    await refreshRedirects();
    // Now that `redirects` has data, resolve (and populate) whatever view
    // the URL actually points to — reusing the same path-matching +
    // navigateTo plumbing the popstate handler uses. `fromPopstate: true`
    // here means "the URL is already correct, just render it" — including
    // the bad-slug case, which falls back to the list view without crashing.
    await resolveRoute({ fromPopstate: true });
  })();
}
