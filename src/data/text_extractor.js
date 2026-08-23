import { PAGEOBJ, PdfiumFFI } from "./pdfium_ffi.js";

/**
 * Unicode space separators, which PDFium emits alongside plain U+0020.
 *
 * PDFium's text layer changed in pdfium 2.6.1 (chromium/7689): it now reports
 * the document's real space characters — NBSP, EN/EM/THIN/HAIR spaces — where
 * it previously normalised them to U+0020 or dropped them. They carry no ink
 * and report zero-area character boxes, so they must be classified as
 * whitespace; treating them as visible glyphs pulls a run's right edge out to
 * the following word and corrupts every width derived from it.
 *
 * @param {number} code
 * @returns {boolean}
 */
const isUnicodeSpace = (code) =>
  code === 0x20 || // SPACE
  code === 0xa0 || // NO-BREAK SPACE
  code === 0x1680 || // OGHAM SPACE MARK
  (code >= 0x2000 && code <= 0x200a) || // EN QUAD … HAIR SPACE
  code === 0x202f || // NARROW NO-BREAK SPACE
  code === 0x205f || // MEDIUM MATHEMATICAL SPACE
  code === 0x3000; // IDEOGRAPHIC SPACE

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

  /** @type {PdfiumFFI} */
  #ffi = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#pdfium = pdfiumModule;
    this.#ffi = new PdfiumFFI(pdfiumModule);
  }

  /**
   * Release WASM scratch memory held by this extractor.
   */
  dispose() {
    this.#ffi.dispose();
  }

  // ============================================================================
  // Core low-level WASM helpers (shared by all consumers)
  // ============================================================================

  /**
   * Open a page without creating a text page (for object-level operations).
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, pageWidth: number, pageHeight: number}) => T} fn
   * @returns {T|null}
   * @template T
   */
  withPage(docPtr, pageIndex, fn) {
    return this.#ffi.withPage(docPtr, pageIndex, fn);
  }

  /**
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, textPagePtr: number, pageWidth: number, pageHeight: number, charCount: number}) => T} fn
   * @returns {T|null}
   * @template T
   */
  withTextPage(docPtr, pageIndex, fn) {
    return this.#ffi.withTextPage(docPtr, pageIndex, fn);
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
  // High-level path extraction (general-purpose)
  // ============================================================================

  /**
   * @typedef {Object} PathObjectInfo
   * @property {number} index - Sequential index among path objects on the page
   * @property {{left: number, bottom: number, right: number, top: number}} pdfRect - PDF native coords (bottom-left origin)
   * @property {{x: number, y: number, width: number, height: number}} screenRect - Top-left origin coords
   */

  /**
   * Extract all path object bounds from a page.
   *
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @returns {{pageIndex: number, paths: PathObjectInfo[], pageWidth: number, pageHeight: number}}
   */
  extractPagePaths(docPtr, pageIndex) {
    const result = this.withPage(
      docPtr,
      pageIndex,
      ({ pagePtr, pageWidth, pageHeight }) => {
        const paths = this.#collectPathObjects(pagePtr, false, pageHeight);
        return { pageIndex, paths, pageWidth, pageHeight };
      },
    );
    return result || { pageIndex, paths: [], pageWidth: 0, pageHeight: 0 };
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

    for (let i = 0; i < rectCount; i++) {
      const box = this.#ffi.readF64Out(4, (l, t, r, b) =>
        pdfium.FPDFText_GetRect(textPagePtr, i, l, t, r, b),
      );
      if (!box) continue;

      const [left, top, right, bottom] = box;
      rects.push({
        x: left,
        y: pageHeight - top,
        width: right - left,
        height: top - bottom,
      });
    }

    return rects;
  }

  /**
   * @param {number} textPagePtr - Text page pointer
   * @param {number} startIndex - Starting character index
   * @param {number} count - Number of characters to extract
   * @returns {string}
   */
  #extractTextRange(textPagePtr, startIndex, count) {
    if (count <= 0) return "";

    const pdfium = this.#pdfium;

    // FPDFText_GetText writes at most `count` UTF-16 units plus a NUL, so the
    // buffer is sized count + 1 and UTF16ToString has a terminator to stop at.
    //
    // This is deliberately not upstream's approach. @embedpdf/engines decodes
    // via FPDFText_GetBoundedText, which does NOT write a terminator when
    // buflen equals the text length — it allocates (len + 1) * 2 bytes but
    // passes len as buflen, so UTF16ToString runs off the end into whatever the
    // allocator last left there. Measured on our own sample PDFs, that
    // over-reads on 100% of text rects. Keep this path.
    return this.#ffi.withBuffer((count + 1) * 2, (bufPtr) => {
      const extractedLength = pdfium.FPDFText_GetText(
        textPagePtr,
        startIndex,
        count,
        bufPtr,
      );
      return extractedLength > 0 ? this.#ffi.utf16(bufPtr) : "";
    });
  }

  /**
   * Character bounding box in PDF coordinates (bottom-left origin).
   *
   * Called once per character, so it goes through the scratch frame rather than
   * malloc'ing four doubles per call.
   *
   * @param {number} textPagePtr
   * @param {number} charIndex
   * @returns {{left: number, top: number, right: number, bottom: number, x: number, y: number, width: number, height: number}|null}
   */
  #getCharBox(textPagePtr, charIndex) {
    const pdfium = this.#pdfium;

    const box = this.#ffi.readF64Out(4, (l, r, b, t) =>
      pdfium.FPDFText_GetCharBox(textPagePtr, charIndex, l, r, b, t),
    );
    if (!box) return null;

    const [left, right, bottom, top] = box;
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
  }

  /**
   * Recursively collect line-like path object bounds from a page or form object.
   *
   * Consumers use these as candidate header/footer rules, so the filter is on
   * bounds rather than on segment structure: rules are drawn both as two-segment
   * strokes and as very thin filled rectangles, and the latter would be lost by
   * a MOVETO+LINETO test.
   *
   * @param {number} containerPtr - Page or form object pointer
   * @param {boolean} isForm - Whether containerPtr is a form object
   * @param {number} pageHeight - For coordinate conversion
   * @returns {PathObjectInfo[]}
   */
  #collectPathObjects(containerPtr, isForm, pageHeight) {
    const pdfium = this.#pdfium;
    const paths = [];

    const count = isForm
      ? pdfium.FPDFFormObj_CountObjects(containerPtr)
      : pdfium.FPDFPage_CountObjects(containerPtr);

    for (let i = 0; i < count; i++) {
      const objPtr = isForm
        ? pdfium.FPDFFormObj_GetObject(containerPtr, i)
        : pdfium.FPDFPage_GetObject(containerPtr, i);
      if (!objPtr) continue;

      const type = pdfium.FPDFPageObj_GetType(objPtr);

      if (type === PAGEOBJ.FORM) {
        const nested = this.#collectPathObjects(objPtr, true, pageHeight);
        for (let j = 0; j < nested.length; j++) paths.push(nested[j]);
        continue;
      }
      if (type !== PAGEOBJ.PATH) continue;

      const bounds = this.#getPathBounds(objPtr);
      if (!bounds) continue;

      const h = bounds.top - bounds.bottom;
      const w = bounds.right - bounds.left;
      const isLinelikeBounds = (h < 3 && w > 20) || (w < 3 && h > 20);
      if (!isLinelikeBounds) continue;

      paths.push({
        index: paths.length,
        pdfRect: bounds,
        screenRect: {
          x: bounds.left,
          y: pageHeight - bounds.top,
          width: w,
          height: h,
        },
      });
    }
    return paths;
  }

  /**
   * Get bounding box of a path object via FPDFPageObj_GetBounds.
   *
   * @param {number} objPtr
   * @returns {{left: number, bottom: number, right: number, top: number}|null}
   */
  #getPathBounds(objPtr) {
    const pdfium = this.#pdfium;

    const bounds = this.#ffi.readF32Out(4, (l, b, r, t) =>
      pdfium.FPDFPageObj_GetBounds(objPtr, l, b, r, t),
    );
    if (!bounds) return null;

    const [left, bottom, right, top] = bounds;
    return { left, bottom, right, top };
  }

  /**
   * Extract text slices grouped by words/text runs instead of individual characters.
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
      const box = this.#getCharBox(textPagePtr, i);

      const isWhitespace = isUnicodeSpace(charCode);
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

    const isCJK = (code) =>
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
      (code >= 0xac00 && code <= 0xd7af); // Hangul Syllables

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
            this.#finalizeRun(currentRun, textSlices, textPagePtr);
            currentRun = null;
          }
        }
        // If no current run, skip leading whitespace (will be captured by fullText)
        continue;
      }

      // Zero-area boxes are not renderable. PDFium reports them for markers
      // like U+00AD and for the occasional collapsed glyph, and letting one
      // into a run drags the run's bounding box to wherever it sits.
      if (box.width <= 0 || box.height <= 0) continue;
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
          maxHeight: box.height,
          lastVisibleCharCode: charCode,
        };
        continue;
      }

      const sameLine =
        Math.abs(box.bottom - currentRun.bottom) <
        currentRun.maxHeight * LINE_TOLERANCE_FACTOR;
      const gapThreshold = currentRun.maxHeight * WORD_GAP_FACTOR;
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

      // Break runs between punctuation and digits to prevent body-text
      // punctuation (with full-size height) from being grouped with
      // superscript numbers, which would inflate avgHeight and prevent
      // superscript detection downstream.
      const isPunct = (c) => c === 44 || c === 46 || c === 59 || c === 58; // , . ; :
      const punctuationDigitBoundary =
        (isDigit && isPunct(lastCode)) || (lastIsDigit && isPunct(charCode));

      // CJK characters have no word separators — break at every character
      // boundary to keep runs small (prevents width-based filtering from
      // dropping entire lines, and enables per-character text selection).
      const cjkBoundary = isCJK(charCode) || isCJK(lastCode);

      if (
        hasTrailingWhitespace ||
        !sameLine ||
        !isAdjacent ||
        digitAlphaBoundary ||
        punctuationDigitBoundary ||
        cjkBoundary
      ) {
        this.#finalizeRun(currentRun, textSlices, textPagePtr);
        currentRun = {
          startIndex: i,
          endIndex: i,
          chars: [char],
          trailingChars: [],
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          maxHeight: box.height,
          lastVisibleCharCode: charCode,
        };
      } else {
        currentRun.endIndex = i;
        currentRun.chars.push(char);
        currentRun.right = Math.max(currentRun.right, box.right);
        currentRun.bottom = Math.min(currentRun.bottom, box.bottom);
        currentRun.top = Math.max(currentRun.top, box.top);
        if (box.height > 5) {
          currentRun.maxHeight = Math.max(currentRun.maxHeight, box.height);
        }
        currentRun.lastVisibleCharCode = charCode;
      }
    }

    if (currentRun) {
      this.#finalizeRun(currentRun, textSlices, textPagePtr);
    }

    return textSlices;
  }

  /**
   * Finalize a text run into a TextSlice
   * Includes trailing whitespace/control characters for accurate text reconstruction
   *
   * @param {Object} run - The text run to finalize
   * @param {TextSlice[]} textSlices - Array to push the slice to
   * @param {number} textPagePtr - Text page the run came from, for font lookup
   */
  #finalizeRun(run, textSlices, textPagePtr) {
    const visibleContent = run.chars.join("");
    const trailingContent = (run.trailingChars || []).join("");
    const content = visibleContent + trailingContent;

    if (!visibleContent || /^\s*$/.test(visibleContent)) return;

    const width = run.right - run.left;
    const height = run.maxHeight;

    if (width <= 0 || height <= 0) return;
    if (height > 100) return;

    const fontInfo = this.#getFontInfo(textPagePtr, run.startIndex);

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
   * Font size and family for the character at `charIndex`.
   *
   * @param {number} textPagePtr - Text page pointer
   * @param {number} charIndex - 0-based character index on that text page
   * @returns {{size: number, family: string|null}}
   */
  #getFontInfo(textPagePtr, charIndex) {
    const pdfium = this.#pdfium;
    const size = pdfium.FPDFText_GetFontSize(textPagePtr, charIndex);

    // Length query: null buffer, zero size, no flags pointer.
    const nameLength = pdfium.FPDFText_GetFontInfo(
      textPagePtr,
      charIndex,
      0,
      0,
      0,
    );
    if (nameLength <= 0) return { size, family: null };

    const bytesCount = nameLength + 1;
    return this.#ffi.withBuffer(bytesCount, (namePtr) =>
      this.#ffi.frame(() => {
        const [flagsPtr] = this.#ffi.slots(1, 4);
        pdfium.FPDFText_GetFontInfo(
          textPagePtr,
          charIndex,
          namePtr,
          bytesCount,
          flagsPtr,
        );
        // Font name is UTF-8 encoded.
        return { size, family: this.#ffi.utf8(namePtr) || null };
      }),
    );
  }
}

