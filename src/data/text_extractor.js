/**
 * Page text and path extraction, composed from two independent layers:
 *
 *   pdfium_reader.js      — faithful PDFium reads, no interpretation
 *   layout_heuristics.js  — word grouping and rule detection, no PDFium
 *
 * This file wires them together and owns the document lifecycle. Behaviour that
 * belongs to one of the two layers should be changed there, not here.
 */

import { PdfiumFFI } from "./pdfium_ffi.js";
import { PdfiumPageReader } from "./pdfium_reader.js";
import { groupCharsIntoRuns, isRuleLikeBounds } from "./layout_heuristics.js";

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
  /** @type {PdfiumPageReader} */
  #reader = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   */
  constructor(pdfiumModule) {
    this.#reader = new PdfiumPageReader(pdfiumModule);
  }

  /** @returns {PdfiumPageReader} */
  get reader() {
    return this.#reader;
  }

  /**
   * Release WASM scratch memory held by this extractor.
   */
  dispose() {
    this.#reader.dispose();
  }

  // ============================================================================
  // Core low-level helpers (shared by all consumers)
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
    return this.#reader.withPage(docPtr, pageIndex, fn);
  }

  /**
   * @param {number} docPtr
   * @param {number} pageIndex - 0-based
   * @param {(ctx: {pagePtr: number, textPagePtr: number, pageWidth: number, pageHeight: number, charCount: number}) => T} fn
   * @returns {T|null}
   * @template T
   */
  withTextPage(docPtr, pageIndex, fn) {
    return this.#reader.withTextPage(docPtr, pageIndex, fn);
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
    return this.#reader.readText(textPagePtr, startIndex, count);
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
    return this.#reader.readTextRects(
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
      const fullText = this.#reader
        .readText(ctx.textPagePtr, 0, ctx.charCount)
        .normalize("NFC");
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
    const result = this.withTextPage(docPtr, pageIndex, (ctx) =>
      this.#reader.readTextRects(
        ctx.textPagePtr,
        startCharIndex,
        charCount,
        ctx.pageHeight,
      ),
    );
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

      const fullText = this.#reader.readText(ctx.textPagePtr, 0, ctx.charCount);
      const textSlices = this.#buildTextSlices(ctx.textPagePtr, ctx.charCount);

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
   * Extract the bounds of rule-like path objects on a page.
   *
   * Consumers use these as candidate header/footer separators, so path objects
   * that do not read as rules are dropped here rather than by the caller.
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
        const paths = [];
        for (const bounds of this.#reader.readPathBounds(pagePtr)) {
          const width = bounds.right - bounds.left;
          const height = bounds.top - bounds.bottom;
          if (!isRuleLikeBounds(width, height)) continue;

          paths.push({
            index: paths.length,
            pdfRect: bounds,
            screenRect: {
              x: bounds.left,
              y: pageHeight - bounds.top,
              width,
              height,
            },
          });
        }
        return { pageIndex, paths, pageWidth, pageHeight };
      },
    );
    return result || { pageIndex, paths: [], pageWidth: 0, pageHeight: 0 };
  }

  // ============================================================================
  // Composition
  // ============================================================================

  /**
   * Read a page's characters, group them into runs, and resolve each run's
   * font. Font lookup stays here because it is one PDFium call per run, which
   * would otherwise force the heuristics layer to depend on the reader.
   *
   * @param {number} textPagePtr
   * @param {number} charCount
   * @returns {TextSlice[]}
   */
  #buildTextSlices(textPagePtr, charCount) {
    const chars = this.#reader.readChars(textPagePtr, charCount);
    const runs = groupCharsIntoRuns(chars);

    return runs.map((run) => {
      const font = this.#reader.readFontInfo(textPagePtr, run.startIndex);
      return {
        content: run.content,
        rect: {
          origin: { x: run.left, y: run.top },
          size: { width: run.width, height: run.height },
        },
        font: {
          size: font.size || run.height,
          family: font.family,
        },
      };
    });
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
