/**
 * Read a page's annotations: the links the analysis pipeline follows, and the
 * markup (highlight, underline, ink, sticky note) the annotation store turns
 * into Hover's own annotations.
 *
 * Geometry follows `@embedpdf/engines` 2.15 (`convertPagePointToDevicePoint`,
 * `quadToRect`): page points, top-left origin, measured from the crop box,
 * with the page's `/Rotate` applied. Two reads can't follow it, because the
 * engine used non-standard `EPDF*` calls for them:
 *
 * - **Rect orientation.** Rects are normalised (top is the larger y), as the
 *   engine's `EPDFAnnot_GetRect` did. Hover then shifted links on pages whose
 *   `/Rect`s are written bottom-up, which `pageWritesRectsReversed` keeps
 *   as it was.
 * - **Colour.** `FPDFAnnot_GetColor` refuses any annotation with an
 *   appearance stream, and standard PDFium can't read the `/C` array
 *   directly. The colour comes from the appearance stream's paths instead:
 *   the fill for a highlight or note, the stroke for an underline or ink.
 *   That matches `/C` to within 1 per channel (a `0.5` component reads 127
 *   from `/C` and 128 from the stream), which `hexToColorName` absorbs.
 */

import { readAction, readDestination } from "./destinations.js";
import { pdfDateToDate } from "./document.js";
import type { PdfiumDocument } from "./document.js";
import type { PdfiumFFI } from "./pdfium_ffi.js";

/** PDFium's `FPDF_ANNOT_*` subtypes this file reads. */
const SUBTYPE = {
  TEXT: 1,
  LINK: 2,
  HIGHLIGHT: 9,
  UNDERLINE: 10,
  INK: 15,
} as const;

const MARKUP: Record<number, NativeMarkup["subtype"]> = {
  [SUBTYPE.TEXT]: "text",
  [SUBTYPE.HIGHLIGHT]: "highlight",
  [SUBTYPE.UNDERLINE]: "underline",
  [SUBTYPE.INK]: "ink",
};

/** `FPDFPAGEOBJ_PATH`, `FPDFPAGEOBJ_FORM`. */
const PATH_OBJECT = 2;
const FORM_OBJECT = 5;

export interface PageAnnotations {
  links: NativeLink[];
  markup: NativeMarkup[];
}

/** Page space → top-left display space, as the engine maps it. */
interface PageFrame {
  width: number;
  height: number;
  rotation: number;
  originX: number;
  originY: number;
}

function toDisplay(frame: PageFrame, x: number, y: number): Point {
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

/** The bounding box of some display-space points. */
function boxAround(points: Point[]): PdfBox {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    origin: { x, y },
    size: { width: Math.max(...xs) - x, height: Math.max(...ys) - y },
  };
}

