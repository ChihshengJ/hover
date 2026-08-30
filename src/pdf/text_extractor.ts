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
import {
  groupCharsIntoRuns,
  isRuleLikeBounds,
} from "../analysis/layout_heuristics.js";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

/** One text run with its geometry and font, as DocumentTextIndex consumes it. */
export interface TextSlice {
  /** The text content, properly decoded from UTF-16LE. */
  content: string;
  /** Bounding rectangle, in a top-left coordinate system. */
  rect: {
    origin: Point;
    size: { width: number; height: number };
  };
  font?: {
    size: number;
    family: string | null;
  };
}

export interface PageTextResult {
  /** 0-based. */
  pageIndex: number;
  /** Complete page text. */
  fullText: string;
  /** Text slices with position information (matches getPageTextRects format). */
  textSlices: TextSlice[];
  /** Page width in PDF units. */
  pageWidth: number;
  /** Page height in PDF units. */
  pageHeight: number;
}

/** What `extractPagePaths()` reports for one page. */
export interface PagePathsResult {
  pageIndex: number;
  paths: PathObjectInfo[];
  pageWidth: number;
  pageHeight: number;
}

export class PdfiumTextExtractor {
  #reader: PdfiumPageReader = null;

  constructor(pdfiumModule: WrappedPdfiumModule) {
    this.#reader = new PdfiumPageReader(pdfiumModule);
  }

  get reader(): PdfiumPageReader {
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
   * @param pageIndex 0-based
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
    return this.#reader.withPage(docPtr, pageIndex, fn);
  }

  /** @param pageIndex 0-based */
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
    return this.#reader.withTextPage(docPtr, pageIndex, fn);
  }

  /**
   * Extract a UTF-16 text range from an already-opened text page.
   *
   */
  extractTextRange(
    textPagePtr: number,
    startIndex: number,
    count: number,
  ): string {
    return this.#reader.readText(textPagePtr, startIndex, count);
  }

  /**
   * Get bounding rects for a character range on an already-opened text page.
   * Returns rects in top-left origin coordinate system.
   *
   * @param pageHeight needed for Y-flip
   */
  getRectsForCharRange(
    textPagePtr: number,
    startCharIndex: number,
    charCount: number,
    pageHeight: number,
  ): Rect[] {
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
   * Extract a page's full text. Opens and closes the page automatically.
   *
   * Returned exactly as PDFium reports it, so index i is PDFium char index i —
   * callers feed match offsets straight back to getRectsForCharRange. Nothing
   * here may insert, drop, or combine characters, NFC normalisation included:
   * composing a base + combining mark shifts every index after it. Callers
   * doing index-free work (clipboard) normalise themselves.
   *
   * @param pageIndex 0-based
   */
  getPageFullText(
    docPtr: number,
    pageIndex: number,
  ): {
    fullText: string;
    charCount: number;
    pageWidth: number;
    pageHeight: number;
  } {
    const result = this.withTextPage(docPtr, pageIndex, (ctx) => {
      if (ctx.charCount <= 0) {
        return {
          fullText: "",
          charCount: 0,
          pageWidth: ctx.pageWidth,
          pageHeight: ctx.pageHeight,
        };
      }
      const fullText = this.#reader.readText(ctx.textPagePtr, 0, ctx.charCount);
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
   * @param pageIndex 0-based
   */
  getRectsForCharRangeOnPage(
    docPtr: number,
    pageIndex: number,
    startCharIndex: number,
    charCount: number,
  ): Rect[] {
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
   * @param pageIndex 0-based page index
   */
  extractPageText(docPtr: number, pageIndex: number): PageTextResult {
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
   * Extract the bounds of rule-like path objects on a page — the sole consumer
   * treats them as candidate header/footer separators, so the thickness test
   * lives here and callers only decide how much of the page a rule must span.
   *
   * @param pageIndex 0-based
   */
  extractPagePaths(docPtr: number, pageIndex: number): PagePathsResult {
    const result = this.withPage(
      docPtr,
      pageIndex,
      ({ pagePtr, pageWidth, pageHeight }) => {
        const paths: PathObjectInfo[] = [];
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
   * font. Font lookup stays here so the heuristics layer needs no reader.
   *
   */
  #buildTextSlices(textPagePtr: number, charCount: number): TextSlice[] {
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
  #pdfium: WrappedPdfiumModule = null;
  #docPtr: number = null;
  #filePtr: number = null;
  #extractor: PdfiumTextExtractor = null;

  /**
   * @param docPtr Document pointer
   * @param filePtr File buffer pointer, freed in close()
   */
  constructor(
    pdfiumModule: WrappedPdfiumModule,
    docPtr: number,
    filePtr: number,
  ) {
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
   * Extract text from a page.
   * @param pageIndex 0-based page index
   */
  extractPageText(pageIndex: number): PageTextResult {
    return this.#extractor.extractPageText(this.#docPtr, pageIndex);
  }

  /**
   * Extract path objects from a page.
   * @param pageIndex 0-based page index
   */
  extractPagePaths(pageIndex: number): PagePathsResult {
    return this.#extractor.extractPagePaths(this.#docPtr, pageIndex);
  }

  /** Get page count. */
  getPageCount(): number {
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
      this.#extractor.reader.ffi.free(this.#filePtr);
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
  #pdfium: WrappedPdfiumModule = null;

  /** Owns the file buffer allocation, which happens before a handle exists. */
  #ffi: PdfiumFFI = null;

  constructor(pdfiumModule: WrappedPdfiumModule) {
    this.#pdfium = pdfiumModule;
    this.#ffi = new PdfiumFFI(pdfiumModule);
  }

  /** Load document from a Uint8Array buffer. */
  loadFromBuffer(
    pdfData: Uint8Array,
    password: string | null = null,
  ): PdfiumDocumentHandle {
    const pdfium = this.#pdfium;

    // PDFium keeps referencing this buffer for the life of the document, so it
    // is owned by the handle and freed in close() rather than here.
    const filePtr = this.#ffi.allocBytes(pdfData);

    // PDFium takes a NUL pointer for "no password"; the binding types the
    // parameter as string, so the 0 has to be cast rather than passed through.
    const docPtr = pdfium.FPDF_LoadMemDocument(
      filePtr,
      pdfData.length,
      password ? password : (0 as unknown as string),
    );

    if (!docPtr) {
      this.#ffi.free(filePtr);
      const error = pdfium.FPDF_GetLastError();
      throw new Error(`Failed to load PDF: error code ${error}`);
    }

    return new PdfiumDocumentHandle(pdfium, docPtr, filePtr);
  }
}
