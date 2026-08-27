/**
 * Shared page-image policy for both read_page visual producers: PDF page renders
 * (extension iframe, pdf.js + DOM canvas) and HTML viewport captures (service
 * worker, captureVisibleTab + OffscreenCanvas). Their encode implementations
 * cannot merge because they run in different JS contexts, but the budget and the
 * fitting math must stay one definition so a limit change moves both.
 *
 * PDF-only knobs stay in pdf/protocol.ts; PDF_PAGE_IMAGE_MAX_SOURCE_PIXELS is a
 * pdf.js decoder guard, not an output bound.
 */

export const PAGE_IMAGE_MAX_EDGE = 1_024;
export const PAGE_IMAGE_MAX_PIXELS = 1_000_000;
export const PAGE_IMAGE_JPEG_QUALITY = 0.7;
export const PAGE_IMAGE_MAX_BYTES_PER_CALL = 6 * 1024 * 1024;
export const PAGE_IMAGE_MEDIA_TYPE = 'image/jpeg';

/**
 * Fit a source into the shared output budget.
 *
 * `allowUpscale` is the only difference between the two producers, and it is
 * deliberate rather than an oversight. A PDF page is vector, so the returned size
 * is a *render resolution*: exceeding 1x adds real detail, and a 612x792 letter
 * page is intentionally rasterized at 791x1024. A viewport capture is an already
 * rasterized screenshot, so exceeding 1x would resample pixels that do not exist
 * and spend the byte budget for nothing. The two agree exactly when downscaling.
 *
 * Floors rather than rounds so the megapixel bound is provably satisfied; rounding
 * can overshoot by ~0.1% on near-square sources.
 */
export function boundedImageSize(
  width: number,
  height: number,
  { allowUpscale }: { allowUpscale: boolean }
): { width: number; height: number } {
  const fitted = Math.min(
    PAGE_IMAGE_MAX_EDGE / Math.max(width, height),
    Math.sqrt(PAGE_IMAGE_MAX_PIXELS / (width * height))
  );
  const scale = allowUpscale ? fitted : Math.min(1, fitted);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
