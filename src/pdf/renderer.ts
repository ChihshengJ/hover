/**
 * Rasterise a page, or part of one, with PDFium.
 *
 * A port of `@embedpdf/engines` 2.15's `renderRectEncoded`, the path behind
 * both `renderPageRaw` and `renderPageRect`, fixed to the options Hover
 * passes: no rotation, a device pixel ratio of 1 (callers fold it into
 * `scale`), no annotations, no form widgets, a white background. Its output
 * matches the engine's byte for byte (`test/engine/render.test.ts`), so the
 * text gamma and luminance code downstream sees the same pixels.
 */

import type { PdfiumDocument } from "./document.js";

/** RGBA pixels, ready for `new ImageData(data, width, height)`. */
export interface RenderedPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** `FPDFBitmap_BGRA`. */
const FORMAT_BGRA = 4;

/**
 * `FPDF_REVERSE_BYTE_ORDER`: PDFium writes RGBA rather than BGRA into the
 * BGRA bitmap, which is what `ImageData` wants. `FPDF_ANNOT` (1) is off: the
 * viewer draws annotations itself.
 */
const RENDER_FLAGS = 0x10;

const WHITE = 0xffffffff;

/**
 * Render the whole page.
 *
 * @param index 0-based
 * @param scale device pixels per PDF unit
 */
export function renderPage(
  document: PdfiumDocument,
  index: number,
  scale: number,
): RenderedPixels {
  const page = document.page(index);
  if (!page) throw new RangeError(`No page ${index}`);
  return renderRect(document, index, scale, {
    x: 0,
    y: 0,
    width: page.size.width,
    height: page.size.height,
  });
}

/**
 * Render `rect` of the page into a bitmap `rect × scale` device pixels big.
 *
 * @param index 0-based
 * @param scale device pixels per PDF unit
 * @param rect in PDF units, top-left origin, on the page as displayed
 */
export function renderRect(
  document: PdfiumDocument,
  index: number,
  scale: number,
  rect: Rect,
): RenderedPixels {
  const pdfium = document.pdfium;
  const ffi = document.ffi;

  const s = Math.max(0.01, scale);
  const width = Math.max(1, Math.round(rect.width * s));
  const height = Math.max(1, Math.round(rect.height * s));
  const stride = width * 4;
  const bytes = stride * height;

  const pixels = document.withLoadedPage(index, (pagePtr) =>
    ffi.withBuffer(bytes, (buffer) => {
      const bitmap = pdfium.FPDFBitmap_CreateEx(
        width,
        height,
        FORMAT_BGRA,
        buffer,
        stride,
      );
      if (!bitmap) throw new Error(`PDFium could not create a ${width}×${height} bitmap`);
      try {
        pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, WHITE);
        ffi.frame(() => {
          // `buildUserToDeviceMatrix` for rotation 0: scale the rect to the
          // bitmap and move its corner to the origin.
          const sx = width / rect.width;
          const sy = height / rect.height;
          const matrix = ffi.slots(6, 4);
          const values = [sx, 0, 0, sy, -sx * rect.x, -sy * rect.y];
          for (let i = 0; i < 6; i++) pdfium.HEAPF32[matrix[i] >> 2] = values[i];
          const clip = ffi.slots(4, 4);
          const edges = [0, 0, width, height];
          for (let i = 0; i < 4; i++) pdfium.HEAPF32[clip[i] >> 2] = edges[i];

          pdfium.FPDF_RenderPageBitmapWithMatrix(
            bitmap,
            pagePtr,
            matrix[0],
            clip[0],
            RENDER_FLAGS,
          );
        });
      } finally {
        pdfium.FPDFBitmap_Destroy(bitmap);
      }
      // A copy: the buffer goes back to the heap as this returns.
      return new Uint8ClampedArray(ffi.bytes(buffer, bytes));
    }),
  );
  if (!pixels) throw new Error(`PDFium could not load page ${index}`);
  return { data: pixels, width, height };
}
