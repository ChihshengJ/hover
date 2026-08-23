/**
 * Shared low-level WASM plumbing for the PDFium extractors.
 *
 * Both PdfiumTextExtractor and PdfiumImageExtractor talk to PDFium through the
 * same three patterns: page/text-page lifecycle, malloc'd out-parameters read
 * back off the typed heap views, and string buffers decoded from UTF-8/UTF-16.
 * They live here so the two extractors cannot drift apart — as they did with
 * the page-object type constants, which were wrong in one file and right in the
 * other.
 *
 * Out-parameters use a persistent scratch block instead of malloc/free. That is
 * not just tidiness: #getCharBox is called once per character, so a 6,800-char
 * page was doing ~27,000 malloc/free round-trips per page purely to read four
 * doubles at a time.
 */

/**
 * PDFium page-object types, as returned by FPDFPageObj_GetType.
 *
 * Verified empirically against the type-specific APIs rather than taken from
 * documentation: objects reporting type 2 are the ones FPDFPath_CountSegments
 * accepts, and objects reporting type 3 are the ones
 * FPDFImageObj_GetImagePixelSize accepts.
 *
 * @readonly
 */
export const PAGEOBJ = Object.freeze({
  UNKNOWN: 0,
  TEXT: 1,
  PATH: 2,
  IMAGE: 3,
  SHADING: 4,
  FORM: 5,
});

/**
 * Size of the persistent out-parameter scratch block.
 *
 * The widest single use is four f64 slots (32 bytes); the rest of the budget is
 * headroom for nested frames. Frames throw rather than silently overrun.
 */
const SCRATCH_BYTES = 128;

export class PdfiumFFI {
  /** @type {import('@embedpdf/pdfium').WrappedPdfiumModule} */
  #pdfium;

  /** @type {number} Lazily allocated scratch block for out-parameters. */
  #scratchPtr = 0;

  /** @type {number} Bump offset into the scratch block. */
  #scratchTop = 0;

