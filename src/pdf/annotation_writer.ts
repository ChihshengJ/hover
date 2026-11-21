/**
 * Create, update and remove the markup annotations Hover writes: highlights,
 * underlines and ink. Each is found by its `/NM`, which is Hover's id for it.
 *
 * Only the annotation being written is touched. In particular:
 *
 * - The appearance stream is Hover's own (`FPDFAnnot_SetAP`), never PDFium's
 *   generated one. PDFium only generates appearances for a whole page at a
 *   time, and stamps its private `/PDFIUM_HasGeneratedAP` on every annotation
 *   there, the file's own links included.
 * - `/T` (author) is never written, and `/Contents` only when there is
 *   something in it: readers built on PDFKit show any `/Contents` on a
 *   highlight as a note, so an empty one is a blank note.
 *
 * Highlights are drawn at 50% opacity with a Normal blend (the only one
 * `SetAP`'s graphics state offers), where the engine used Multiply.
 *
 * Geometry comes in display space (top-left page points, `page_frame.ts`),
 * the space `annotation_reader.ts` reads it back in.
 */

import { boxAround, fromDisplay, readFrame, readRect } from "./page_frame.js";
import type { PageFrame } from "./page_frame.js";
import type { PdfiumDocument } from "./document.js";
import type { PdfiumFFI } from "./pdfium_ffi.js";

/** What Hover writes for one annotation on one page. */
export interface MarkupWrite {
  /** `/NM`: Hover's id. */
  name: string;
  subtype: "highlight" | "underline" | "ink";
  /** `#rrggbb`. */
  color: string;
  /** 0–1. Below 1 the annotation gets `/CA` and a translucent appearance. */
  opacity: number;
  /** Highlight and underline: one box per line of text, display space. */
  segments: PdfBox[];
  /** Ink: point lists, display space. */
  strokes: Point[][];
  /** Ink: line width in PDF units. */
  strokeWidth: number;
  /** `/Contents`; omitted when null or empty. */
  contents: string | null;
  /** `/M`. */
  modified: Date;
}

/**
 * How to find an annotation that has no `/NM` yet (one that came with the
 * file): its subtype and its rect as `annotation_reader.ts` read it. It gets
 * `/NM` the first time Hover writes it.
 */
export interface UnnamedLocator {
  subtype: NativeMarkup["subtype"];
  rect: PdfBox;
}

/** PDFium's `FPDF_ANNOT_*`, for what Hover writes and what it may remove. */
const SUBTYPE: Record<NativeMarkup["subtype"], number> = {
  text: 1,
  highlight: 9,
  underline: 10,
  ink: 15,
};

/** `FPDFANNOT_COLORTYPE_Color`, `FPDF_ANNOT_APPEARANCEMODE_NORMAL`. */
const COLOR_TYPE = 0;
const AP_NORMAL = 0;
/** `FPDF_ANNOT_FLAG_PRINT`: without it, viewers show it on screen only. */
const FLAG_PRINT = 4;
/** An underline's line width, as PDFium draws its own. */
const UNDERLINE_WIDTH = 1;

