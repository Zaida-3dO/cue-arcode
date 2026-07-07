// Programmatic decode-verify: render the currently-styled QR to an offscreen
// canvas, run jsQR against it, and assert the decoded string equals the
// expected redirect URL. Pure browser-canvas, no server round-trip.
import jsQR from 'jsqr';

export interface TestScanResult {
  pass: boolean;
  decoded: string | null;
  expected: string;
}

export function decodeAndVerify(canvas: HTMLCanvasElement, expectedUrl: string): TestScanResult {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(imageData.data, imageData.width, imageData.height);
  const decoded = result?.data ?? null;
  return { pass: decoded === expectedUrl, decoded, expected: expectedUrl };
}
