import { PAGEOBJ, PdfiumFFI } from "./pdfium_ffi.js";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { ObjectBounds } from "./pdfium_reader.js";

export interface ImageObjectInfo {
  /** Sequential index among all images on the page (stable across calls). */
  index: number;
  /** Bounds in PDF coordinates (bottom-left origin). */
  pdfRect: ObjectBounds;
  /** Bounds in screen coordinates (top-left origin). */
  screenRect: Rect;
  /** Native image pixel dimensions. */
  pixelDimensions: { width: number; height: number };
  /** Lazily extract the image pixels as RGBA ImageData. */
  getPixelData: () => ImageData | null;
}

const BITMAP_FORMAT_GRAY = 1;
const BITMAP_FORMAT_BGR = 2;
const BITMAP_FORMAT_BGRX = 3;
const BITMAP_FORMAT_BGRA = 4;

export class PdfiumImageExtractor {
  #pdfium: WrappedPdfiumModule;
  #ffi: PdfiumFFI;

  constructor(pdfiumModule: WrappedPdfiumModule) {
    this.#pdfium = pdfiumModule;
    this.#ffi = new PdfiumFFI(pdfiumModule);
  }

  /**
   * Release WASM scratch memory held by this extractor.
   */
  dispose() {
    this.#ffi.dispose();
  }

  /** @param pageIndex 0-based */
  withPage<T>(
    docPtr: number,
    pageIndex: number,
    fn: (ctx: {
      pagePtr: number;
      pageWidth: number;
      pageHeight: number;
    }) => T,
  ): T | null {
    return this.#ffi.withPage(docPtr, pageIndex, fn);
  }

  /**
   * Collect metadata for all images on a page without decoding pixel data.
   *
   * @param pageIndex 0-based
   */
  getPageImageInfos(
    docPtr: number,
    pageIndex: number,
  ): {
    pageIndex: number;
    images: ImageObjectInfo[];
    pageWidth: number;
    pageHeight: number;
  } {
    const result = this.withPage(
      docPtr,
      pageIndex,
      ({ pagePtr, pageWidth, pageHeight }) => {
        const imageObjPtrs = this.#collectImageObjects(pagePtr, false);
        const images: ImageObjectInfo[] = [];

        for (let i = 0; i < imageObjPtrs.length; i++) {
          const objPtr = imageObjPtrs[i];
          const bounds = this.#getObjectBounds(objPtr);
          if (!bounds) continue;

          const dims = this.#getPixelSize(objPtr);
          const idx = images.length;

          images.push({
            index: idx,
            pdfRect: bounds,
            screenRect: {
              x: bounds.left,
              y: pageHeight - bounds.top,
              width: bounds.right - bounds.left,
              height: bounds.top - bounds.bottom,
            },
            pixelDimensions: dims || { width: 0, height: 0 },
            getPixelData: () => this.getImageData(docPtr, pageIndex, idx),
          });
        }

        return { pageIndex, images, pageWidth, pageHeight };
      },
    );

    return result || { pageIndex, images: [], pageWidth: 0, pageHeight: 0 };
  }

  /**
   * Extract pixel data for a specific image as RGBA ImageData.
   * Re-loads the page and re-traverses objects to find the image by index.
   *
   * @param pageIndex 0-based
   * @param imageIndex from ImageObjectInfo.index
   */
  getImageData(
    docPtr: number,
    pageIndex: number,
    imageIndex: number,
  ): ImageData | null {
    return this.withPage(docPtr, pageIndex, ({ pagePtr }) => {
      const imageObjPtrs = this.#collectImageObjects(pagePtr, false);
      if (imageIndex < 0 || imageIndex >= imageObjPtrs.length) return null;
      return this.#extractBitmapAsRGBA(imageObjPtrs[imageIndex]);
    });
  }

  /**
   * Recursively collect all image object pointers from a page or form object.
   * Traversal order is deterministic: depth-first, preserving object order.
   *
   */
  #collectImageObjects(containerPtr: number, isForm: boolean): number[] {
    const pdfium = this.#pdfium;
    const count = isForm
      ? pdfium.FPDFFormObj_CountObjects(containerPtr)
      : pdfium.FPDFPage_CountObjects(containerPtr);

