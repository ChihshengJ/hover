/**
 * @typedef {Object} TextSlice
 * @property {string} content - The text content (properly decoded from UTF-16LE)
 * @property {Object} rect - Bounding rectangle
 * @property {Object} rect.origin - Origin point {x, y} (top-left coordinate system)
 * @property {Object} rect.size - Size {width, height}
 * @property {Object} [font] - Font information
 * @property {number} [font.size] - Font size
 * @property {string} [font.family] - Font family name
 *
 * @typedef {Object} PageTextResult
 * @property {number} pageIndex - 0-based page index
 * @property {string} fullText - Complete page text
 * @property {TextSlice[]} textSlices - Text slices with position information (matches getPageTextRects format)
 * @property {number} pageWidth - Page width in PDF units
 * @property {number} pageHeight - Page height in PDF units
 */

export class PdfiumTextExtractor {
  /** @type {import('@embedpdf/pdfium').WrappedPdfiumModule} */
  #pdfium = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#pdfium = pdfiumModule;
  }

  // ============================================================================
  // Core low-level WASM helpers (shared by all consumers)
  // ============================================================================

  /**
   * Open a page and text-page, run a callback, then close both.
   * Centralises the load/close lifecycle that was duplicated everywhere.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, textPagePtr: number, pageWidth: number, pageHeight: number, charCount: number}) => T} fn
   * @returns {T|null}
   * @template T
   */
  withTextPage(docPtr, pageIndex, fn) {
    const pdfium = this.#pdfium;
    const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
    if (!pagePtr) return null;

    try {
      const pageWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
      const pageHeight = pdfium.FPDF_GetPageHeightF(pagePtr);
      const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) return null;

      try {
        const charCount = pdfium.FPDFText_CountChars(textPagePtr);
        return fn({ pagePtr, textPagePtr, pageWidth, pageHeight, charCount });
      } finally {
        pdfium.FPDFText_ClosePage(textPagePtr);
      }
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  /**
   * Extract a UTF-16 text range from an already-opened text page.
   *
   * @param {number} textPagePtr
   * @param {number} startIndex
   * @param {number} count
   * @returns {string}
   */
  extractTextRange(textPagePtr, startIndex, count) {
    return this.#extractTextRange(textPagePtr, startIndex, count);
  }

  /**
   * Get bounding rects for a character range on an already-opened text page.
   * Returns rects in top-left origin coordinate system.
   *
   * @param {number} textPagePtr
   * @param {number} startCharIndex
   * @param {number} charCount
   * @param {number} pageHeight - needed for Y-flip
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  getRectsForCharRange(textPagePtr, startCharIndex, charCount, pageHeight) {
    return this.#getRectsForRange(
      textPagePtr,
      startCharIndex,
      charCount,
      pageHeight,
    );
  }

  // ============================================================================
  // Convenience: full-text + rects using docPtr (opens/closes page internally)
  // ============================================================================

  /**
   * Extract full NFC-normalised text from a page.
   * Opens and closes the page automatically.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @returns {{fullText: string, charCount: number, pageWidth: number, pageHeight: number}}
   */
  getPageFullText(docPtr, pageIndex) {
    const result = this.withTextPage(docPtr, pageIndex, (ctx) => {
      if (ctx.charCount <= 0) {
        return {
          fullText: "",
          charCount: 0,
          pageWidth: ctx.pageWidth,
          pageHeight: ctx.pageHeight,
        };
      }
      let fullText = this.#extractTextRange(ctx.textPagePtr, 0, ctx.charCount);
      fullText = fullText.normalize("NFC");
      return {
        fullText,
        charCount: ctx.charCount,
        pageWidth: ctx.pageWidth,
        pageHeight: ctx.pageHeight,
      };
    });
    return (
      result || { fullText: "", charCount: 0, pageWidth: 0, pageHeight: 0 }
    );
  }

  /**
   * Get bounding rectangles for a character range.
   * Opens and closes the page automatically.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {number} startCharIndex
   * @param {number} charCount
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  getRectsForCharRangeOnPage(docPtr, pageIndex, startCharIndex, charCount) {
    const result = this.withTextPage(docPtr, pageIndex, (ctx) => {
      return this.#getRectsForRange(
        ctx.textPagePtr,
        startCharIndex,
        charCount,
        ctx.pageHeight,
      );
    });
    return result || [];
  }

  // ============================================================================
  // High-level page extraction (used by DocumentTextIndex)
  // ============================================================================

  /**
   * Extract text from a page with proper UTF-16LE handling
   * Returns data in a format compatible with getPageTextRects
   *
   * @param {number} docPtr - Document pointer
   * @param {number} pageIndex - 0-based page index
   * @returns {PageTextResult}
   */
  extractPageText(docPtr, pageIndex) {
    const result = this.withTextPage(docPtr, pageIndex, (ctx) => {
      if (ctx.charCount <= 0) {
        return {
          pageIndex,
          fullText: "",
          textSlices: [],
          pageWidth: ctx.pageWidth,
          pageHeight: ctx.pageHeight,
        };
      }

      const fullText = this.#extractTextRange(
        ctx.textPagePtr,
        0,
        ctx.charCount,
      );

      const textSlices = this.#extractWordBasedSlices(
        ctx.textPagePtr,
        ctx.charCount,
        ctx.pageHeight,
      );

      return {
        pageIndex,
        fullText,
        textSlices,
        pageWidth: ctx.pageWidth,
        pageHeight: ctx.pageHeight,
      };
    });

    if (!result) {
      throw new Error(`Failed to load page ${pageIndex}`);
    }
    return result;
  }

  // ============================================================================
  // Private low-level helpers
  // ============================================================================

  /**
   * Get bounding rects for a character range (core implementation).
   * Operates on an already-opened textPagePtr.
   *
   * @param {number} textPagePtr
   * @param {number} startCharIndex
   * @param {number} charCount
   * @param {number} pageHeight - for Y-flip (PDF bottom-left → top-left)
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  #getRectsForRange(textPagePtr, startCharIndex, charCount, pageHeight) {
    const pdfium = this.#pdfium;
    const rects = [];

    const rectCount = pdfium.FPDFText_CountRects(
      textPagePtr,
      startCharIndex,
      charCount,
    );
    if (rectCount <= 0) return rects;

    const leftPtr = pdfium.pdfium.wasmExports.malloc(8);
    const topPtr = pdfium.pdfium.wasmExports.malloc(8);
    const rightPtr = pdfium.pdfium.wasmExports.malloc(8);
    const bottomPtr = pdfium.pdfium.wasmExports.malloc(8);

    try {
      for (let i = 0; i < rectCount; i++) {
        const success = pdfium.FPDFText_GetRect(
          textPagePtr,
          i,
          leftPtr,
          topPtr,
          rightPtr,
          bottomPtr,
        );
        if (!success) continue;

        const left = pdfium.pdfium.HEAPF64[leftPtr >> 3];
        const top = pdfium.pdfium.HEAPF64[topPtr >> 3];
        const right = pdfium.pdfium.HEAPF64[rightPtr >> 3];
        const bottom = pdfium.pdfium.HEAPF64[bottomPtr >> 3];

        rects.push({
          x: left,
          y: pageHeight - top,
          width: right - left,
          height: top - bottom,
        });
      }
    } finally {
      pdfium.pdfium.wasmExports.free(leftPtr);
      pdfium.pdfium.wasmExports.free(topPtr);
      pdfium.pdfium.wasmExports.free(rightPtr);
      pdfium.pdfium.wasmExports.free(bottomPtr);
    }

    return rects;
  }

  /**
   * Extract text from a character range.
   *
   * @param {number} textPagePtr - Text page pointer
   * @param {number} startIndex - Starting character index
   * @param {number} count - Number of characters to extract
   * @returns {string}
   */
  #extractTextRange(textPagePtr, startIndex, count) {
    if (count <= 0) return "";

    const pdfium = this.#pdfium;

    const bufferSize = (count + 1) * 2;
    const textBufferPtr = pdfium.pdfium.wasmExports.malloc(bufferSize);

    try {
      const extractedLength = pdfium.FPDFText_GetText(
        textPagePtr,
        startIndex,
        count,
        textBufferPtr,
      );

      if (extractedLength > 0) {
        return pdfium.pdfium.UTF16ToString(textBufferPtr);
      }
      return "";
    } finally {
      pdfium.pdfium.wasmExports.free(textBufferPtr);
    }
  }

  /**
   * Get character box for a single character (using FPDFText_GetCharBox)
   * Returns null for whitespace/control characters that have no visual box
   *
   * @param {number} textPagePtr
   * @param {number} charIndex
   * @param {number} pageHeight
   * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}|null}
   */
  #getCharBox(textPagePtr, charIndex, pageHeight) {
    const pdfium = this.#pdfium;

    const leftPtr = pdfium.pdfium.wasmExports.malloc(8);
    const rightPtr = pdfium.pdfium.wasmExports.malloc(8);
    const bottomPtr = pdfium.pdfium.wasmExports.malloc(8);
    const topPtr = pdfium.pdfium.wasmExports.malloc(8);

    try {
      const success = pdfium.FPDFText_GetCharBox(
        textPagePtr,
        charIndex,
        leftPtr,
        rightPtr,
        bottomPtr,
        topPtr,
      );

      if (!success) return null;

      const left = pdfium.pdfium.HEAPF64[leftPtr >> 3];
      const right = pdfium.pdfium.HEAPF64[rightPtr >> 3];
      const bottom = pdfium.pdfium.HEAPF64[bottomPtr >> 3];
      const top = pdfium.pdfium.HEAPF64[topPtr >> 3];

      return {
        left,
        right,
        bottom,
        top,
        x: left,
        y: top,
        width: right - left,
        height: top - bottom,
      };
    } finally {
      pdfium.pdfium.wasmExports.free(leftPtr);
      pdfium.pdfium.wasmExports.free(rightPtr);
      pdfium.pdfium.wasmExports.free(bottomPtr);
      pdfium.pdfium.wasmExports.free(topPtr);
    }
  }

  /**
   * Extract text slices grouped by words/text runs instead of individual characters.
   * This approach:
   * 1. Uses character indices (not bounded text) to avoid ligature duplication
   * 2. Groups adjacent characters into words/runs to reduce DOM elements
   * 3. Uses FPDFText_GetCharBox for accurate per-character positioning
   * 4. Preserves trailing whitespace/control characters for accurate text reconstruction
   *
   * @param {number} textPagePtr - Text page pointer
   * @param {number} totalChars - Total character count
   * @param {number} pageHeight - Page height for Y coordinate conversion
   * @returns {TextSlice[]}
   */
  #extractWordBasedSlices(textPagePtr, totalChars, pageHeight) {
    const pdfium = this.#pdfium;
    const textSlices = [];

    if (totalChars <= 0) return textSlices;

    const chars = [];
    for (let i = 0; i < totalChars; i++) {
      const charCode = pdfium.FPDFText_GetUnicode(textPagePtr, i);
      const char = String.fromCodePoint(charCode);
      const box = this.#getCharBox(textPagePtr, i, pageHeight);

      const isWhitespace = charCode === 32; // space
      const isNewline = charCode === 10 || charCode === 13; // LF or CR
      const isControlChar = charCode < 32 && !isNewline; // other control chars
      const isDigit = charCode >= 48 && charCode <= 57; // 0-9

      chars.push({
        index: i,
        char,
        charCode,
        box,
        isWhitespace,
        isNewline,
        isControlChar,
        isDigit,
      });
    }

    const getFontInfo = (charIndex) => {
      const fontSize = pdfium.FPDFText_GetFontSize(textPagePtr, charIndex);

      const fontNameLength = pdfium.FPDFText_GetFontInfo(
        textPagePtr,
        charIndex,
        0,
        0,
        0,
      );

      if (fontNameLength <= 0) {
        return { size: fontSize, family: null };
      }

      const bytesCount = fontNameLength + 1;
      const textBufferPtr = pdfium.pdfium.wasmExports.malloc(bytesCount);
      const flagsPtr = pdfium.pdfium.wasmExports.malloc(4);

      try {
        pdfium.FPDFText_GetFontInfo(
          textPagePtr,
          charIndex,
          textBufferPtr,
          bytesCount,
          flagsPtr,
        );

        const fontFamily = pdfium.pdfium.UTF8ToString(textBufferPtr);
        return {
          size: fontSize,
          family: fontFamily || null,
        };
      } finally {
        pdfium.pdfium.wasmExports.free(textBufferPtr);
        pdfium.pdfium.wasmExports.free(flagsPtr);
      }
    };

    let currentRun = null;
    const LINE_TOLERANCE_FACTOR = 1.2; // Y tolerance for same line
    const WORD_GAP_FACTOR = 2; // Gap threshold as fraction of char height

    for (let i = 0; i < chars.length; i++) {
      const { char, charCode, box, isWhitespace, isNewline, isControlChar } =
        chars[i];

      // Handle characters without visual representation (whitespace/control)
      if (!box || isWhitespace || isNewline || isControlChar) {
        if (currentRun) {
          currentRun.trailingChars = currentRun.trailingChars || [];
          currentRun.trailingChars.push(char);
          currentRun.endIndex = i;

          // Newlines force a run break after being added
          if (isNewline) {
            this.#finalizeRun(currentRun, textSlices, getFontInfo);
            currentRun = null;
          }
        }
        // If no current run, skip leading whitespace (will be captured by fullText)
        continue;
      }

      if (box.width < 0 && box.height < 0) continue;
      if (box.height > 100 || box.width > 200) continue;

      const hasTrailingWhitespace =
        currentRun &&
        currentRun.trailingChars &&
        currentRun.trailingChars.length > 0;

      const isDigit = chars[i].isDigit;

      if (!currentRun) {
        currentRun = {
          startIndex: i,
          endIndex: i,
          chars: [char],
          trailingChars: [],
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          avgHeight: box.height,
          lastVisibleCharCode: charCode,
        };
        continue;
      }

      const sameLine =
        Math.abs(box.bottom - currentRun.bottom) <
        currentRun.avgHeight * LINE_TOLERANCE_FACTOR;
      const gapThreshold = currentRun.avgHeight * WORD_GAP_FACTOR;
      const horizontalGap = box.left - currentRun.right;
      const isAdjacent = horizontalGap < gapThreshold;

      const lastCode = currentRun.lastVisibleCharCode;
      const lastIsDigit = lastCode >= 48 && lastCode <= 57;
      const lastIsAlpha =
        (lastCode >= 65 && lastCode <= 90) ||
        (lastCode >= 97 && lastCode <= 122) ||
        lastCode > 127;
      const currentIsAlpha =
        (charCode >= 65 && charCode <= 90) ||
        (charCode >= 97 && charCode <= 122) ||
        charCode > 127;
      const digitAlphaBoundary =
        (isDigit && lastIsAlpha) || (currentIsAlpha && lastIsDigit);

      if (
        hasTrailingWhitespace ||
        !sameLine ||
        !isAdjacent ||
        digitAlphaBoundary
      ) {
        this.#finalizeRun(currentRun, textSlices, getFontInfo);
        currentRun = {
          startIndex: i,
          endIndex: i,
          chars: [char],
          trailingChars: [],
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          avgHeight: box.height,
          lastVisibleCharCode: charCode,
        };
      } else {
        currentRun.endIndex = i;
        currentRun.chars.push(char);
        currentRun.right = Math.max(currentRun.right, box.right);
        currentRun.bottom = Math.min(currentRun.bottom, box.bottom);
        currentRun.top = Math.max(currentRun.top, box.top);
        currentRun.avgHeight =
          box.height > 5
            ? (currentRun.avgHeight + box.height) / 2
            : currentRun.avgHeight;
        currentRun.lastVisibleCharCode = charCode;
      }
    }

    if (currentRun) {
      this.#finalizeRun(currentRun, textSlices, getFontInfo);
    }

    return textSlices;
  }

  /**
   * Finalize a text run into a TextSlice
   * Includes trailing whitespace/control characters for accurate text reconstruction
   *
   * @param {Object} run - The text run to finalize
   * @param {TextSlice[]} textSlices - Array to push the slice to
   * @param {Function} getFontInfo - Function to get font info for a char index
   */
  #finalizeRun(run, textSlices, getFontInfo) {
    const visibleContent = run.chars.join("");
    const trailingContent = (run.trailingChars || []).join("");
    const content = visibleContent + trailingContent;

    if (!visibleContent || /^\s*$/.test(visibleContent)) return;

    const width = run.right - run.left;
    const height = run.avgHeight;

    if (width < 0 && height < 0) return;
    if (height > 100 || width > 200) return;

    const fontInfo = getFontInfo(run.startIndex);

    textSlices.push({
      content,
      rect: {
        origin: { x: run.left, y: run.top },
        size: { width, height },
      },
      font: {
        size: fontInfo.size || height,
        family: fontInfo.family,
      },
      // Store char indices for potential future use (selection, search highlighting)
      // _charRange: { start: run.startIndex, end: run.endIndex },
    });
  }

  /**
   * Extract font information for a character at a given position
   *
   * @param {number} textPagePtr - Text page pointer
   * @param {number} left - Left coordinate of the text rect
   * @param {number} top - Top coordinate of the text rect (PDF coordinates)
   * @param {number} rectHeight - Height of the rect (fallback for font size)
   * @returns {{size: number, family: string|null}}
   */
  #extractFontInfo(textPagePtr, left, top, rectHeight) {
    const pdfium = this.#pdfium;

    const charIndex = pdfium.FPDFText_GetCharIndexAtPos(
      textPagePtr,
      left,
      top,
      2,
      2,
    );

    if (charIndex < 0) {
      return { size: rectHeight, family: null };
    }

    const fontSize = pdfium.FPDFText_GetFontSize(textPagePtr, charIndex);

    const fontNameLength = pdfium.FPDFText_GetFontInfo(
      textPagePtr,
      charIndex,
      0, // null buffer
      0, // buffer size 0
      0, // flags pointer (not needed for length query)
    );

    if (fontNameLength <= 0) {
      return { size: fontSize || rectHeight, family: null };
    }

    const bytesCount = fontNameLength + 1;
    const textBufferPtr = pdfium.pdfium.wasmExports.malloc(bytesCount);
    const flagsPtr = pdfium.pdfium.wasmExports.malloc(4); // int32 for flags

    try {
      pdfium.FPDFText_GetFontInfo(
        textPagePtr,
        charIndex,
        textBufferPtr,
        bytesCount,
        flagsPtr,
      );

      // Font name is UTF-8 encoded
      const fontFamily = pdfium.pdfium.UTF8ToString(textBufferPtr);

      return {
        size: fontSize || rectHeight,
        family: fontFamily || null,
      };
    } finally {
      pdfium.pdfium.wasmExports.free(textBufferPtr);
      pdfium.pdfium.wasmExports.free(flagsPtr);
    }
  }
}

