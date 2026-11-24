/**
 * Outline, destination and action reads: `PdfBookmark`, `PdfDestination` and
 * `PdfAction` from PDFium's fpdf_doc.h.
 *
 * Ported from `@embedpdf/engines` 2.15 (`readPdfBookmarks`,
 * `readPdfDestination`, `readPdfAction`) so the output is the same object, key
 * order included: `scripts/build_fixtures.ts` serialises bookmarks into the
 * analysis fixtures, and `test/engine/document.test.ts` holds the engine's
 * output as the baseline. Where this differs, it says so.
 */

import type { PdfiumFFI } from "./pdfium_ffi.js";

/** PDFium's `PDFDEST_VIEW_XYZ`. */
const VIEW_XYZ = 1;

/** PDFium's `PDFACTION_*`. */
const ACTION = {
  UNSUPPORTED: 0,
  GOTO: 1,
  REMOTEGOTO: 2,
  URI: 3,
  LAUNCH: 4,
} as const;

/**
 * Read a string through PDFium's "call with a null buffer for the length,
 * then again with a buffer" convention. Empty when PDFium reports nothing.
 */
function readString(
  ffi: PdfiumFFI,
  read: (buffer: number, length: number) => number,
  decode: (ptr: number) => string,
): string {
  const length = read(0, 0);
  if (length <= 0) return "";
  return ffi.withBuffer(length, (buffer) => {
    ffi.pdfium.HEAPU8.fill(0, buffer, buffer + length);
    read(buffer, length);
    return decode(buffer);
  });
}

export function readDestination(
  ffi: PdfiumFFI,
  docPtr: number,
  destPtr: number,
): PdfDestination {
  const pdfium = ffi.pdfium;
  const pageIndex = pdfium.FPDFDest_GetDestPageIndex(docPtr, destPtr);

  return ffi.frame(() => {
    const [countPtr] = ffi.slots(1, 4);
    const paramPtrs = ffi.slots(4, 4);
    const mode = pdfium.FPDFDest_GetView(destPtr, countPtr, paramPtrs[0]);
    const count = ffi.u32(countPtr);
    const view: number[] = [];
    for (let i = 0; i < count; i++) view.push(ffi.f32(paramPtrs[i]));

    if (mode !== VIEW_XYZ) return { pageIndex, zoom: { mode }, view };

    // The engine reads the three flags as i8 out of 1-byte buffers; PDFium
    // writes an FPDF_BOOL (i32) there. Same value, without the overrun.
    const [hasX, hasY, hasZoom] = ffi.slots(3, 4);
    const [x, y, zoom] = ffi.slots(3, 4);
    const params = pdfium.FPDFDest_GetLocationInPage(
      destPtr,
      hasX,
      hasY,
      hasZoom,
      x,
      y,
      zoom,
    )
      ? {
          x: ffi.i32(hasX) ? ffi.f32(x) : 0,
          y: ffi.i32(hasY) ? ffi.f32(y) : 0,
          zoom: ffi.i32(hasZoom) ? ffi.f32(zoom) : 0,
        }
      : { x: 0, y: 0, zoom: 0 };
    return { pageIndex, zoom: { mode, params }, view };
  });
}

/**
 * Undefined for an action type the engine has no case for (embedded go-to,
 * JavaScript, …), as the engine does.
 */
export function readAction(
  ffi: PdfiumFFI,
  docPtr: number,
  actionPtr: number,
): PdfAction | undefined {
  const pdfium = ffi.pdfium;
  switch (pdfium.FPDFAction_GetType(actionPtr)) {
    case ACTION.UNSUPPORTED:
    case ACTION.REMOTEGOTO:
      return { type: ACTION.UNSUPPORTED };
    case ACTION.GOTO: {
      const destPtr = pdfium.FPDFAction_GetDest(docPtr, actionPtr);
      return destPtr
        ? {
            type: ACTION.GOTO,
            destination: readDestination(ffi, docPtr, destPtr),
          }
        : { type: ACTION.UNSUPPORTED };
    }
    case ACTION.URI:
      return {
        type: ACTION.URI,
        uri: readString(
          ffi,
          (buf, len) => pdfium.FPDFAction_GetURIPath(docPtr, actionPtr, buf, len),
          (ptr) => ffi.utf8(ptr),
        ),
      };
    case ACTION.LAUNCH:
      return {
        type: ACTION.LAUNCH,
        path: readString(
          ffi,
          (buf, len) => pdfium.FPDFAction_GetFilePath(actionPtr, buf, len),
          (ptr) => ffi.utf8(ptr),
        ),
      };
    default:
      return undefined;
  }
}

/** A bookmark's target: its action if it has one, else its destination. */
function readBookmarkTarget(
  ffi: PdfiumFFI,
  docPtr: number,
  bookmarkPtr: number,
): PdfLinkTarget | undefined {
  const pdfium = ffi.pdfium;
  const actionPtr = pdfium.FPDFBookmark_GetAction(bookmarkPtr);
  if (actionPtr) {
    return { type: "action", action: readAction(ffi, docPtr, actionPtr) };
  }
  const destPtr = pdfium.FPDFBookmark_GetDest(docPtr, bookmarkPtr);
  if (destPtr) {
    return {
      type: "destination",
      destination: readDestination(ffi, docPtr, destPtr),
    };
  }
  return undefined;
}

/**
 * The outline under `parentPtr` (0 for the root), depth first.
 *
 * Unlike the engine, this tracks the bookmarks it has visited: an outline
 * whose `/Next` or `/First` points back into itself ends the walk there
 * instead of hanging the tab.
 */
export function readBookmarks(
  ffi: PdfiumFFI,
  docPtr: number,
  parentPtr = 0,
  seen = new Set<number>(),
): PdfBookmark[] {
  const pdfium = ffi.pdfium;
  const bookmarks: PdfBookmark[] = [];
  let ptr = pdfium.FPDFBookmark_GetFirstChild(docPtr, parentPtr);
  while (ptr && !seen.has(ptr)) {
    seen.add(ptr);
    const bookmarkPtr = ptr;
    const title = readString(
      ffi,
      (buf, len) => pdfium.FPDFBookmark_GetTitle(bookmarkPtr, buf, len),
      (p) => ffi.utf16(p),
    );
    // Children before the target, and keys in this order, as the engine does.
    const children = readBookmarks(ffi, docPtr, bookmarkPtr, seen);
    const target = readBookmarkTarget(ffi, docPtr, bookmarkPtr);
    bookmarks.push({ title, target, children });
    ptr = pdfium.FPDFBookmark_GetNextSibling(docPtr, bookmarkPtr);
  }
  return bookmarks;
}