function readFrame(
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

/**
 * `/Rect` in display space. The engine places the origin at the rect's left
 * and top as written and takes absolute sizes; this does the same after
 * putting the edges in order.
 */
function readRect(ffi: PdfiumFFI, frame: PageFrame, annot: number): PdfBox {
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

/**
 * Whether the page's `/Rect`s run the wrong way (bottom above top), judged
 * from its first five annotations of any kind. Hover's links on such a page
 * have always been moved up by their own height (formerly
 * `pdf/annotations.ts#normalizeAnnotationRects`). Kept as it was so link
 * positions don't move.
 * TODO: neither placement lines up with the link text in `rotate example.pdf`,
 * the one fixture this applies to; worth a look on its own.
 */
function pageWritesRectsReversed(ffi: PdfiumFFI, pagePtr: number, count: number) {
  const pdfium = ffi.pdfium;
  for (let i = 0; i < Math.min(count, 5); i++) {
    const annot = pdfium.FPDFPage_GetAnnot(pagePtr, i);
    if (!annot) continue;
    try {
      // FS_RECTF: left, top, right, bottom.
      const edges = ffi.readF32Out(4, (rect) => pdfium.FPDFAnnot_GetRect(annot, rect));
      if (edges && edges[3] > edges[1]) return true;
    } finally {
      pdfium.FPDFPage_CloseAnnot(annot);
    }
  }
  return false;
}

/** An annotation string entry; "" when absent or empty. */
function readString(ffi: PdfiumFFI, annot: number, key: string): string {
  const pdfium = ffi.pdfium;
  return ffi.withCString(key, (keyPtr) => {
    const length = pdfium.FPDFAnnot_GetStringValue(annot, keyPtr, 0, 0);
    if (length <= 2) return "";
    return ffi.withBuffer(length, (buffer) => {
      pdfium.FPDFAnnot_GetStringValue(annot, keyPtr, buffer, length);
      return ffi.utf16(buffer);
    });
  });
}

/** `/CA`, quantised to 1/255 as the engine's alpha byte was. */
function readOpacity(ffi: PdfiumFFI, annot: number): number {
  const ca = ffi.withCString("CA", (keyPtr) =>
    ffi.readF32Out(1, (value) =>
      ffi.pdfium.FPDFAnnot_GetNumberValue(annot, keyPtr, value),
    ),
  );
  if (!ca) return 1;
  return Math.max(0, Math.min(255, Math.round(ca[0] * 255))) / 255;
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => (c & 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The first fill and the first stroke colour among the paths of an
 * appearance stream, descending into form objects.
 */
function appearanceColors(
  ffi: PdfiumFFI,
  count: number,
  objectAt: (i: number) => number,
  found: { fill: string | null; stroke: string | null; strokeWidth: number | null },
) {
  const pdfium = ffi.pdfium;
  for (let i = 0; i < count && !(found.fill && found.stroke); i++) {
    const obj = objectAt(i);
    if (!obj) continue;
    const type = pdfium.FPDFPageObj_GetType(obj);
    if (type === FORM_OBJECT) {
      appearanceColors(
        ffi,
        pdfium.FPDFFormObj_CountObjects(obj),
        (j) => pdfium.FPDFFormObj_GetObject(obj, j),
        found,
      );
      continue;
    }
    if (type !== PATH_OBJECT) continue;
    ffi.frame(() => {
      const [fillMode, stroke] = ffi.slots(2, 4);
      if (!pdfium.FPDFPath_GetDrawMode(obj, fillMode, stroke)) return;
      const [r, g, b, a] = ffi.slots(4, 4);
      if (!found.fill && ffi.i32(fillMode) !== 0) {
        if (pdfium.FPDFPageObj_GetFillColor(obj, r, g, b, a)) {
          found.fill = hex(ffi.u32(r), ffi.u32(g), ffi.u32(b));
        }
      }
      if (!found.stroke && ffi.i32(stroke)) {
        if (pdfium.FPDFPageObj_GetStrokeColor(obj, r, g, b, a)) {
          found.stroke = hex(ffi.u32(r), ffi.u32(g), ffi.u32(b));
          const [width] = ffi.slots(1, 4);
          if (pdfium.FPDFPageObj_GetStrokeWidth(obj, width)) {
            found.strokeWidth = ffi.f32(width);
          }
        }
      }
    });
  }
}

/**
 * The annotation's colour, and for ink its line width. `/C` when PDFium will
 * give it (no appearance stream), otherwise from the stream.
 */
function readColor(
  ffi: PdfiumFFI,
  annot: number,
  subtype: NativeMarkup["subtype"],
): { color: string | null; strokeWidth: number | null } {
  const pdfium = ffi.pdfium;
  const found = { fill: null, stroke: null, strokeWidth: null } as {
    fill: string | null;
    stroke: string | null;
    strokeWidth: number | null;
  };
  appearanceColors(
    ffi,
    pdfium.FPDFAnnot_GetObjectCount(annot),
    (i) => pdfium.FPDFAnnot_GetObject(annot, i),
    found,
  );

  const direct = ffi.readU32Out(4, (r, g, b, a) =>
    // FPDFANNOT_COLORTYPE_Color
    pdfium.FPDFAnnot_GetColor(annot, 0, r, g, b, a),
  );
  if (direct) {
    return { color: hex(direct[0], direct[1], direct[2]), strokeWidth: found.strokeWidth };
  }
  const prefersStroke = subtype === "underline" || subtype === "ink";
  const color = prefersStroke
    ? (found.stroke ?? found.fill)
    : (found.fill ?? found.stroke);
  return { color, strokeWidth: found.strokeWidth };
}

function readSegments(
  ffi: PdfiumFFI,
  frame: PageFrame,
  annot: number,
): PdfBox[] {
  const pdfium = ffi.pdfium;
  const segments: PdfBox[] = [];
  const count = pdfium.FPDFAnnot_CountAttachmentPoints(annot);
  for (let i = 0; i < count; i++) {
    const quad = ffi.readF32Out(8, (q) =>
      pdfium.FPDFAnnot_GetAttachmentPoints(annot, i, q),
    );
    if (!quad) continue;
    const points: Point[] = [];
    for (let p = 0; p < 4; p++) {
      points.push(toDisplay(frame, quad[p * 2], quad[p * 2 + 1]));
    }
    segments.push(boxAround(points));
  }
  return segments;
}

function readStrokes(
  ffi: PdfiumFFI,
  frame: PageFrame,
  annot: number,
): Point[][] {
  const pdfium = ffi.pdfium;
  const strokes: Point[][] = [];
  const count = pdfium.FPDFAnnot_GetInkListCount(annot);
  for (let i = 0; i < count; i++) {
    const length = pdfium.FPDFAnnot_GetInkListPath(annot, i, 0, 0);
    const points: Point[] = [];
    if (length > 0) {
      ffi.withBuffer(length * 8, (buffer) => {
        pdfium.FPDFAnnot_GetInkListPath(annot, i, buffer, length);
        for (let p = 0; p < length; p++) {
          points.push(
            toDisplay(frame, ffi.f32(buffer + p * 8), ffi.f32(buffer + p * 8 + 4)),
          );
        }
      });
    }
    strokes.push(points);
  }
  return strokes;
}

function readCustom(ffi: PdfiumFFI, annot: number): Record<string, unknown> | null {
  const raw = readString(ffi, annot, "EPDFCustom");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readLink(
  document: PdfiumDocument,
  frame: PageFrame,
  annot: number,
): NativeLink | null {
  const pdfium = document.pdfium;
  const ffi = document.ffi;
  const link = pdfium.FPDFAnnot_GetLink(annot);
  if (!link) return null;

  const rect = readRect(ffi, frame, annot);
  // The engine's order: a destination wins over an action.
  const destPtr = pdfium.FPDFLink_GetDest(document.docPtr, link);
  if (destPtr) {
    return {
      rect,
      target: {
        type: "destination",
        destination: readDestination(ffi, document.docPtr, destPtr),
      },
    };
  }
  const actionPtr = pdfium.FPDFLink_GetAction(link);
  if (actionPtr) {
    return {
      rect,
      target: {
        type: "action",
        action: readAction(ffi, document.docPtr, actionPtr),
      },
    };
  }
  return { rect };
}

function readMarkup(
  ffi: PdfiumFFI,
  frame: PageFrame,
  annot: number,
  subtype: NativeMarkup["subtype"],
): NativeMarkup {
  const { color, strokeWidth } = readColor(ffi, annot, subtype);
  const name = readString(ffi, annot, "NM");
  return {
    subtype,
    name: name || null,
    rect: readRect(ffi, frame, annot),
    segments:
      subtype === "highlight" || subtype === "underline"
        ? readSegments(ffi, frame, annot)
        : [],
    strokes: subtype === "ink" ? readStrokes(ffi, frame, annot) : [],
    // The engine reported a zero width as 1.
    strokeWidth: strokeWidth || 1,
    color,
    opacity: readOpacity(ffi, annot),
    contents: readString(ffi, annot, "Contents"),
    created: pdfDateToDate(readString(ffi, annot, "CreationDate") || null),
    modified: pdfDateToDate(readString(ffi, annot, "M") || null),
    custom: readCustom(ffi, annot),
  };
}

/**
 * Every link and every markup annotation Hover reads on the page, in
 * `/Annots` order. Read-only: unlike the engine, this never writes `/NM`
 * into an annotation that lacks one.
 *
 * @param index 0-based
 */
export function readPageAnnotations(
  document: PdfiumDocument,
  index: number,
): PageAnnotations {
  const pdfium = document.pdfium;
  const ffi = document.ffi;
  const result: PageAnnotations = { links: [], markup: [] };

  document.withLoadedPage(index, (pagePtr) => {
    const count = pdfium.FPDFPage_GetAnnotCount(pagePtr);
    if (count <= 0) return;
    const frame = readFrame(document, pagePtr, index);

    for (let i = 0; i < count; i++) {
      const annot = pdfium.FPDFPage_GetAnnot(pagePtr, i);
      if (!annot) continue;
      try {
        const subtype = pdfium.FPDFAnnot_GetSubtype(annot);
        if (subtype === SUBTYPE.LINK) {
          const link = readLink(document, frame, annot);
          if (link) result.links.push(link);
        } else if (subtype in MARKUP) {
          result.markup.push(readMarkup(ffi, frame, annot, MARKUP[subtype]));
        }
      } finally {
        pdfium.FPDFPage_CloseAnnot(annot);
      }
    }

    if (result.links.length > 0 && pageWritesRectsReversed(ffi, pagePtr, count)) {
      for (const link of result.links) link.rect.origin.y -= link.rect.size.height;
    }
  });
  return result;
}
