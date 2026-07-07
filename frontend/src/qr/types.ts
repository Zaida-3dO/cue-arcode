// The single shared "options" object — the one source of truth for the QR
// studio. Presets are just buttons that populate this object; every
// individual control remains free to override any field afterwards, then
// the QR re-renders live on any change (see ui.ts).
export type DotType = 'square' | 'rounded' | 'dots' | 'classy' | 'classy-rounded' | 'extra-rounded';
/** The v1 stepped stand-in for a continuous dot-radius slider (see qr/wrapper.ts extension seam). */
export type DotRadiusStep = 'square' | 'rounded' | 'extra-rounded';
export type CornerSquareType = 'square' | 'dot' | 'extra-rounded';
export type CornerDotType = 'square' | 'dot';
export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';
export type ExportFormat = 'png' | 'jpeg';

export interface AppQrOptions {
  data: string;
  width: number;
  height: number;
  /** Quiet-zone whitespace inside the QR image (qr-code-styling's native `margin`). Doubles as the app's "Padding" control. */
  margin: number;

  dotsOptions: {
    type: DotType;
    color: string;
  };
  cornersSquareOptions: {
    type: CornerSquareType;
    color: string;
  };
  cornersDotOptions: {
    type: CornerDotType;
    color: string;
  };
  backgroundOptions: {
    enabled: boolean;
    color: string;
  };
  imageOptions: {
    imageSizeRatio: number; // 0..1, fraction of QR covered by the center icon
    hideBackgroundDots: boolean;
  };
  /** Data URL of the (already-rasterized, if it started as SVG) center icon, or undefined for none. */
  image: string | undefined;

  qrOptions: {
    errorCorrectionLevel: ErrorCorrectionLevel;
    /** True once the user has explicitly picked a level — gates the auto-bump-to-H-on-icon behaviour. */
    userOverrodeErrorCorrection: boolean;
  };

  /** App-level compositing the library doesn't do natively (see qr/wrapper.ts). */
  appExtensions: {
    overallRadiusPx: number;
    border: {
      enabled: boolean;
      thicknessPx: number;
      radiusPx: number;
      color: string;
    };
  };
}

export function defaultOptions(data: string): AppQrOptions {
  return {
    data,
    width: 320,
    height: 320,
    margin: 8,
    dotsOptions: { type: 'square', color: '#000000' },
    cornersSquareOptions: { type: 'square', color: '#000000' },
    cornersDotOptions: { type: 'square', color: '#000000' },
    backgroundOptions: { enabled: true, color: '#ffffff' },
    imageOptions: { imageSizeRatio: 0.4, hideBackgroundDots: true },
    image: undefined,
    qrOptions: { errorCorrectionLevel: 'M', userOverrodeErrorCorrection: false },
    appExtensions: {
      overallRadiusPx: 0,
      border: { enabled: false, thicknessPx: 4, radiusPx: 0, color: '#000000' },
    },
  };
}