export class PdfiumDocumentHandle {
  #pdfium = null;
  #docPtr = null;
  #filePtr = null;
  #extractor = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   * @param {number} docPtr - Document pointer
   * @param {number} filePtr - File buffer pointer (for cleanup)
   */
  constructor(pdfiumModule, docPtr, filePtr) {
    this.#pdfium = pdfiumModule;
    this.#docPtr = docPtr;
    this.#filePtr = filePtr;
    this.#extractor = new PdfiumTextExtractor(pdfiumModule);
  }

  get pdfium() {
    return this.#pdfium;
  }

  get docPtr() {
    return this.#docPtr;
  }

  get extractor() {
    return this.#extractor;
  }

  /**
   * Extract text from a page
   * @param {number} pageIndex - 0-based page index
   * @returns {PageTextResult}
   */
  extractPageText(pageIndex) {
    return this.#extractor.extractPageText(this.#docPtr, pageIndex);
  }

  /**
   * Get page count
   * @returns {number}
   */
  getPageCount() {
    return this.#pdfium.FPDF_GetPageCount(this.#docPtr);
  }

  /**
   * Close the document and free resources
   */
  close() {
    if (this.#docPtr) {
      this.#pdfium.FPDF_CloseDocument(this.#docPtr);
      this.#docPtr = null;
    }
    if (this.#filePtr) {
      this.#pdfium.pdfium.wasmExports.free(this.#filePtr);
      this.#filePtr = null;
    }
  }
}