    const results: number[] = [];
    for (let i = 0; i < count; i++) {
      const objPtr = isForm
        ? pdfium.FPDFFormObj_GetObject(containerPtr, i)
        : pdfium.FPDFPage_GetObject(containerPtr, i);
      if (!objPtr) continue;

      const type = pdfium.FPDFPageObj_GetType(objPtr);
      if (type === PAGEOBJ.IMAGE) {
        results.push(objPtr);
      } else if (type === PAGEOBJ.FORM) {
        const nested = this.#collectImageObjects(objPtr, true);
        for (let j = 0; j < nested.length; j++) results.push(nested[j]);
      }
    }
    return results;
  }

  #getObjectBounds(objPtr: number): ObjectBounds | null {
    const pdfium = this.#pdfium;

    const bounds = this.#ffi.readF32Out(4, (l, b, r, t) =>
      pdfium.FPDFPageObj_GetBounds(objPtr, l, b, r, t),
    );
    if (!bounds) return null;

    const [left, bottom, right, top] = bounds;
    return { left, bottom, right, top };
  }

  /**
   * Get native pixel dimensions without creating a full bitmap.
   *
   */
  #getPixelSize(
    imageObjPtr: number,
  ): { width: number; height: number } | null {
    const pdfium = this.#pdfium;

    const dims = this.#ffi.readU32Out(2, (w, h) =>
      pdfium.FPDFImageObj_GetImagePixelSize(imageObjPtr, w, h),
    );
    if (!dims) return null;

    return { width: dims[0], height: dims[1] };
  }

  #extractBitmapAsRGBA(imageObjPtr: number): ImageData | null {
    const pdfium = this.#pdfium;
    const bitmapPtr = pdfium.FPDFImageObj_GetBitmap(imageObjPtr);
    if (!bitmapPtr) return null;

    try {
      const width = pdfium.FPDFBitmap_GetWidth(bitmapPtr);
      const height = pdfium.FPDFBitmap_GetHeight(bitmapPtr);
      const stride = pdfium.FPDFBitmap_GetStride(bitmapPtr);
      const format = pdfium.FPDFBitmap_GetFormat(bitmapPtr);
      const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);

      if (!bufferPtr || width <= 0 || height <= 0) return null;

      const src = this.#ffi.bytes(bufferPtr, height * stride);
      const rgba = new Uint8ClampedArray(width * height * 4);

      for (let row = 0; row < height; row++) {
        const rowOff = row * stride;
        for (let col = 0; col < width; col++) {
          const dst = (row * width + col) * 4;

          if (format === BITMAP_FORMAT_GRAY) {
            const g = src[rowOff + col];
            rgba[dst] = g;
            rgba[dst + 1] = g;
            rgba[dst + 2] = g;
            rgba[dst + 3] = 255;
          } else if (format === BITMAP_FORMAT_BGR) {
            const s = rowOff + col * 3;
            rgba[dst] = src[s + 2];
            rgba[dst + 1] = src[s + 1];
            rgba[dst + 2] = src[s];
            rgba[dst + 3] = 255;
          } else if (format === BITMAP_FORMAT_BGRX) {
            const s = rowOff + col * 4;
            rgba[dst] = src[s + 2];
            rgba[dst + 1] = src[s + 1];
            rgba[dst + 2] = src[s];
            rgba[dst + 3] = 255;
          } else if (format === BITMAP_FORMAT_BGRA) {
            const s = rowOff + col * 4;
            rgba[dst] = src[s + 2];
            rgba[dst + 1] = src[s + 1];
            rgba[dst + 2] = src[s];
            rgba[dst + 3] = src[s + 3];
          } else {
            return null;
          }
        }
      }

      return new ImageData(rgba, width, height);
    } finally {
      pdfium.FPDFBitmap_Destroy(bitmapPtr);
    }
  }
}
