import { describe, it, expect } from 'vitest';
import { resolveErrorCorrectionLevel } from '../frontend/src/qr/eccPolicy.js';

describe('resolveErrorCorrectionLevel', () => {
  it('auto-bumps to H when an icon is set and the user has not overridden', () => {
    expect(resolveErrorCorrectionLevel(true, 'M', false)).toBe('H');
  });

  it('respects an explicit user override even with an icon set', () => {
    expect(resolveErrorCorrectionLevel(true, 'M', true)).toBe('M');
  });

  it('leaves the level untouched with no icon', () => {
    expect(resolveErrorCorrectionLevel(false, 'M', false)).toBe('M');
  });
});
