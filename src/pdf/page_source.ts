/**
 * PDFium-backed implementations of the two source interfaces `src/analysis/`
 * declares.
 *
 * The analysis layer never names PDFium: `DocumentTextIndex` asks a
 * `PageSource` for page geometry and glyph slices, and `InlineExtractor` asks a
 * `RawPageTextSource` for page text and char rects. This file is the only place
 * where those questions become PDFium calls, which is what lets the whole
 * reference/citation engine run in Node against a serialized fixture.
 *
 */

import type { PageSource } from "../analysis/text_index.js";
import type { RawPageTextSource } from "../analysis/inline_extractor.js";
import type { PdfiumDocument } from "./document.js";

/** Page geometry + glyph slices for `DocumentTextIndex`. */
export function createPdfPageSource({
  document,
}: {
  document: PdfiumDocument;
}): PageSource {
  return {
    get numPages() {
      return document.pageCount;
    },

    getPageSize(pageNumber: number) {
      const page = document.page(pageNumber - 1);
      if (!page) return null;
      return { width: page.size.width, height: page.size.height };
    },

    async getPageTextSlices(pageNumber: number) {
      return document.extractPageText(pageNumber - 1).textSlices || [];
    },

    getPagePaths(pageNumber: number): PathObjectInfo[] {
      try {
        return document.extractPagePaths(pageNumber - 1).paths || [];
      } catch (_) {
        // Path extraction is best-effort — a page with no content stream still
        // has to index its text.
        return [];
      }
    },
  };
}

/**
 * Raw page text + char rects for `InlineExtractor`'s adapter.
 *
 * Indices are PDFium's own: index i in `fullText` is PDFium char i, so a match
 * offset feeds straight back into `getRectsForCharRange`. The adapter layers
 * marker-stripping on top and maps indices back before calling here.
 */
export function createRawPageTextSource(
  document: PdfiumDocument,
): RawPageTextSource {
  const extractor = document.extractor;
  const docPtr = document.docPtr;

  return {
    getPageFullText: (pageIndex: number) =>
      extractor.getPageFullText(docPtr, pageIndex),
    getRectsForCharRange: (
      pageIndex: number,
      startCharIndex: number,
      charCount: number,
    ) =>
      extractor.getRectsForCharRangeOnPage(
        docPtr,
        pageIndex,
        startCharIndex,
        charCount,
      ),
  };
}