/** A number for a content stream: short, and no exponent. */
function num(value: number): string {
  const fixed = value.toFixed(3);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

function rgb(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) throw new Error(`Not a #rrggbb colour: ${color}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** `D:YYYYMMDDHHmmSSZ`. */
function pdfDate(date: Date): string {
  const z = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `D:${z(date.getUTCFullYear(), 4)}${z(date.getUTCMonth() + 1)}` +
    `${z(date.getUTCDate())}${z(date.getUTCHours())}` +
    `${z(date.getUTCMinutes())}${z(date.getUTCSeconds())}Z`
  );
}

/** A segment's corners in PDF space, in `/QuadPoints` order: TL TR BL BR. */
function quadOf(frame: PageFrame, box: PdfBox): Point[] {
  const { x, y } = box.origin;
  const { width: w, height: h } = box.size;
  return [
    fromDisplay(frame, x, y),
    fromDisplay(frame, x + w, y),
    fromDisplay(frame, x, y + h),
    fromDisplay(frame, x + w, y + h),
  ];
}

/** Everything the write needs, in PDF space. */
interface Prepared {
  quads: Point[][];
  strokes: Point[][];
  /** `/Rect`, PDF space: left, top, right, bottom. */
  rect: [number, number, number, number];
  appearance: string;
}

function prepare(frame: PageFrame, w: MarkupWrite): Prepared {
  const [r, g, b] = rgb(w.color).map((c) => num(c / 255));
  const quads = w.subtype === "ink" ? [] : w.segments.map((s) => quadOf(frame, s));
  const strokes =
    w.subtype === "ink"
      ? w.strokes.map((points) => points.map((p) => fromDisplay(frame, p.x, p.y)))
      : [];

  const all = [...quads.flat(), ...strokes.flat()];
  if (all.length === 0) throw new Error(`Nothing to draw for ${w.name}`);
  const bounds = boxAround(all);
  // PDF space is y-up, so `boxAround`'s "origin" is the bottom-left here.
  const pad = w.subtype === "ink" ? w.strokeWidth : 0;
  const rect: Prepared["rect"] = [
    bounds.origin.x - pad,
    bounds.origin.y + bounds.size.height + pad,
    bounds.origin.x + bounds.size.width + pad,
    bounds.origin.y - pad,
  ];

  const ops: string[] = [];
  if (w.subtype === "highlight") {
    // `/GS` exists only when /CA < 1; SetAP adds it then.
    if (w.opacity < 1) ops.push("/GS gs");
    ops.push(`${r} ${g} ${b} rg`);
    for (const [tl, tr, bl, br] of quads) {
      ops.push(
        `${num(tl.x)} ${num(tl.y)} m ${num(tr.x)} ${num(tr.y)} l ` +
          `${num(br.x)} ${num(br.y)} l ${num(bl.x)} ${num(bl.y)} l h f`,
      );
    }
  } else if (w.subtype === "underline") {
    ops.push(`${r} ${g} ${b} RG ${num(UNDERLINE_WIDTH)} w`);
    for (const segment of w.segments) {
      // Along the segment's bottom edge, its width inside the box.
      const y = segment.origin.y + segment.size.height - UNDERLINE_WIDTH / 2;
      const from = fromDisplay(frame, segment.origin.x, y);
      const to = fromDisplay(frame, segment.origin.x + segment.size.width, y);
      ops.push(`${num(from.x)} ${num(from.y)} m ${num(to.x)} ${num(to.y)} l S`);
    }
  } else {
    ops.push(`${r} ${g} ${b} RG ${num(w.strokeWidth)} w 1 J 1 j`);
    for (const points of strokes) {
      if (points.length === 0) continue;
      const [first, ...rest] = points;
      // A single point still draws: a zero-length line with round caps.
      const path = rest.length ? rest : [first];
      ops.push(
        `${num(first.x)} ${num(first.y)} m ` +
          path.map((p) => `${num(p.x)} ${num(p.y)} l`).join(" ") +
          " S",
      );
    }
  }
  return { quads, strokes, rect, appearance: ops.join("\n") };
}

function setString(ffi: PdfiumFFI, annot: number, key: string, value: string) {
  ffi.withCString(key, (keyPtr) =>
    ffi.withWideString(value, (valuePtr) =>
      ffi.pdfium.FPDFAnnot_SetStringValue(annot, keyPtr, valuePtr),
    ),
  );
}

function getString(ffi: PdfiumFFI, annot: number, key: string): string {
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

function writeQuad(ffi: PdfiumFFI, quad: Point[], fn: (ptr: number) => number) {
  return ffi.frame(() => {
    const slots = ffi.slots(8, 4);
    quad.forEach((p, i) => {
      ffi.pdfium.HEAPF32[slots[i * 2] >> 2] = p.x;
      ffi.pdfium.HEAPF32[slots[i * 2 + 1] >> 2] = p.y;
    });
    return fn(slots[0]);
  });
}

/**
 * Write everything but the appearance, then the appearance. The annotation
 * must have no appearance stream yet: `SetColor` refuses otherwise.
 */
function writeFields(
  ffi: PdfiumFFI,
  annot: number,
  w: MarkupWrite,
  prepared: Prepared,
  quadsAlreadyThere: number,
) {
  const pdfium = ffi.pdfium;

  ffi.frame(() => {
    const rect = ffi.slots(4, 4);
    prepared.rect.forEach((v, i) => (pdfium.HEAPF32[rect[i] >> 2] = v));
    pdfium.FPDFAnnot_SetRect(annot, rect[0]);
  });

  prepared.quads.forEach((quad, i) => {
    writeQuad(ffi, quad, (ptr) =>
      i < quadsAlreadyThere
        ? pdfium.FPDFAnnot_SetAttachmentPoints(annot, i, ptr)
        : pdfium.FPDFAnnot_AppendAttachmentPoints(annot, ptr),
    );
  });

  if (w.subtype === "ink") {
    pdfium.FPDFAnnot_RemoveInkList(annot);
    for (const points of prepared.strokes) {
      if (points.length === 0) continue;
      ffi.withBuffer(points.length * 8, (buffer) => {
        points.forEach((p, i) => {
          pdfium.HEAPF32[(buffer >> 2) + i * 2] = p.x;
          pdfium.HEAPF32[(buffer >> 2) + i * 2 + 1] = p.y;
        });
        pdfium.FPDFAnnot_AddInkStroke(annot, buffer, points.length);
      });
    }
    pdfium.FPDFAnnot_SetBorder(annot, 0, 0, w.strokeWidth);
  }

  const [r, g, b] = rgb(w.color);
  const alpha = Math.max(0, Math.min(255, Math.round(w.opacity * 255)));
  if (!pdfium.FPDFAnnot_SetColor(annot, COLOR_TYPE, r, g, b, alpha)) {
    throw new Error(`PDFium refused the colour of ${w.name}`);
  }
  pdfium.FPDFAnnot_SetFlags(annot, FLAG_PRINT);
  setString(ffi, annot, "NM", w.name);
  setString(ffi, annot, "M", pdfDate(w.modified));
  if (w.contents) setString(ffi, annot, "Contents", w.contents);

  const ok = ffi.withWideString(prepared.appearance, (value) =>
    pdfium.FPDFAnnot_SetAP(annot, AP_NORMAL, value),
  );
  if (!ok) throw new Error(`PDFium refused the appearance of ${w.name}`);
}

function sameBox(a: PdfBox, b: PdfBox): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) < 1e-3;
  return (
    close(a.origin.x, b.origin.x) &&
    close(a.origin.y, b.origin.y) &&
    close(a.size.width, b.size.width) &&
    close(a.size.height, b.size.height)
  );
}

/**
 * The `/Annots` index of the annotation named `name`, or, failing that, of
 * the unnamed one `locator` describes. -1 when neither is on the page.
 */
function findIndex(
  ffi: PdfiumFFI,
  frame: PageFrame,
  pagePtr: number,
  name: string,
  locator: UnnamedLocator | null,
): number {
  const pdfium = ffi.pdfium;
  const count = pdfium.FPDFPage_GetAnnotCount(pagePtr);
  let unnamedMatch = -1;
  for (let i = 0; i < count; i++) {
    const annot = pdfium.FPDFPage_GetAnnot(pagePtr, i);
    if (!annot) continue;
    try {
      const nm = getString(ffi, annot, "NM");
      if (name && nm === name) return i;
      if (
        unnamedMatch < 0 &&
        locator &&
        !nm &&
        pdfium.FPDFAnnot_GetSubtype(annot) === SUBTYPE[locator.subtype] &&
        sameBox(readRect(ffi, frame, annot), locator.rect)
      ) {
        unnamedMatch = i;
      }
    } finally {
      pdfium.FPDFPage_CloseAnnot(annot);
    }
  }
  return unnamedMatch;
}

/** Run `fn` with the page loaded and its frame read. */
function onPage<T>(
  document: PdfiumDocument,
  pageIndex: number,
  fn: (pagePtr: number, frame: PageFrame) => T,
): T {
  const result = document.withLoadedPage(pageIndex, (pagePtr) =>
    fn(pagePtr, readFrame(document, pagePtr, pageIndex)),
  );
  if (result === null) throw new Error(`PDFium could not load page ${pageIndex}`);
  return result;
}

/** Add `w` to the page, at the end of its `/Annots`. */
export function createAnnotation(
  document: PdfiumDocument,
  pageIndex: number,
  w: MarkupWrite,
) {
  const pdfium = document.pdfium;
  const ffi = document.ffi;
  onPage(document, pageIndex, (pagePtr, frame) => {
    const prepared = prepare(frame, w);
    const annot = pdfium.FPDFPage_CreateAnnot(pagePtr, SUBTYPE[w.subtype]);
    if (!annot) throw new Error(`PDFium could not create ${w.subtype} ${w.name}`);
    try {
      writeFields(ffi, annot, w, prepared, 0);
    } finally {
      pdfium.FPDFPage_CloseAnnot(annot);
    }
  });
}

/**
 * Remove the annotation named `name` (or the unnamed one `locator`
 * describes). False when it isn't on the page.
 */
export function removeAnnotation(
  document: PdfiumDocument,
  pageIndex: number,
  name: string,
  locator: UnnamedLocator | null = null,
): boolean {
  const ffi = document.ffi;
  return onPage(document, pageIndex, (pagePtr, frame) => {
    const index = findIndex(ffi, frame, pagePtr, name, locator);
    return index >= 0 && !!document.pdfium.FPDFPage_RemoveAnnot(pagePtr, index);
  });
}

/**
 * Rewrite the annotation named `w.name` (or the unnamed one `locator`
 * describes) as `w`, in place, so keys Hover doesn't write survive.
 *
 * It is removed and created afresh instead when PDFium can't express the
 * change in place: a different subtype, fewer segments than it has (there is
 * no call to drop a quad), or a comment cleared (none to drop `/Contents`).
 * False when it isn't on the page.
 */
export function updateAnnotation(
  document: PdfiumDocument,
  pageIndex: number,
  w: MarkupWrite,
  locator: UnnamedLocator | null = null,
): boolean {
  const pdfium = document.pdfium;
  const ffi = document.ffi;
  const done = onPage(document, pageIndex, (pagePtr, frame) => {
    const index = findIndex(ffi, frame, pagePtr, w.name, locator);
    if (index < 0) return "missing";
    const annot = pdfium.FPDFPage_GetAnnot(pagePtr, index);
    if (!annot) return "missing";
    try {
      const quadsThere = pdfium.FPDFAnnot_CountAttachmentPoints(annot);
      const prepared = prepare(frame, w);
      const inPlace =
        pdfium.FPDFAnnot_GetSubtype(annot) === SUBTYPE[w.subtype] &&
        prepared.quads.length >= quadsThere &&
        (!!w.contents || !getString(ffi, annot, "Contents"));
      if (!inPlace) return "recreate";

      // Drop the old appearance first; SetColor refuses while there is one.
      pdfium.FPDFAnnot_SetAP(annot, AP_NORMAL, 0);
      writeFields(ffi, annot, w, prepared, quadsThere);
      return "updated";
    } finally {
      pdfium.FPDFPage_CloseAnnot(annot);
    }
  });

  if (done === "missing") return false;
  if (done === "recreate") {
    removeAnnotation(document, pageIndex, w.name, locator);
    createAnnotation(document, pageIndex, w);
  }
  return true;
}
