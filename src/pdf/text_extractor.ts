/**
 * Page text and path extraction, composed from two independent layers:
 *
 *   pdfium_reader.js      — faithful PDFium reads, no interpretation
 *   layout_heuristics.js  — word grouping and rule detection, no PDFium
 *
 * This file wires them together; `document.ts` owns the document lifecycle.
 * Behaviour that belongs to one of the two layers should be changed there,
 * not here.
 */

import { PdfiumPageReader } from "./pdfium_reader.js";
import {
  groupCharsIntoRuns,
  isRuleLikeBounds,
} from "../analysis/layout_heuristics.js";
import type { PdfiumBindings } from "./pdfium_module.js";

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
  /** Positioned text runs (`groupCharsIntoRuns`), with each run's font. */
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

  constructor(pdfium: PdfiumBindings) {
    this.#reader = new PdfiumPageReader(pdfium);
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
   * Extract a page's full text and its positioned slices (`TextSlice`),
   * decoded from UTF-16LE.
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

  /** Visible-text boxes for a 0-based page; empty when it won't load. */
  extractTextBoxes(docPtr: number, pageIndex: number): Float32Array {
    return (
      this.withTextPage(docPtr, pageIndex, ({ pagePtr, textPagePtr, charCount }) =>
        this.#reader.readVisibleTextBoxes(pagePtr, textPagePtr, charCount),
      ) ?? new Float32Array(0)
    );
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
