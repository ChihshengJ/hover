/**
 * Find text on a page with PDFium's own search (`FPDFText_FindStart`).
 *
 * A port of `@embedpdf/engines` 2.15's `searchInPage` with no match flags
 * (case-insensitive substring), as the search bar called it. Rects are the
 * engine's too, quirk included: each is the box of `FPDFText_GetRect`'s
 * corners in display space, with its width and height rounded up.
 */

import { readFrame, toDisplay } from "./page_frame.js";
import type { PdfiumDocument } from "./document.js";

/** One match: the rects covering it, in display space (top-left origin). */
export interface SearchMatch {
  /** Index of the first matched character on the page. */
  charIndex: number;
  charCount: number;
  rects: Rect[];
}

/**
 * Every match of `query` on the page, in reading order.
 *
 * @param index 0-based
 */
export function searchPage(
  document: PdfiumDocument,
  index: number,
  query: string,
): SearchMatch[] {
  if (!query) return [];
  const pdfium = document.pdfium;
  const ffi = document.ffi;

  const matches = document.withLoadedPage(index, (pagePtr) => {
    const textPage = pdfium.FPDFText_LoadPage(pagePtr);
    if (!textPage) return [];
    const frame = readFrame(document, pagePtr, index);
    try {
      return ffi.withWideString(query, (queryPtr) => {
        const search = pdfium.FPDFText_FindStart(textPage, queryPtr, 0, 0);
        if (!search) return [];
        const found: SearchMatch[] = [];
        try {
          while (pdfium.FPDFText_FindNext(search)) {
            const charIndex = pdfium.FPDFText_GetSchResultIndex(search);
            const charCount = pdfium.FPDFText_GetSchCount(search);
            found.push({
              charIndex,
              charCount,
              rects: matchRects(document, frame, textPage, charIndex, charCount),
            });
          }
        } finally {
          pdfium.FPDFText_FindClose(search);
        }
        return found;
      });
    } finally {
      pdfium.FPDFText_ClosePage(textPage);
    }
  });
  return matches ?? [];
}

function matchRects(
  document: PdfiumDocument,
  frame: ReturnType<typeof readFrame>,
  textPage: number,
  start: number,
  count: number,
): Rect[] {
  const pdfium = document.pdfium;
  const ffi = document.ffi;
  const rects: Rect[] = [];
  const n = pdfium.FPDFText_CountRects(textPage, start, count);
  for (let i = 0; i < n; i++) {
    const edges = ffi.readF64Out(4, (l, t, r, b) =>
      pdfium.FPDFText_GetRect(textPage, i, l, t, r, b),
    );
    if (!edges) continue;
    const [left, top, right, bottom] = edges;
    const corners = [
      toDisplay(frame, left, top),
      toDisplay(frame, right, top),
      toDisplay(frame, right, bottom),
      toDisplay(frame, left, bottom),
    ];
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    rects.push({
      x,
      y,
      width: Math.ceil(Math.max(...xs) - x),
      height: Math.ceil(Math.max(...ys) - y),
    });
  }
  return rects;
}
