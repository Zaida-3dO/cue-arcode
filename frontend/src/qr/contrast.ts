// WCAG-style relative-luminance contrast ratio, plain JS — no library.
// https://www.w3.org/TR/WCAG21/#contrast-minimum (the formula, not the
// pass/fail thresholds; this is a QR-scannability heuristic, not an
// accessibility audit).

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs! + 0.7152 * gs! + 0.0722 * bs!;
}

/** Ratio is >= 1 (identical colors) up to 21 (black vs white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Below ~3:1 a QR scanner starts to struggle distinguishing dots from background. */
export const LOW_CONTRAST_THRESHOLD = 3;

export function isLowContrast(ratio: number): boolean {
  return ratio < LOW_CONTRAST_THRESHOLD;
}
