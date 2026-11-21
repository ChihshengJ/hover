/**
 * Shared low-level WASM plumbing for the PDFium extractors: page lifecycle,
 * out-parameter reads off the typed heap views, and string/byte buffers.
 *
 * Fixed-size out-parameters go through a persistent scratch block rather than
 * malloc/free, because reading one character box is four doubles and that runs
 * once per character — tens of thousands of allocator round-trips per page.
 */

import type { PdfiumBindings } from "./pdfium_module.js";

const UTF16LE = new TextDecoder("utf-16le");
const UTF8 = new TextDecoder("utf-8");
const UTF8_ENCODER = new TextEncoder();

/**
 * PDFium page-object types, as returned by FPDFPageObj_GetType. Same values as
 * @embedpdf/models' PdfPageObjectType.
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
 * Size of the persistent out-parameter scratch block. The widest single use is
 * four f64 slots (32 bytes); the rest is headroom for nested frames, which
 * throw rather than silently overrun.
 */
const SCRATCH_BYTES = 128;

export class PdfiumFFI {
  #pdfium: PdfiumBindings;

  /** Lazily allocated scratch block for out-parameters. */
  #scratchPtr = 0;

  /** Bump offset into the scratch block. */
  #scratchTop = 0;

  /** Nesting depth of active frames; slots() requires > 0. */
  #frameDepth = 0;

  constructor(pdfium: PdfiumBindings) {
    this.#pdfium = pdfium;
  }

  get pdfium(): PdfiumBindings {
    return this.#pdfium;
  }

  // ==========================================================================
  // Page lifecycle
  // ==========================================================================

