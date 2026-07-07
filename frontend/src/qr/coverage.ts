// Logo-coverage guardrail: a large center icon can eat enough of the QR's
// error-correction budget to make it unscannable unless ECC is at 'H'.
import type { ErrorCorrectionLevel } from './types.js';

export const LOGO_COVERAGE_WARNING_THRESHOLD = 0.3;

export function shouldWarnLogoCoverage(
  imageSizeRatio: number,
  hasImage: boolean,
  errorCorrectionLevel: ErrorCorrectionLevel,
): boolean {
  if (!hasImage) return false;
  return imageSizeRatio > LOGO_COVERAGE_WARNING_THRESHOLD && errorCorrectionLevel !== 'H';
}
