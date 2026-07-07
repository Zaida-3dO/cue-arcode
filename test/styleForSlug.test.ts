import { describe, it, expect } from 'vitest';
import { resolveOptionsForTarget } from '../frontend/src/qr/styleForSlug.js';
import { defaultOptions, type AppQrOptions } from '../frontend/src/qr/types.js';
import type { StyleVersionDto } from '../frontend/src/api.js';

describe('resolveOptionsForTarget', () => {
  it('returns clean defaults for the target data when there are no saved versions', () => {
    const result = resolveOptionsForTarget('https://example.com/r/foo', []);
    expect(result).toEqual(defaultOptions('https://example.com/r/foo'));
  });

  it('merges the latest saved version style over defaults, forcing data to targetData', () => {
    const staleStyle: Partial<AppQrOptions> = {
      data: 'https://example.com/r/OLD-AND-WRONG',
      dotsOptions: { type: 'dots', color: '#ff00ff' },
      margin: 20,
    };
    const versions: StyleVersionDto[] = [
      { version: 1, style: { dotsOptions: { type: 'square', color: '#111111' } }, created_at: '2026-01-01T00:00:00Z' },
      { version: 2, style: staleStyle, created_at: '2026-01-02T00:00:00Z' },
    ];

    const result = resolveOptionsForTarget('https://example.com/r/foo', versions);

    // Latest (v2) style applied, not v1.
    expect(result.dotsOptions).toEqual({ type: 'dots', color: '#ff00ff' });
    expect(result.margin).toBe(20);
    // data is always forced to targetData, even though the stored style
    // carried a different (stale) data value.
    expect(result.data).toBe('https://example.com/r/foo');
    // Fields not present in the saved style fall back to fresh defaults,
    // not whatever a previous session's `options` happened to hold.
    expect(result.backgroundOptions).toEqual(defaultOptions('https://example.com/r/foo').backgroundOptions);
  });

  it('picks the highest-versioned entry regardless of array order', () => {
    const versions: StyleVersionDto[] = [
      { version: 3, style: { margin: 42 }, created_at: '2026-01-03T00:00:00Z' },
      { version: 1, style: { margin: 1 }, created_at: '2026-01-01T00:00:00Z' },
      { version: 2, style: { margin: 2 }, created_at: '2026-01-02T00:00:00Z' },
    ];

    const result = resolveOptionsForTarget('https://example.com/r/bar', versions);
    expect(result.margin).toBe(42);
  });
});
