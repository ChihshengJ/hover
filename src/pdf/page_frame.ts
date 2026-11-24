/**
 * Mapping between a page's PDF space and the top-left "display" space the
 * app works in: page points, measured from the crop box, with the page's
 * `/Rotate` applied. Ported from `@embedpdf/engines` 2.15
 * (`convertPagePointToDevicePoint` and its inverse), so annotations Hover
 * writes land where the engine put them.
 */

import type { PdfiumDocument } from "./document.js";
import type { PdfiumFFI } from "./pdfium_ffi.js";

export interface PageFrame {
  /** The page as displayed, `/Rotate` applied. */
  width: number;
  height: number;
  /** Quarter turns, 0–3. */
  rotation: number;
  /** The crop box's lower-left corner in PDF space. */
  originX: number;
  originY: number;
}

/** Read a loaded page's frame. */
export function readFrame(
  document: PdfiumDocument,
  pagePtr: number,
  index: number,
): PageFrame {
  const pdfium = document.pdfium;
  const ffi = document.ffi;
  const box =
    ffi.readF32Out(4, (l, b, r, t) =>
      pdfium.FPDFPage_GetCropBox(pagePtr, l, b, r, t),
    ) ??
    ffi.readF32Out(4, (l, b, r, t) =>
      pdfium.FPDFPage_GetMediaBox(pagePtr, l, b, r, t),
    );
  const { width, height } = document.page(index)!.size;
  return {
    width,
    height,
    rotation: pdfium.FPDFPage_GetRotation(pagePtr),
    originX: box?.[0] ?? 0,
    originY: box?.[1] ?? 0,
  };
}

/** PDF space → display space. */
export function toDisplay(frame: PageFrame, x: number, y: number): Point {
  const px = x - frame.originX;
  const py = y - frame.originY;
  switch (frame.rotation & 3) {
    case 0:
      return { x: px, y: frame.height - py };
    case 1:
      return { x: py, y: px };
    case 2:
      return { x: frame.width - px, y: py };
    default:
      return { x: frame.width - py, y: frame.height - px };
  }
}

/** Display space → PDF space; the inverse of `toDisplay`. */
export function fromDisplay(frame: PageFrame, x: number, y: number): Point {
  let px: number;
  let py: number;
  switch (frame.rotation & 3) {
    case 0:
      px = x;
      py = frame.height - y;
      break;
    case 1:
      px = y;
      py = x;
      break;
    case 2:
      px = frame.width - x;
      py = y;
      break;
    default:
      px = frame.height - y;
      py = frame.width - x;
  }
  return { x: px + frame.originX, y: py + frame.originY };
}

/** The bounding box of some points. */
export function boxAround(points: Point[]): PdfBox {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    origin: { x, y },
    size: { width: Math.max(...xs) - x, height: Math.max(...ys) - y },
  };
}

/**
 * An annotation's `/Rect` in display space. The engine places the origin at
 * the rect's left and top as written and takes absolute sizes; this does the
 * same after putting the edges in order.
 */
export function readRect(ffi: PdfiumFFI, frame: PageFrame, annot: number): PdfBox {
  const edges = ffi.readF32Out(4, (rect) =>
    ffi.pdfium.FPDFAnnot_GetRect(annot, rect),
  );
  if (!edges) return { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
  const [l, t, r, b] = edges;
  const left = Math.min(l, r);
  const top = Math.max(t, b);
  return {
    origin: toDisplay(frame, left, top),
    size: { width: Math.abs(r - l), height: Math.abs(t - b) },
  };
}