  /** @type {number} Nesting depth of active frames; slots() requires > 0. */
  #frameDepth = 0;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#pdfium = pdfiumModule;
  }

  /** @returns {import('@embedpdf/pdfium').WrappedPdfiumModule} */
  get module() {
    return this.#pdfium;
  }

  // ==========================================================================
  // Page lifecycle
  // ==========================================================================

  /**
   * Open a page for object-level work, closing it on the way out.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, pageWidth: number, pageHeight: number}) => T} fn
   * @returns {T|null} null when the page cannot be loaded
   * @template T
   */
  withPage(docPtr, pageIndex, fn) {
    const pdfium = this.#pdfium;
    const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
    if (!pagePtr) return null;

    try {
      return fn({
        pagePtr,
        pageWidth: pdfium.FPDF_GetPageWidthF(pagePtr),
        pageHeight: pdfium.FPDF_GetPageHeightF(pagePtr),
      });
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  /**
   * Open a page and its text page, closing both on the way out.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, textPagePtr: number, pageWidth: number, pageHeight: number, charCount: number}) => T} fn
   * @returns {T|null} null when either the page or its text page cannot be loaded
   * @template T
   */
  withTextPage(docPtr, pageIndex, fn) {
    const pdfium = this.#pdfium;
    return this.withPage(docPtr, pageIndex, ({ pagePtr, pageWidth, pageHeight }) => {
      const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) return null;

      try {
        return fn({
          pagePtr,
          textPagePtr,
          pageWidth,
          pageHeight,
          charCount: pdfium.FPDFText_CountChars(textPagePtr),
        });
      } finally {
        pdfium.FPDFText_ClosePage(textPagePtr);
      }
    });
  }

  // ==========================================================================
  // Heap buffers
  // ==========================================================================

  /**
   * Run `fn` with a freshly malloc'd buffer, freeing it unconditionally.
   *
   * For variable-length data (text buffers). Fixed-size out-parameters should
   * use the scratch helpers below instead.
   *
   * @param {number} bytes
   * @param {(ptr: number) => T} fn
   * @returns {T}
   * @template T
   */
  withBuffer(bytes, fn) {
    const ptr = this.#pdfium.pdfium.wasmExports.malloc(bytes);
    if (!ptr) throw new Error(`PDFium malloc(${bytes}) failed`);

    try {
      return fn(ptr);
    } finally {
      this.#pdfium.pdfium.wasmExports.free(ptr);
    }
  }

  // ==========================================================================
  // Out-parameter scratch frames
  // ==========================================================================

  /**
   * Run `fn` inside a scratch frame. Every slot reserved during the call is
   * released when it returns, so frames may nest and may sit inside loops
   * without allocating.
   *
   * @param {() => T} fn
   * @returns {T}
   * @template T
   */
  frame(fn) {
    const savedTop = this.#scratchTop;
    this.#frameDepth++;
    try {
      return fn();
    } finally {
      this.#frameDepth--;
      this.#scratchTop = savedTop;
    }
  }

  /**
   * Reserve `count` scalar slots of `size` bytes inside the current frame.
   *
   * @param {number} count
   * @param {number} size - 4 or 8
   * @returns {number[]} pointers, in order
   */
  slots(count, size) {
    if (this.#frameDepth === 0) {
      throw new Error("PdfiumFFI.slots() must be called inside frame()");
    }
    if (!this.#scratchPtr) {
      this.#scratchPtr = this.#pdfium.pdfium.wasmExports.malloc(SCRATCH_BYTES);
      if (!this.#scratchPtr) throw new Error("PDFium scratch allocation failed");
    }

    const start = (this.#scratchTop + size - 1) & ~(size - 1);
    const end = start + count * size;
    if (end > SCRATCH_BYTES) {
      throw new RangeError(
        `PDFium scratch exhausted (${end} > ${SCRATCH_BYTES} bytes)`,
      );
    }
    this.#scratchTop = end;

    const ptrs = new Array(count);
    for (let i = 0; i < count; i++) ptrs[i] = this.#scratchPtr + start + i * size;
    return ptrs;
  }

  /**
   * Call `invoke` with `count` f64 out-parameter pointers and read them back.
   *
   * @param {number} count
   * @param {(...ptrs: number[]) => boolean|number} invoke
   * @returns {number[]|null} null when `invoke` reports failure
   */
  readF64Out(count, invoke) {
    return this.frame(() => {
      const ptrs = this.slots(count, 8);
      if (!invoke(...ptrs)) return null;
      return ptrs.map((ptr) => this.f64(ptr));
    });
  }

  /**
   * Call `invoke` with `count` f32 out-parameter pointers and read them back.
   *
   * @param {number} count
   * @param {(...ptrs: number[]) => boolean|number} invoke
   * @returns {number[]|null} null when `invoke` reports failure
   */
  readF32Out(count, invoke) {
    return this.frame(() => {
      const ptrs = this.slots(count, 4);
      if (!invoke(...ptrs)) return null;
      return ptrs.map((ptr) => this.f32(ptr));
    });
  }

  /**
   * Call `invoke` with `count` u32 out-parameter pointers and read them back.
   *
   * @param {number} count
   * @param {(...ptrs: number[]) => boolean|number} invoke
   * @returns {number[]|null} null when `invoke` reports failure
   */
  readU32Out(count, invoke) {
    return this.frame(() => {
      const ptrs = this.slots(count, 4);
      if (!invoke(...ptrs)) return null;
      return ptrs.map((ptr) => this.u32(ptr));
    });
  }

  // ==========================================================================
  // Heap readers
  // ==========================================================================

  /** @param {number} ptr @returns {number} */
  f64(ptr) {
    return this.#pdfium.pdfium.HEAPF64[ptr >> 3];
  }

  /** @param {number} ptr @returns {number} */
  f32(ptr) {
    return this.#pdfium.pdfium.HEAPF32[ptr >> 2];
  }

  /** @param {number} ptr @returns {number} */
  i32(ptr) {
    return this.#pdfium.pdfium.HEAP32[ptr >> 2];
  }

  /** @param {number} ptr @returns {number} */
  u32(ptr) {
    return this.#pdfium.pdfium.HEAPU32[ptr >> 2];
  }

  /**
   * Decode a NUL-terminated UTF-16 string.
   *
   * Only safe when the producing PDFium call actually writes a terminator —
   * FPDFText_GetText does, FPDFText_GetBoundedText does not when buflen equals
   * the text length. See PdfiumTextExtractor#extractTextRange.
   *
   * @param {number} ptr
   * @returns {string}
   */
  utf16(ptr) {
    return this.#pdfium.pdfium.UTF16ToString(ptr);
  }

  /** @param {number} ptr @returns {string} */
  utf8(ptr) {
    return this.#pdfium.pdfium.UTF8ToString(ptr);
  }

  /**
   * Copy bytes into the WASM heap at `ptr`.
   *
   * @param {Uint8Array} bytes
   * @param {number} ptr
   */
  writeBytes(bytes, ptr) {
    this.#pdfium.pdfium.HEAPU8.set(bytes, ptr);
  }

  /**
   * A view over `length` heap bytes starting at `ptr`. The view aliases WASM
   * memory, so copy out of it before anything can grow or free the heap.
   *
   * @param {number} ptr
   * @param {number} length
   * @returns {Uint8Array}
   */
  bytes(ptr, length) {
    return this.#pdfium.pdfium.HEAPU8.subarray(ptr, ptr + length);
  }

  /**
   * Allocate a heap copy of `bytes`. The caller owns the pointer.
   *
   * @param {Uint8Array} bytes
   * @returns {number}
   */
  allocBytes(bytes) {
    const ptr = this.#pdfium.pdfium.wasmExports.malloc(bytes.length);
    if (!ptr) throw new Error(`PDFium malloc(${bytes.length}) failed`);
    this.writeBytes(bytes, ptr);
    return ptr;
  }

  /**
   * Free a pointer obtained from allocBytes. No-op for 0.
   *
   * @param {number} ptr
   */
  free(ptr) {
    if (ptr) this.#pdfium.pdfium.wasmExports.free(ptr);
  }

  /**
   * Release the scratch block. Safe to call more than once; the block is
   * re-allocated on demand if the instance is used again.
   */
  dispose() {
    if (this.#scratchPtr) {
      this.#pdfium.pdfium.wasmExports.free(this.#scratchPtr);
      this.#scratchPtr = 0;
      this.#scratchTop = 0;
    }
  }
}
