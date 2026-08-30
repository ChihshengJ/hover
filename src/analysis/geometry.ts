/**
 * The one rectangle shape, and the one place PDFium's shape becomes it.
 *
 * `{x, y, width, height}` is what every renderer, hit-test and highlight in
 * this codebase speaks. PDFium reports `{origin: {x, y}, size: {width, height}}`
 * instead, and that conversion used to be hand-written at four call sites — a
 * standing invitation to read `rect.width` off an unconverted value and get
 * `undefined` with no error.
 *
 * `Rect` and `PdfiumRect` are declared globally in `src/types/index.d.ts`.
 */

/**
 * Convert PDFium's `{origin, size}` rect to the flat `Rect` used everywhere
 * else. Missing components read as 0, matching what the hand-written
 * conversions did.
 */
export function rectFromPdfium(rect: PdfiumRect | null | undefined): Rect {
  return {
    x: rect?.origin?.x || 0,
    y: rect?.origin?.y || 0,
    width: rect?.size?.width || 0,
    height: rect?.size?.height || 0,
  };
}
