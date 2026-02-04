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

  /**
   * Extract text from a page with proper UTF-16LE handling
   * Returns data in a format compatible with getPageTextRects
   *
   * @param {number} docPtr - Document pointer
   * @param {number} pageIndex - 0-based page index
   * @returns {PageTextResult}
   */
  extractPageText(docPtr, pageIndex) {
    const pdfium = this.#pdfium;

    // Load the page
    const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
    if (!pagePtr) {
      throw new Error(`Failed to load page ${pageIndex}`);
    }

    try {
      const pageWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
      const pageHeight = pdfium.FPDF_GetPageHeightF(pagePtr);

      const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) {
        return {
          pageIndex,
          fullText: "",
          textSlices: [],
          pageWidth,
          pageHeight,
        };
      }

      try {
        const charCount = pdfium.FPDFText_CountChars(textPagePtr);
        if (charCount <= 0) {
          return {
            pageIndex,
            fullText: "",
            textSlices: [],
            pageWidth,
            pageHeight,
          };
        }

        const fullText = this.#extractTextRange(textPagePtr, 0, charCount);

        const textSlices = this.#extractTextSlices(
          textPagePtr,
          charCount,
          pageHeight,
        );

        return {
          pageIndex,
          fullText,
          textSlices,
          pageWidth,
          pageHeight,
        };
      } finally {
        pdfium.FPDFText_ClosePage(textPagePtr);
      }
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
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
   * Extract text slices with bounding rectangles
   *
   * @param {number} textPagePtr - Text page pointer
   * @param {number} totalChars - Total character count
   * @param {number} pageHeight - Page height for Y coordinate conversion
   * @returns {TextSlice[]}
   */
  #extractTextSlices(textPagePtr, totalChars, pageHeight) {
    const pdfium = this.#pdfium;
    const textSlices = [];

    // Get the count of text rectangles
    const rectCount = pdfium.FPDFText_CountRects(textPagePtr, 0, totalChars);

    if (rectCount <= 0) {
      return textSlices;
    }

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

        // Get text within this rectangle
        const content = this.#extractBoundedText(
          textPagePtr,
          left,
          top,
          right,
          bottom,
        );

        if (content && content.trim()) {
          const height = top - bottom;
          const y = pageHeight - top;

          const fontInfo = this.#extractFontInfo(
            textPagePtr,
            left,
            top,
            height,
          );

          textSlices.push({
            content,
            rect: {
              origin: { x: left, y },
              size: { width: right - left, height },
            },
            font: {
              size: fontInfo.size,
              family: fontInfo.family,
            },
          });
        }
      }
    } finally {
      pdfium.pdfium.wasmExports.free(leftPtr);
      pdfium.pdfium.wasmExports.free(topPtr);
      pdfium.pdfium.wasmExports.free(rightPtr);
      pdfium.pdfium.wasmExports.free(bottomPtr);
    }

    return textSlices;
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

  /**
   * Extract text within a bounding rectangle
   *
   * @param {number} textPagePtr - Text page pointer
   * @param {number} left - Left bound
   * @param {number} top - Top bound (PDF coordinates)
   * @param {number} right - Right bound
   * @param {number} bottom - Bottom bound (PDF coordinates)
   * @returns {string}
   */
  #extractBoundedText(textPagePtr, left, top, right, bottom) {
    const pdfium = this.#pdfium;

    // First get the required buffer size
    const charCount = pdfium.FPDFText_GetBoundedText(
      textPagePtr,
      left,
      top,
      right,
      bottom,
      0, // null buffer to get count
      0,
    );

    if (charCount <= 0) return "";

    // Allocate buffer (UTF-16 = 2 bytes per char)
    const bufferSize = (charCount + 1) * 2;
    const bufferPtr = pdfium.pdfium.wasmExports.malloc(bufferSize);

    try {
      pdfium.FPDFText_GetBoundedText(
        textPagePtr,
        left,
        top,
        right,
        bottom,
        bufferPtr,
        charCount + 1,
      );

      // Convert UTF-16LE to JS string
      return pdfium.pdfium.UTF16ToString(bufferPtr);
    } finally {
      pdfium.pdfium.wasmExports.free(bufferPtr);
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
