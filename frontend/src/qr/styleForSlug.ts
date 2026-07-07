// Pure logic for computing the QR Studio `options` object that should be
// loaded when the active target (a redirect slug, or ad-hoc) changes.
//
// Extracted out of ui.ts so the "don't leak the previous target's leftover
// styling onto the next one" behaviour can be unit-tested without any DOM or
// fetch dependencies. See ui.ts's selectSlug() for the caller.
import { defaultOptions, type AppQrOptions } from './types.js';
import type { StyleVersionDto } from '../api.js';

/**
 * Computes the options object for a QR target (a redirect's data, or an
 * ad-hoc placeholder) given that target's saved style versions.
 *
 * Always starts from a fresh `defaultOptions(targetData)` base — never from
 * whatever `options` happened to be set to previously — then, if a saved
 * style exists, merges a version's style on top of that clean base
 * (mirroring the same shallow-merge pattern used by "Restore into
 * controls"). `data` is always forced back to `targetData` afterwards, even
 * if the stored style JSON carries a different (stale) `data` value.
 *
 * By default the LATEST version is used (highest `version` number,
 * `savedVersions` does not need to be pre-sorted). Pass `preferredVersion`
 * to pick a specific older version instead — e.g. the Detail view's saved-QR
 * gallery lets the user jump straight into a specific past version rather
 * than always landing on the latest. If `preferredVersion` is given but no
 * matching version exists in `savedVersions`, this falls back to the
 * existing latest-version behavior.
 */
export function resolveOptionsForTarget(
  targetData: string,
  savedVersions: StyleVersionDto[],
  preferredVersion?: number,
): AppQrOptions {
  const base = defaultOptions(targetData);

  if (savedVersions.length === 0) {
    return base;
  }

  const preferredMatch =
    preferredVersion !== undefined ? savedVersions.find((v) => v.version === preferredVersion) : undefined;
  const chosen = preferredMatch ?? savedVersions.reduce((a, b) => (b.version > a.version ? b : a));

  const merged = { ...base, ...(chosen.style as Partial<AppQrOptions>) } as AppQrOptions;
  merged.data = targetData;
  return merged;
}