/**
 * Factory to create low-level document handles from PDF data
 *
 * Usage:
 *   const factory = new PdfiumDocumentFactory(pdfiumModule);
 *   const handle = factory.loadFromBuffer(pdfData);
 *   const text = handle.extractPageText(0);
 *   handle.close();
 */
export class PdfiumDocumentFactory {
  #pdfium = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#pdfium = pdfiumModule;
  }

  /**
   * Load document from a Uint8Array buffer
   * @param {Uint8Array} pdfData
   * @param {string} [password]
   * @returns {PdfiumDocumentHandle}
   */
  loadFromBuffer(pdfData, password = null) {
    const pdfium = this.#pdfium;

    // Allocate memory and copy PDF data
    const filePtr = pdfium.pdfium.wasmExports.malloc(pdfData.length);
    pdfium.pdfium.HEAPU8.set(pdfData, filePtr);

    // Load document
    const docPtr = pdfium.FPDF_LoadMemDocument(
      filePtr,
      pdfData.length,
      password ? password : 0,
    );

    if (!docPtr) {
      pdfium.pdfium.wasmExports.free(filePtr);
      const error = pdfium.FPDF_GetLastError();
      throw new Error(`Failed to load PDF: error code ${error}`);
    }

    return new PdfiumDocumentHandle(pdfium, docPtr, filePtr);
  }
}
