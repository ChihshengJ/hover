// NOTE: PdfiumImageExtractor and PdfiumTextExtractor share WASM memory patterns
// (malloc/free, HEAPF32/HEAPU8 reads, withPage lifecycle). If both grow further,
// a shared WASM-memory utility module would reduce duplication.

/**
 * @typedef {Object} ImageObjectInfo
 * @property {number} index - Sequential index among all images on the page (stable across calls)
 * @property {{left: number, bottom: number, right: number, top: number}} pdfRect - Bounds in PDF coordinates (bottom-left origin)
 * @property {{x: number, y: number, width: number, height: number}} screenRect - Bounds in screen coordinates (top-left origin)
 * @property {{width: number, height: number}} pixelDimensions - Native image pixel dimensions
 * @property {() => ImageData|null} getPixelData - Lazily extract the image pixels as RGBA ImageData
 */

const PAGEOBJ_IMAGE = 3;
const PAGEOBJ_FORM = 5;

const BITMAP_FORMAT_GRAY = 1;
const BITMAP_FORMAT_BGR = 2;
const BITMAP_FORMAT_BGRX = 3;
const BITMAP_FORMAT_BGRA = 4;

export class PdfiumImageExtractor {
  /** @type {import('@embedpdf/pdfium').WrappedPdfiumModule} */
  #pdfium;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#pdfium = pdfiumModule;
  }

  /**
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, pageWidth: number, pageHeight: number}) => T} fn
   * @returns {T|null}
   * @template T
   */
  withPage(docPtr, pageIndex, fn) {
    const pdfium = this.#pdfium;
    const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
    if (!pagePtr) return null;

    try {
      const pageWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
      const pageHeight = pdfium.FPDF_GetPageHeightF(pagePtr);
      return fn({ pagePtr, pageWidth, pageHeight });
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  /**
   * Collect metadata for all images on a page without decoding pixel data.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @returns {{pageIndex: number, images: ImageObjectInfo[], pageWidth: number, pageHeight: number}}
   */
  getPageImageInfos(docPtr, pageIndex) {
    const result = this.withPage(docPtr, pageIndex, ({ pagePtr, pageWidth, pageHeight }) => {
      const imageObjPtrs = this.#collectImageObjects(pagePtr, false);
      const images = [];

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
    });

    return result || { pageIndex, images: [], pageWidth: 0, pageHeight: 0 };
  }

  /**
   * Extract pixel data for a specific image as RGBA ImageData.
   * Re-loads the page and re-traverses objects to find the image by index.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {number} imageIndex - from ImageObjectInfo.index
   * @returns {ImageData|null}
   */
  getImageData(docPtr, pageIndex, imageIndex) {
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
   * @param {number} containerPtr
   * @param {boolean} isForm
   * @returns {number[]}
   */
  #collectImageObjects(containerPtr, isForm) {
    const pdfium = this.#pdfium;
    const count = isForm
      ? pdfium.FPDFFormObj_CountObjects(containerPtr)
      : pdfium.FPDFPage_CountObjects(containerPtr);

    const results = [];
    for (let i = 0; i < count; i++) {
      const objPtr = isForm
        ? pdfium.FPDFFormObj_GetObject(containerPtr, i)
        : pdfium.FPDFPage_GetObject(containerPtr, i);
      if (!objPtr) continue;

      const type = pdfium.FPDFPageObj_GetType(objPtr);
      if (type === PAGEOBJ_IMAGE) {
        results.push(objPtr);
      } else if (type === PAGEOBJ_FORM) {
        const nested = this.#collectImageObjects(objPtr, true);
        for (let j = 0; j < nested.length; j++) results.push(nested[j]);
      }
    }
    return results;
  }

  /**
   * @param {number} objPtr
   * @returns {{left: number, bottom: number, right: number, top: number}|null}
   */
  #getObjectBounds(objPtr) {
    const pdfium = this.#pdfium;
    const leftPtr = pdfium.pdfium.wasmExports.malloc(4);
    const bottomPtr = pdfium.pdfium.wasmExports.malloc(4);
    const rightPtr = pdfium.pdfium.wasmExports.malloc(4);
    const topPtr = pdfium.pdfium.wasmExports.malloc(4);

    try {
      const ok = pdfium.FPDFPageObj_GetBounds(objPtr, leftPtr, bottomPtr, rightPtr, topPtr);
      if (!ok) return null;

      return {
        left: pdfium.pdfium.HEAPF32[leftPtr >> 2],
        bottom: pdfium.pdfium.HEAPF32[bottomPtr >> 2],
        right: pdfium.pdfium.HEAPF32[rightPtr >> 2],
        top: pdfium.pdfium.HEAPF32[topPtr >> 2],
      };
    } finally {
      pdfium.pdfium.wasmExports.free(leftPtr);
      pdfium.pdfium.wasmExports.free(bottomPtr);
      pdfium.pdfium.wasmExports.free(rightPtr);
      pdfium.pdfium.wasmExports.free(topPtr);
    }
  }

  /**
   * Get native pixel dimensions without creating a full bitmap.
   *
   * @param {number} imageObjPtr
   * @returns {{width: number, height: number}|null}
   */
  #getPixelSize(imageObjPtr) {
    const pdfium = this.#pdfium;
    const wPtr = pdfium.pdfium.wasmExports.malloc(4);
    const hPtr = pdfium.pdfium.wasmExports.malloc(4);

    try {
      const ok = pdfium.FPDFImageObj_GetImagePixelSize(imageObjPtr, wPtr, hPtr);
      if (!ok) return null;

      return {
        width: pdfium.pdfium.HEAPU32[wPtr >> 2],
        height: pdfium.pdfium.HEAPU32[hPtr >> 2],
      };
    } finally {
      pdfium.pdfium.wasmExports.free(wPtr);
      pdfium.pdfium.wasmExports.free(hPtr);
    }
  }

  /**
   * @param {number} imageObjPtr
   * @returns {ImageData|null}
   */
  #extractBitmapAsRGBA(imageObjPtr) {
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

      const src = pdfium.pdfium.HEAPU8.subarray(bufferPtr, bufferPtr + height * stride);
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
