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
 * style exists, merges the latest version's style on top of that clean base
 * (mirroring the same shallow-merge pattern used by "Restore into
 * controls"). `data` is always forced back to `targetData` afterwards, even
 * if the stored style JSON carries a different (stale) `data` value.
 *
 * `savedVersions` does not need to be pre-sorted — the latest is taken as
 * the one with the highest `version` number.
 */
export function resolveOptionsForTarget(
  targetData: string,
  savedVersions: StyleVersionDto[],
): AppQrOptions {
  const base = defaultOptions(targetData);

  if (savedVersions.length === 0) {
    return base;
  }

  const latest = savedVersions.reduce((a, b) => (b.version > a.version ? b : a));

  const merged = { ...base, ...(latest.style as Partial<AppQrOptions>) } as AppQrOptions;
  merged.data = targetData;
  return merged;
}
