// App-level canvas compositing — the pieces qr-code-styling doesn't give for
// free: an overall-QR corner radius, an independent image border (its own
// thickness + radius), and export with the JPG-no-alpha flatten rule.
// Everything here operates on plain <canvas> elements so it composes
// cleanly regardless of how the QR itself was rendered.
import type QRCodeStyling from 'qr-code-styling';
import type { ExportFormat } from './types.js';
import { requiresFlatten, resolveExportBackgroundColor } from './exportFlatten.js';

// EXTENSION POINT (fast-follow, not v1): a true continuous dot-radius slider
// would replace the stepped square/rounded/extra-rounded preset in
// qr/types.ts by registering a custom dot renderer via qr-code-styling's
// `applyExtension(svg, options)` hook (or a custom `dotsOptions.type`
// function once the library exposes one) and driving its numeric corner
// radius directly from the slider value. Not built now — see build report.

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load the rendered QR image'));
    img.src = src;
  });
}

/**
 * Extracts the current render as a fresh, independent canvas we own (safe to
 * mutate/composite). Uses qr-code-styling's own `getRawData()` — its
 * `async`/`await`-based public API — rather than reaching into its internal
 * DOM canvas: grabbing the internal canvas synchronously right after
 * `update()` is a known race (the library's own draw can still be in
 * flight), which `getRawData()` correctly waits out before resolving.
 */
export async function getRawDataAsCanvas(
  qr: QRCodeStyling,
  fallbackWidth: number,
  fallbackHeight: number,
): Promise<HTMLCanvasElement> {
  const blob = await qr.getRawData('png');
  if (!blob || !(blob instanceof Blob)) {
    throw new Error('qr-code-styling did not return image data (empty QR data?)');
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || fallbackWidth;
    canvas.height = img.naturalHeight || fallbackHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Rounds the corners of the whole QR image — not natively supported by qr-code-styling. */
export function applyOverallRadius(source: HTMLCanvasElement, radiusPx: number): HTMLCanvasElement {
  if (radiusPx <= 0) return source;
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.save();
  drawRoundedRectPath(ctx, 0, 0, out.width, out.height, radiusPx);
  ctx.clip();
  ctx.drawImage(source, 0, 0);
  ctx.restore();
  return out;
}

export interface BorderOptions {
  enabled: boolean;
  thicknessPx: number;
  radiusPx: number;
  color: string;
}

/**
 * Frames the (possibly already radius-clipped) QR image with its own
 * border — an independent on/off + thickness + radius, distinct from
 * applyOverallRadius above (that one rounds the QR grid; this one frames
 * the finished image, including any transparency from the radius clip).
 *
 * `overallRadiusPx` and `border.radiusPx` are two independent user-controlled
 * sliders (overall QR corner radius vs. border radius) — they are NOT
 * guaranteed to be equal. The outer frame legitimately uses `border.radiusPx`
 * (a frame can be rounded differently from the image it surrounds), but the
 * hole punched into the middle of that frame must match `source`'s actual
 * corner shape exactly, or the two curves won't nest and a transparent
 * notch/gap appears at each corner. So the caller passes `sourceRadiusPx` —
 * the radius that was ACTUALLY baked into `source`'s corners by the
 * preceding `applyOverallRadius()` call (or `0` if that step was skipped/a
 * no-op) — and the inner hole is cut with THAT value, never `border.radiusPx`.
 */
export function applyImageBorder(
  source: HTMLCanvasElement,
  border: BorderOptions,
  sourceRadiusPx: number,
): HTMLCanvasElement {
  if (!border.enabled || border.thicknessPx <= 0) return source;
  const outW = source.width + border.thicknessPx * 2;
  const outH = source.height + border.thicknessPx * 2;
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Fill a rounded-rect "frame" the size of the final image, then punch the
  // interior back out to full transparency before compositing the QR on top.
  // Without the clear step, drawing a QR whose background is disabled (and so
  // has a transparent quiet-zone/interior) straight over the fill leaves the
  // border color showing through every transparent pixel — an opaque interior
  // instead of true transparency. Clearing first guarantees the QR's own alpha
  // is what survives, so only the `thicknessPx` ring around the perimeter is
  // colored. When the background IS enabled the QR is opaque there anyway, so
  // this is a no-op for that case.
  //
  // The interior hole is cut with `sourceRadiusPx` — the radius actually
  // baked into `source`'s corners (inset by thicknessPx on every side) —
  // rather than `border.radiusPx` and rather than a hard rectangle. A
  // rectangular hole, or one cut with a radius that doesn't match `source`'s
  // real curve, don't nest cleanly, leaving a transparent gap/notch right at
  // each corner (visible as a checkerboard "wedge" cut into the frame).
  // Using a rounded hole with the matching radius, drawn with
  // `destination-out` (clearRect can only cut rectangles), keeps the two
  // curves concentric so they meet flush — independent of whatever
  // `border.radiusPx` the outer frame itself is drawn with.
  drawRoundedRectPath(ctx, 0, 0, outW, outH, border.radiusPx);
  ctx.fillStyle = border.color;
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  drawRoundedRectPath(ctx, border.thicknessPx, border.thicknessPx, source.width, source.height, sourceRadiusPx);
  ctx.fill();
  ctx.restore();
  ctx.drawImage(source, border.thicknessPx, border.thicknessPx);
  return out;
}

export interface ExportOptions {
  format: ExportFormat;
  backgroundEnabled: boolean;
  backgroundColor: string;
}

/**
 * Exports a canvas to a data URL, applying the JPG-no-alpha flatten rule:
 * JPG can't be transparent, so "no background" + JPG silently flattens to
 * white instead of producing a broken/black image. Also needed for PNG with
 * a solid background chosen, since applyOverallRadius can leave transparent
 * corner pixels even when a background color was set.
 */
export function exportCanvas(source: HTMLCanvasElement, opts: ExportOptions): { dataUrl: string; flattened: boolean } {
  const flattened = requiresFlatten(opts.format, opts.backgroundEnabled);
  const bg = resolveExportBackgroundColor(opts.format, opts.backgroundEnabled, opts.backgroundColor);
  const mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';

  if (bg === 'transparent') {
    return { dataUrl: source.toDataURL(mime), flattened };
  }

  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  return { dataUrl: out.toDataURL(mime), flattened };
}
