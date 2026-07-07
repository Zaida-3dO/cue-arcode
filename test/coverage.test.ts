import { describe, it, expect } from 'vitest';
import { shouldWarnLogoCoverage, LOGO_COVERAGE_WARNING_THRESHOLD } from '../frontend/src/qr/coverage.js';

describe('shouldWarnLogoCoverage', () => {
  it('warns above the threshold without H error correction', () => {
    expect(shouldWarnLogoCoverage(LOGO_COVERAGE_WARNING_THRESHOLD + 0.1, true, 'M')).toBe(true);
  });

  it('does not warn once error correction is H', () => {
    expect(shouldWarnLogoCoverage(0.5, true, 'H')).toBe(false);
  });

  it('does not warn below the threshold', () => {
    expect(shouldWarnLogoCoverage(LOGO_COVERAGE_WARNING_THRESHOLD - 0.1, true, 'M')).toBe(false);
  });

  it('does not warn when there is no image at all', () => {
    expect(shouldWarnLogoCoverage(0.9, false, 'L')).toBe(false);
  });
});
