// JPG has no alpha channel. If the user has "no background" selected and
// picks JPG export, silently producing a transparent-turned-black image
// would be a broken/surprising result — flatten to a solid background
// (white by default) instead, and make the UI say so rather than staying
// silent about it.
import type { ExportFormat } from './types.js';

export function requiresFlatten(format: ExportFormat, backgroundEnabled: boolean): boolean {
  return format === 'jpeg' && !backgroundEnabled;
}

/** The background color to actually render behind the QR for this export. */
export function resolveExportBackgroundColor(
  format: ExportFormat,
  backgroundEnabled: boolean,
  chosenColor: string,
): string {
  if (backgroundEnabled) return chosenColor;
  if (format === 'jpeg') return '#ffffff'; // flatten fallback — JPG can't be transparent
  return 'transparent';
}