export class PdfiumDocumentHandle {
  #pdfium = null;
  #ffi = null;
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
    this.#ffi = new PdfiumFFI(pdfiumModule);
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
   * Extract path objects from a page
   * @param {number} pageIndex - 0-based page index
   * @returns {{pageIndex: number, paths: PathObjectInfo[], pageWidth: number, pageHeight: number}}
   */
  extractPagePaths(pageIndex) {
    return this.#extractor.extractPagePaths(this.#docPtr, pageIndex);
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
      this.#ffi.free(this.#filePtr);
      this.#filePtr = null;
    }
    this.#extractor.dispose();
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
  #ffi = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#pdfium = pdfiumModule;
    this.#ffi = new PdfiumFFI(pdfiumModule);
  }

  /**
   * Load document from a Uint8Array buffer
   * @param {Uint8Array} pdfData
   * @param {string} [password]
   * @returns {PdfiumDocumentHandle}
   */
  loadFromBuffer(pdfData, password = null) {
    const pdfium = this.#pdfium;

    // PDFium keeps referencing this buffer for the life of the document, so it
    // is owned by the handle and freed in close() rather than here.
    const filePtr = this.#ffi.allocBytes(pdfData);

    const docPtr = pdfium.FPDF_LoadMemDocument(
      filePtr,
      pdfData.length,
      password ? password : 0,
    );

    if (!docPtr) {
      this.#ffi.free(filePtr);
      const error = pdfium.FPDF_GetLastError();
      throw new Error(`Failed to load PDF: error code ${error}`);
    }

    return new PdfiumDocumentHandle(pdfium, docPtr, filePtr);
  }
}
