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

export function initUi(): void {
  let options: AppQrOptions = defaultOptions(`${REDIRECT_BASE_URL}/example`);
  let redirects: RedirectDto[] = [];
  let selectedSlug: string | null = null;
  let qr: QRCodeStyling | undefined;

  const els = {
    createForm: byId<HTMLFormElement>('create-redirect-form'),
    newSlug: byId<HTMLInputElement>('new-slug'),
    newTargetUrl: byId<HTMLInputElement>('new-target-url'),
    createStatus: byId<HTMLParagraphElement>('create-redirect-status'),
    redirectList: byId<HTMLUListElement>('redirect-list'),

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
  };

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

  // ---- Redirect management ----

  function renderRedirectList(): void {
    els.redirectList.innerHTML = '';
    els.activeSlug.innerHTML = '';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(ad-hoc — not tied to a slug)';
    els.activeSlug.appendChild(noneOpt);

    for (const r of redirects) {
      const li = document.createElement('li');
      // Build via textContent, never innerHTML interpolation: r.target_url is
      // attacker-influenced (a redirect's target), so string-templating it into
      // innerHTML is a stored-XSS sink. textContent escapes everything.
      const info = document.createElement('div');
      const slugEl = document.createElement('strong');
      slugEl.textContent = r.slug;
      const targetEl = document.createElement('code');
      targetEl.textContent = r.target_url;
      const redirectEl = document.createElement('code');
      redirectEl.textContent = r.redirect_url;
      info.append(slugEl, document.createTextNode(' → '), targetEl, document.createElement('br'), redirectEl);
      li.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'row-actions';

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.textContent = 'Use for QR';
      useBtn.addEventListener('click', () => void selectSlug(r.slug));
      actions.appendChild(useBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit target';
      editBtn.addEventListener('click', () => void editRedirect(r.slug, r.target_url));
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => void removeRedirect(r.slug));
      actions.appendChild(delBtn);

      li.appendChild(actions);
      els.redirectList.appendChild(li);

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
  }

  async function selectSlug(slug: string): Promise<void> {
    selectedSlug = slug;
    const row = redirects.find((r) => r.slug === slug);
    if (row) {
      options.data = row.redirect_url;
    }
    renderRedirectList();
    syncControlsFromOptions();
    scheduleRender();
    await refreshHistory();
  }

  async function editRedirect(slug: string, currentTarget: string): Promise<void> {
    const next = window.prompt(`New target URL for '${slug}'`, currentTarget);
    if (!next || next === currentTarget) return;
    try {
      const { cloudflare } = await updateRedirect(slug, next);
      els.createStatus.textContent = cloudflare.ok
        ? `Updated '${slug}' (Cloudflare synced).`
        : `Updated '${slug}' locally — Cloudflare sync failed: ${cloudflare.error ?? 'unknown error'}`;
      await refreshRedirects();
    } catch (err) {
      els.createStatus.textContent = `Failed to update '${slug}': ${(err as Error).message}`;
    }
  }

  async function removeRedirect(slug: string): Promise<void> {
    if (!window.confirm(`Delete redirect '${slug}'?`)) return;
    try {
      const { cloudflare } = await deleteRedirect(slug);
      els.createStatus.textContent = cloudflare.ok
        ? `Deleted '${slug}' (Cloudflare synced).`
        : `Deleted '${slug}' locally — Cloudflare sync failed: ${cloudflare.error ?? 'unknown error'}`;
      if (selectedSlug === slug) selectedSlug = null;
      await refreshRedirects();
    } catch (err) {
      els.createStatus.textContent = `Failed to delete '${slug}': ${(err as Error).message}`;
    }
  }

  els.createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const slug = els.newSlug.value.trim();
      const targetUrl = els.newTargetUrl.value.trim();
      try {
        const { cloudflare } = await createRedirect(slug, targetUrl);
        els.createStatus.textContent = cloudflare.ok
          ? `Created '${slug}' (Cloudflare synced).`
          : `Created '${slug}' locally — Cloudflare sync failed: ${cloudflare.error ?? 'unknown error'} ` +
            '(expected until the Bulk Redirects list exists).';
        els.newSlug.value = '';
        els.newTargetUrl.value = '';
        await refreshRedirects();
        await selectSlug(slug);
      } catch (err) {
        els.createStatus.textContent = `Failed to create redirect: ${(err as Error).message}`;
      }
    })();
  });

  els.activeSlug.addEventListener('change', () => {
    if (els.activeSlug.value) void selectSlug(els.activeSlug.value);
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

  // ---- Boot ----

  syncControlsFromOptions();
  scheduleRender();
  void refreshRedirects();
}