  /**
   * Open a page for object-level work, closing it on the way out.
   *
   * @param pageIndex 0-based
   * @returns null when the page cannot be loaded
   */
  withPage<T>(
    docPtr: number,
    pageIndex: number,
    fn: (ctx: {
      pagePtr: number;
      pageWidth: number;
      pageHeight: number;
    }) => T,
  ): T | null {
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
   * @param pageIndex 0-based
   * @returns null when either the page or its text page cannot be loaded
   */
  withTextPage<T>(
    docPtr: number,
    pageIndex: number,
    fn: (ctx: {
      pagePtr: number;
      textPagePtr: number;
      pageWidth: number;
      pageHeight: number;
      charCount: number;
    }) => T,
  ): T | null {
    const pdfium = this.#pdfium;
    return this.withPage(
      docPtr,
      pageIndex,
      ({ pagePtr, pageWidth, pageHeight }) => {
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
      },
    );
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
   */
  withBuffer<T>(bytes: number, fn: (ptr: number) => T): T {
    const ptr = this.#pdfium.malloc(bytes);
    if (!ptr) throw new Error(`PDFium malloc(${bytes}) failed`);

    try {
      return fn(ptr);
    } finally {
      this.#pdfium.free(ptr);
    }
  }

  /**
   * Run `fn` with `text` as a NUL-terminated UTF-8 string on the heap, or with
   * a null pointer for null, and free it after.
   */
  withCString<T>(text: string | null, fn: (ptr: number) => T): T {
    if (text === null) return fn(0);
    const encoded = UTF8_ENCODER.encode(text);
    return this.withBuffer(encoded.length + 1, (ptr) => {
      this.writeBytes(encoded, ptr);
      this.#pdfium.HEAPU8[ptr + encoded.length] = 0;
      return fn(ptr);
    });
  }

  // ==========================================================================
  // Out-parameter scratch frames
  // ==========================================================================

  /**
   * Run `fn` inside a scratch frame. Slots reserved during the call are
   * released when it returns, so frames may nest and may sit inside loops
   * without allocating.
   *
   */
  frame<T>(fn: () => T): T {
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
   * @param size 4 or 8
   * @returns pointers, in order
   */
  slots(count: number, size: number): number[] {
    if (this.#frameDepth === 0) {
      throw new Error("PdfiumFFI.slots() must be called inside frame()");
    }
    if (!this.#scratchPtr) {
      this.#scratchPtr = this.#pdfium.malloc(SCRATCH_BYTES);
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

    const ptrs: number[] = new Array(count);
    for (let i = 0; i < count; i++) ptrs[i] = this.#scratchPtr + start + i * size;
    return ptrs;
  }

  /**
   * Call `invoke` with `count` f64 out-parameter pointers and read them back.
   *
   * @returns null when `invoke` reports failure
   */
  readF64Out(
    count: number,
    invoke: (...ptrs: number[]) => boolean | number,
  ): number[] | null {
    return this.frame(() => {
      const ptrs = this.slots(count, 8);
      if (!invoke(...ptrs)) return null;
      return ptrs.map((ptr) => this.f64(ptr));
    });
  }

  /**
   * Call `invoke` with `count` f32 out-parameter pointers and read them back.
   *
   * @returns null when `invoke` reports failure
   */
  readF32Out(
    count: number,
    invoke: (...ptrs: number[]) => boolean | number,
  ): number[] | null {
    return this.frame(() => {
      const ptrs = this.slots(count, 4);
      if (!invoke(...ptrs)) return null;
      return ptrs.map((ptr) => this.f32(ptr));
    });
  }

  /**
   * Call `invoke` with `count` u32 out-parameter pointers and read them back.
   *
   * @returns null when `invoke` reports failure
   */
  readU32Out(
    count: number,
    invoke: (...ptrs: number[]) => boolean | number,
  ): number[] | null {
    return this.frame(() => {
      const ptrs = this.slots(count, 4);
      if (!invoke(...ptrs)) return null;
      return ptrs.map((ptr) => this.u32(ptr));
    });
  }

  // ==========================================================================
  // Heap readers
  // ==========================================================================

  f64(ptr: number): number {
    return this.#pdfium.HEAPF64[ptr >> 3];
  }

  f32(ptr: number): number {
    return this.#pdfium.HEAPF32[ptr >> 2];
  }

  i32(ptr: number): number {
    return this.#pdfium.HEAP32[ptr >> 2];
  }

  u32(ptr: number): number {
    return this.#pdfium.HEAPU32[ptr >> 2];
  }

  /**
   * Decode a NUL-terminated UTF-16LE string. Only safe when the producing
   * PDFium call actually writes a terminator; see PdfiumPageReader#readText.
   *
   * A lone surrogate decodes to U+FFFD. Emscripten's `UTF16ToString`, used
   * before, kept it for strings of 16 units or fewer and replaced it in longer
   * ones.
   */
  utf16(ptr: number): string {
    const heap = this.#pdfium.HEAPU8;
    let end = ptr;
    while (end + 1 < heap.length && (heap[end] | heap[end + 1]) !== 0) end += 2;
    return UTF16LE.decode(heap.subarray(ptr, end));
  }

  /** Decode a NUL-terminated UTF-8 string. */
  utf8(ptr: number): string {
    const heap = this.#pdfium.HEAPU8;
    const end = heap.indexOf(0, ptr);
    return UTF8.decode(heap.subarray(ptr, end < 0 ? heap.length : end));
  }

  /**
   * Copy bytes into the WASM heap at `ptr`.
   *
   */
  writeBytes(bytes: Uint8Array, ptr: number) {
    this.#pdfium.HEAPU8.set(bytes, ptr);
  }

  /**
   * A view over `length` heap bytes starting at `ptr`. The view aliases WASM
   * memory, so copy out of it before anything can grow or free the heap.
   */
  bytes(ptr: number, length: number): Uint8Array {
    return this.#pdfium.HEAPU8.subarray(ptr, ptr + length);
  }

  /**
   * Allocate a heap copy of `bytes`. The caller owns the pointer.
   *
   */
  allocBytes(bytes: Uint8Array): number {
    const ptr = this.#pdfium.malloc(bytes.length);
    if (!ptr) throw new Error(`PDFium malloc(${bytes.length}) failed`);
    this.writeBytes(bytes, ptr);
    return ptr;
  }

  /**
   * Free a pointer obtained from allocBytes. No-op for 0.
   *
   */
  free(ptr: number) {
    if (ptr) this.#pdfium.free(ptr);
  }

  /**
   * Release the scratch block. Safe to call more than once; the block is
   * re-allocated on demand if the instance is used again.
   */
  dispose() {
    // Freeing mid-frame would hand back memory a live PDFium call is about to
    // write through.
    if (this.#frameDepth > 0) {
      throw new Error("PdfiumFFI.dispose() called inside frame()");
    }
    if (this.#scratchPtr) {
      this.#pdfium.free(this.#scratchPtr);
      this.#scratchPtr = 0;
      this.#scratchTop = 0;
    }
  }
}
