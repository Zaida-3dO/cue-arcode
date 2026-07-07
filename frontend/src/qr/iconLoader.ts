// Center-icon import: PNG, JPG, and SVG. PNG/JPG are already raster formats
// and just need reading as a data URL. SVG is the risky path — per the task
// spec this needs to be rasterized to a canvas/image *before* handing it to
// qr-code-styling as a center image, rather than trusting qr-code-styling's
// own (SVG-mode-only, easy to get wrong with untrusted/complex SVGs) embed
// path. We rasterize every SVG upload to a PNG data URL up front so the
// downstream code (qr-code-styling, our canvas wrapper, jsQR test-scan) only
// ever has to deal with one format regardless of what the user uploaded.

const RASTERIZE_SIZE = 512; // px — generous fixed canvas, downsized by qr-code-styling's own imageOptions later

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/** Rasterizes an SVG Blob/File to a PNG data URL via an offscreen canvas. */
async function rasterizeSvgToPngDataUrl(file: File): Promise<string> {
  const svgText = await file.text();
  // Re-wrap as an explicit image/svg+xml blob URL — more reliably loadable
  // into an <img> across browsers than a raw data: URL for arbitrary SVG
  // content (avoids data-URL escaping pitfalls with quotes/newlines).
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const img = await loadImage(blobUrl);

    const canvas = document.createElement('canvas');
    canvas.width = RASTERIZE_SIZE;
    canvas.height = RASTERIZE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    // Preserve aspect ratio, center within the square canvas, transparent padding.
    const naturalW = img.naturalWidth || RASTERIZE_SIZE;
    const naturalH = img.naturalHeight || RASTERIZE_SIZE;
    const scale = Math.min(RASTERIZE_SIZE / naturalW, RASTERIZE_SIZE / naturalH);
    const drawW = naturalW * scale;
    const drawH = naturalH * scale;
    const dx = (RASTERIZE_SIZE - drawW) / 2;
    const dy = (RASTERIZE_SIZE - drawH) / 2;

    ctx.clearRect(0, 0, RASTERIZE_SIZE, RASTERIZE_SIZE);
    ctx.drawImage(img, dx, dy, drawW, drawH);

    // toDataURL throws a SecurityError ("tainted canvas") if the SVG pulled
    // in cross-origin external resources — surface that clearly rather than
    // letting it bubble as an opaque exception.
    try {
      return canvas.toDataURL('image/png');
    } catch {
      throw new Error(
        'Could not rasterize this SVG (it may reference external resources, which taints the canvas). ' +
          'Try an SVG with everything inlined, or use a PNG/JPG instead.',
      );
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load SVG as an image (malformed SVG?)'));
    img.src = src;
  });
}

/** Loads a user-selected icon file (PNG/JPG/SVG) as a data URL, rasterizing SVG first. */
export async function loadIconAsDataUrl(file: File): Promise<string> {
  const type = file.type.toLowerCase();
  if (type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
    return rasterizeSvgToPngDataUrl(file);
  }
  if (type === 'image/png' || type === 'image/jpeg') {
    return readFileAsDataUrl(file);
  }
  throw new Error(`Unsupported icon type '${file.type || file.name}' — use PNG, JPG, or SVG`);
}
