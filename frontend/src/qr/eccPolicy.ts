// Auto-bump error correction to 'H' when a center icon is set, unless the
// user has explicitly overridden the level themselves.
import type { ErrorCorrectionLevel } from './types.js';

export function resolveErrorCorrectionLevel(
  hasImage: boolean,
  currentLevel: ErrorCorrectionLevel,
  userOverrode: boolean,
): ErrorCorrectionLevel {
  if (hasImage && !userOverrode) return 'H';
  return currentLevel;
}
