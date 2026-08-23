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
import type { PdfiumDocumentHandle } from "./text_extractor.js";
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject } from "@embedpdf/models";

/**
 * Page geometry + glyph slices for `DocumentTextIndex`.
 *
 * `lowLevelHandle` is the fast path (direct FFI, no engine round-trip). When it
 * is missing — the factory threw during load — the engine's `getPageTextRects`
 * still answers, just asynchronously and without path objects.
 */
export function createPdfPageSource({
  pdfDoc,
  native,
  lowLevelHandle,
}: {
  pdfDoc: PdfDocumentObject | null;
  native: PdfiumNative | null;
  lowLevelHandle: PdfiumDocumentHandle | null;
}): PageSource {
  const pageAt = (pageNumber: number) =>
    pdfDoc?.pages?.[pageNumber - 1] || null;

  return {
    get numPages() {
      return pdfDoc?.pages?.length || 0;
    },

    getPageSize(pageNumber: number) {
      const page = pageAt(pageNumber);
      if (!page) return null;
      return { width: page.size.width, height: page.size.height };
    },

    async getPageTextSlices(pageNumber: number) {
      if (lowLevelHandle) {
        const result = lowLevelHandle.extractPageText(pageNumber - 1);
        return result.textSlices || [];
      }
      const page = pageAt(pageNumber);
      if (!native || !pdfDoc || !page) return [];
      return await native.getPageTextRects(pdfDoc, page).toPromise();
    },

    getPagePaths(pageNumber: number): PathObjectInfo[] {
      if (!lowLevelHandle) return [];
      try {
        return lowLevelHandle.extractPagePaths(pageNumber - 1).paths || [];
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
  handle: PdfiumDocumentHandle,
): RawPageTextSource {
  const extractor = handle.extractor;
  const docPtr = handle.docPtr;

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
