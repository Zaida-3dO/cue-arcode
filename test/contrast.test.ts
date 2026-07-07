import { describe, it, expect } from 'vitest';
import { contrastRatio, isLowContrast, LOW_CONTRAST_THRESHOLD } from '../frontend/src/qr/contrast.js';

describe('contrastRatio', () => {
  it('is 21:1 for pure black vs pure white (WCAG max)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('is 1:1 for identical colors', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('is symmetric regardless of argument order', () => {
    const a = contrastRatio('#111111', '#eeeeee');
    const b = contrastRatio('#eeeeee', '#111111');
    expect(a).toBeCloseTo(b, 10);
  });

  it('supports 3-digit hex shorthand', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 0);
  });
});

describe('isLowContrast', () => {
  it('flags ratios below the threshold', () => {
    expect(isLowContrast(LOW_CONTRAST_THRESHOLD - 0.1)).toBe(true);
  });

  it('does not flag ratios at or above the threshold', () => {
    expect(isLowContrast(LOW_CONTRAST_THRESHOLD)).toBe(false);
    expect(isLowContrast(LOW_CONTRAST_THRESHOLD + 1)).toBe(false);
  });
});
