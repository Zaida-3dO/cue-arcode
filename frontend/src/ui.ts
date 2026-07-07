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
  deleteAllStyleHistory,
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

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
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

// Placeholder `data` used for the "(ad-hoc — not tied to a slug)" mode —
// both on initial boot and whenever the active-slug dropdown is switched
// back to ad-hoc.
const ADHOC_PLACEHOLDER_DATA = `${REDIRECT_BASE_URL}/example`;

export function initUi(): void {
  let options: AppQrOptions = defaultOptions(ADHOC_PLACEHOLDER_DATA);
  let redirects: RedirectDto[] = [];
  let selectedSlug: string | null = null;
  let qr: QRCodeStyling | undefined;

  // Detail view is currently showing this slug (or null when not on that view).
  let detailSlug: string | null = null;
  // Which detail-view slug QR Studio was opened *from*, so its back button
  // returns there rather than jumping all the way to the top-level list.
  let qrStudioOrigin: string | null = null;
  let currentView: View = 'list';

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
    detailRedirectUrl: byId<HTMLElement>('detail-redirect-url'),
    detailGenerateQrBtn: byId<HTMLButtonElement>('detail-generate-qr-btn'),
    detailDeleteBtn: byId<HTMLButtonElement>('detail-delete-btn'),

    // QR Studio view
    qrBackBtn: byId<HTMLButtonElement>('qr-back-btn'),
    activeSlug: byId<HTMLSelectElement>('active-slug'),
    qrData: byId<HTMLInputElement>('qr-data'),

    dotStyle: byId<HTMLSelectElement>('dot-style'),
    dotRadiusStep: byId<HTMLSelectElement>('dot-radius-step'),
    dotColor: byId<HTMLInputElement>('dot-color'),
    cornerSquareStyle: byId<HTMLSelectElement>('corner-square-style'),
    cornerSquareColor: byId<HTMLInputElement>('corner-square-color'),
    cornerDotStyle: byId<HTMLSelectElement>('corner-dot-style'),
    cornerDotColor: byId<HTMLInputElement>('corner-dot-color'),

    bgEnabled: byId<HTMLInputElement>('bg-enabled'),
    bgColor: byId<HTMLInputElement>('bg-color'),

    margin: byId<HTMLInputElement>('margin'),
    marginValue: byId<HTMLSpanElement>('margin-value'),
    overallRadius: byId<HTMLInputElement>('overall-radius'),
    overallRadiusValue: byId<HTMLSpanElement>('overall-radius-value'),

    borderEnabled: byId<HTMLInputElement>('border-enabled'),
    borderThickness: byId<HTMLInputElement>('border-thickness'),
    borderThicknessValue: byId<HTMLSpanElement>('border-thickness-value'),
    borderRadius: byId<HTMLInputElement>('border-radius'),
    borderRadiusValue: byId<HTMLSpanElement>('border-radius-value'),
    borderColor: byId<HTMLInputElement>('border-color'),

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
    wipeHistoryBtn: byId<HTMLButtonElement>('wipe-history-btn'),
    wipeHistoryStatus: byId<HTMLParagraphElement>('wipe-history-status'),
  };

  // ---- View navigation ----

  function showView(view: View): void {
    currentView = view;
    els.viewList.hidden = view !== 'list';
    els.viewDetail.hidden = view !== 'detail';
    els.viewQrStudio.hidden = view !== 'qr-studio';
    els.viewSettings.hidden = view !== 'settings';
    // "Redirects" stays highlighted for detail/QR-studio too — they're both
    // reached from within the redirects flow, not independent top-level areas.
    els.navRedirects.classList.toggle('active', view === 'list' || view === 'detail' || view === 'qr-studio');
    els.navSettings.classList.toggle('active', view === 'settings');
  }

  els.navRedirects.addEventListener('click', (e) => {
    e.preventDefault();
    showView('list');
  });
  els.navSettings.addEventListener('click', (e) => {
    e.preventDefault();
    showView('settings');
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
    els.qrData.value = options.data;
    els.dotStyle.value = options.dotsOptions.type;
    els.dotColor.value = options.dotsOptions.color;
    els.cornerSquareStyle.value = options.cornersSquareOptions.type;
    els.cornerSquareColor.value = options.cornersSquareOptions.color;
    els.cornerDotStyle.value = options.cornersDotOptions.type;
    els.cornerDotColor.value = options.cornersDotOptions.color;
    els.bgEnabled.checked = options.backgroundOptions.enabled;
    els.bgColor.value = options.backgroundOptions.color;
    els.margin.value = String(options.margin);
    els.marginValue.textContent = String(options.margin);
    els.overallRadius.value = String(options.appExtensions.overallRadiusPx);
    els.overallRadiusValue.textContent = String(options.appExtensions.overallRadiusPx);
    els.borderEnabled.checked = options.appExtensions.border.enabled;
    els.borderThickness.value = String(options.appExtensions.border.thicknessPx);
    els.borderThicknessValue.textContent = String(options.appExtensions.border.thicknessPx);
    els.borderRadius.value = String(options.appExtensions.border.radiusPx);
    els.borderRadiusValue.textContent = String(options.appExtensions.border.radiusPx);
    els.borderColor.value = options.appExtensions.border.color;
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
      canvas = applyImageBorder(canvas, options.appExtensions.border);

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

      // Everything below is built via createElement + textContent, never
      // innerHTML interpolation: display_name and target_url are both
      // attacker-influenced (a redirect's label and target), so
      // string-templating either into innerHTML would be a stored-XSS sink.
      // textContent escapes everything — same discipline for both fields.
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
      const shortValue = document.createElement('code');
      shortValue.className = 'card-value';
      shortValue.textContent = r.redirect_url;
      shortRow.append(shortLabel, shortValue);
      body.appendChild(shortRow);

      const targetRow = document.createElement('div');
      targetRow.className = 'card-row';
      const targetLabel = document.createElement('span');
      targetLabel.className = 'card-label';
      targetLabel.textContent = 'Points to';
      const targetValue = document.createElement('code');
      targetValue.className = 'card-value card-value-wrap';
      targetValue.textContent = r.target_url;
      targetRow.append(targetLabel, targetValue);
      body.appendChild(targetRow);

      const openThisDetail = () => openDetail(r.slug);
      body.addEventListener('click', openThisDetail);
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThisDetail();
        }
      });

      const actions = document.createElement('div');
      actions.className = 'row-actions';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void removeRedirect(r.slug);
      });
      actions.appendChild(delBtn);

      li.append(body, actions);
      els.redirectList.appendChild(li);
    }
  }

  function renderActiveSlugOptions(): void {
    els.activeSlug.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(ad-hoc — not tied to a slug)';
    els.activeSlug.appendChild(noneOpt);

    for (const r of redirects) {
      const opt = document.createElement('option');
      opt.value = r.slug;
      opt.textContent = r.slug;
      els.activeSlug.appendChild(opt);
    }
    els.activeSlug.value = selectedSlug ?? '';
  }

  async function refreshRedirects(): Promise<void> {
    redirects = await listRedirects();
    renderRedirectList();
    renderActiveSlugOptions();
  }

  // ---- Detail view ----

  function openDetail(slug: string): void {
    const row = redirects.find((r) => r.slug === slug);
    if (!row) return;
    detailSlug = slug;
    els.detailDisplayName.textContent = row.display_name;
    els.detailSlug.textContent = row.slug;
    els.detailDisplayNameInput.value = row.display_name;
    els.detailTargetUrlInput.value = row.target_url;
    els.detailRedirectUrl.textContent = row.redirect_url;
    els.detailSaveStatus.textContent = '';
    showView('detail');
  }

  els.detailBackBtn.addEventListener('click', () => {
    showView('list');
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
      showView('qr-studio');
    })();
  });

  els.detailDeleteBtn.addEventListener('click', () => {
    if (!detailSlug) return;
    const slug = detailSlug;
    void (async () => {
      const deleted = await removeRedirect(slug);
      if (deleted) showView('list');
    })();
  });

  async function selectSlug(slug: string): Promise<void> {
    selectedSlug = slug;
    els.activeSlug.value = slug;

    const row = redirects.find((r) => r.slug === slug);
    const targetData = row ? row.redirect_url : options.data;
    // Always rebuild from a clean base for the new target — never carry
    // forward whatever the previously-active slug (or ad-hoc session) left
    // in `options`. If the slug has saved style history, its latest version
    // is merged on top of that clean base; otherwise it's plain defaults.
    const versions = await listStyleVersions(slug);
    options = resolveOptionsForTarget(targetData, versions);
    syncControlsFromOptions();
    scheduleRender();
    renderHistory(versions);
  }

  /** Switches QR Studio to ad-hoc mode (no slug), resetting `options` to a clean base. */
  async function selectAdHoc(): Promise<void> {
    selectedSlug = null;
    els.activeSlug.value = '';
    options = resolveOptionsForTarget(ADHOC_PLACEHOLDER_DATA, []);
    syncControlsFromOptions();
    scheduleRender();
    await refreshHistory();
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

  els.newRedirectToggle.addEventListener('click', () => {
    els.createForm.hidden = !els.createForm.hidden;
    if (!els.createForm.hidden) els.newSlug.focus();
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

  els.activeSlug.addEventListener('change', () => {
    if (els.activeSlug.value) {
      void selectSlug(els.activeSlug.value);
    } else {
      void selectAdHoc();
    }
  });

  // ---- QR Studio back navigation ----

  els.qrBackBtn.addEventListener('click', () => {
    if (qrStudioOrigin) {
      openDetail(qrStudioOrigin);
    } else {
      showView('list');
    }
  });

  // ---- Preset buttons ----

  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      if (!key || !(key in PRESETS)) return;
      options = { ...options, ...structuredClone(PRESETS[key]) } as AppQrOptions;
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
  els.dotColor.addEventListener('input', () => {
    options.dotsOptions.color = els.dotColor.value;
    scheduleRender();
  });
  els.cornerSquareStyle.addEventListener('change', () => {
    options.cornersSquareOptions.type = els.cornerSquareStyle.value as AppQrOptions['cornersSquareOptions']['type'];
    scheduleRender();
  });
  els.cornerSquareColor.addEventListener('input', () => {
    options.cornersSquareOptions.color = els.cornerSquareColor.value;
    scheduleRender();
  });
  els.cornerDotStyle.addEventListener('change', () => {
    options.cornersDotOptions.type = els.cornerDotStyle.value as AppQrOptions['cornersDotOptions']['type'];
    scheduleRender();
  });
  els.cornerDotColor.addEventListener('input', () => {
    options.cornersDotOptions.color = els.cornerDotColor.value;
    scheduleRender();
  });
  els.bgEnabled.addEventListener('change', () => {
    options.backgroundOptions.enabled = els.bgEnabled.checked;
    scheduleRender();
  });
  els.bgColor.addEventListener('input', () => {
    options.backgroundOptions.color = els.bgColor.value;
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
  els.borderColor.addEventListener('input', () => {
    options.appExtensions.border.color = els.borderColor.value;
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

  // ---- Settings: wipe style history ----

  els.wipeHistoryBtn.addEventListener('click', () => {
    const confirmed = window.confirm(
      'This permanently deletes ALL saved QR style history for every redirect. This cannot be undone.',
    );
    if (!confirmed) return;
    void (async () => {
      try {
        const { deleted } = await deleteAllStyleHistory();
        els.wipeHistoryStatus.textContent = `Wiped ${deleted} saved style version${deleted === 1 ? '' : 's'}.`;
        if (selectedSlug) await refreshHistory();
      } catch (err) {
        els.wipeHistoryStatus.textContent = `Failed to wipe history: ${(err as Error).message}`;
      }
    })();
  });

  // ---- Boot ----

  initTheme();
  syncControlsFromOptions();
  scheduleRender();
  showView(currentView);
  void refreshRedirects();
}
