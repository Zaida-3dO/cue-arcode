import { describe, it, expect } from 'vitest';
import { requiresFlatten, resolveExportBackgroundColor } from '../frontend/src/qr/exportFlatten.js';

describe('requiresFlatten', () => {
  it('is true for JPG with background disabled (JPG has no alpha channel)', () => {
    expect(requiresFlatten('jpeg', false)).toBe(true);
  });

  it('is false for JPG with background enabled', () => {
    expect(requiresFlatten('jpeg', true)).toBe(false);
  });

  it('is false for PNG regardless of background toggle (PNG supports alpha)', () => {
    expect(requiresFlatten('png', false)).toBe(false);
    expect(requiresFlatten('png', true)).toBe(false);
  });
});

describe('resolveExportBackgroundColor', () => {
  it('flattens JPG + no-background to white', () => {
    expect(resolveExportBackgroundColor('jpeg', false, '#123456')).toBe('#ffffff');
  });

  it('stays transparent for PNG + no-background', () => {
    expect(resolveExportBackgroundColor('png', false, '#123456')).toBe('transparent');
  });

  it('uses the chosen color whenever background is enabled', () => {
    expect(resolveExportBackgroundColor('png', true, '#123456')).toBe('#123456');
    expect(resolveExportBackgroundColor('jpeg', true, '#123456')).toBe('#123456');
  });
});
