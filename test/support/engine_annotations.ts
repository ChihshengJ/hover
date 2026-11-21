/**
 * The engine's annotation objects, put in the shape Hover's reader
 * (`src/pdf/annotation_reader.ts`) produces, so tests can compare the two.
 * Goes with the engine (docs/plan_own_pdf_engine.md phase 6).
 */

import { expect } from "bun:test";

import { round } from "./pdfium.js";
import type { PdfiumDocument } from "../../src/pdf/document.js";

/** The slice of an engine annotation object `normalizeAnnotationRects` touches. */
interface NormalizableAnnotation {
  target?: unknown;
  rect?: {
    origin: { x: number; y: number };
    size: { width: number; height: number };
  };
}

/*
 * Moved here from src/pdf/annotations.ts when Hover's annotation reader took
 * its place (it does the same inside readPageAnnotations). The engine-side
 * baselines still need it to record what the app used to see.
 */

/** Engine annotation subtypes. */
const LINK = 2;
const MARKUP: Record<number, NativeMarkup["subtype"]> = {
  1: "text",
  9: "highlight",
  10: "underline",
  15: "ink",
};

/** The engine's links, as `NativeLink`s, rounded. */
export function engineLinks(annotations: any[]): unknown[] {
  return annotations
    .filter((a) => a.type === LINK)
    .map((a) => round(JSON.parse(JSON.stringify({ rect: a.rect, target: a.target }))));
}

/** Hover's links, rounded the same way. */
export function readerLinks(links: NativeLink[]): unknown[] {
  return links.map((l) => round(JSON.parse(JSON.stringify(l))));
}

/** The engine's markup annotations of the kinds Hover reads. */
export function engineMarkup(annotations: any[]): any[] {
  return annotations.filter((a) => a.type in MARKUP);
}

function channels(hex: string | null | undefined): number[] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  return m ? m.slice(1).map((c) => parseInt(c, 16)) : [];
}

/**
 * Expect Hover's reading of one markup annotation to match the engine's.
 * Colour may differ by 1 per channel (see annotation_reader.ts); the name is
 * only compared when the file has one, as the engine mints a random one
 * otherwise.
 */
export function expectSameMarkup(engine: any, markup: NativeMarkup) {
  expect(markup.subtype).toBe(MARKUP[engine.type]);
  expect(round(markup.rect)).toEqual(round(engine.rect));
  if (markup.name !== null) expect(markup.name).toBe(engine.id);
  expect(markup.contents).toBe(engine.contents ?? "");
  expect(markup.opacity).toBeCloseTo(engine.opacity ?? 1, 6);
  expect(markup.modified?.toISOString()).toBe(engine.modified?.toISOString());
  expect(markup.created?.toISOString()).toBe(engine.created?.toISOString());
  expect(markup.custom ?? undefined).toEqual(engine.custom);

  const want = channels(engine.strokeColor ?? engine.color);
  const got = channels(markup.color);
  expect(got.length).toBe(3);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
  }

  if (markup.subtype === "highlight" || markup.subtype === "underline") {
    expect(round(markup.segments)).toEqual(round(engine.segmentRects));
  }
  if (markup.subtype === "ink") {
    expect(round(markup.strokes)).toEqual(
      round(engine.inkList.map((s: { points: Point[] }) => s.points)),
    );
    expect(markup.strokeWidth).toBeCloseTo(engine.strokeWidth, 3);
  }
}

/**
 * Put every annotation rect on this page into the top-left origin the rest of
 * the app assumes. Mutates `annotations` in place.
 *
 * In PDF user space `FS_RECTF` runs bottom-up, so a well-formed rect has
 * `bottom < top`. A document that reports the reverse has had its rects flipped,
 * and every rect on the page needs its origin moved up by its own height to
 * compensate. Five annotations are sampled to decide, since the convention is a
 * property of the document rather than of any one annotation.
 *
 * @param pageIndex 0-based
 */
export function normalizeAnnotationRects(
  document: PdfiumDocument | null,
  pageIndex: number,
  annotations: NormalizableAnnotation[],
) {
  if (!annotations || annotations.length === 0) return;
  if (!document) return;

  const pdfium = document.pdfium;
  const ffi = document.ffi;

  const pagePtr = pdfium.FPDF_LoadPage(document.docPtr, pageIndex);
  if (!pagePtr) return;

  try {
    const rawAnnotCount = pdfium.FPDFPage_GetAnnotCount(pagePtr);
    if (rawAnnotCount === 0) return;

    const samplesToCheck = Math.min(rawAnnotCount, 5);
    let flipped = false;

    for (let i = 0; i < samplesToCheck && !flipped; i++) {
      const annotPtr = pdfium.FPDFPage_GetAnnot(pagePtr, i);
      if (!annotPtr) continue;

      try {
        // FS_RECTF is four contiguous floats — {left, top, right, bottom} — so
        // the call takes the base pointer and the edges are read off it.
        flipped = ffi.frame(() => {
          const [leftPtr, topPtr, , bottomPtr] = ffi.slots(4, 4);
          if (!pdfium.FPDFAnnot_GetRect(annotPtr, leftPtr)) return false;
          return ffi.f32(bottomPtr) > ffi.f32(topPtr);
        });
      } finally {
        pdfium.FPDFPage_CloseAnnot(annotPtr);
      }
    }

    if (!flipped) return;

    for (const annot of annotations) {
      if (!annot.target) continue;
      if (annot.rect?.origin && annot.rect?.size) {
        annot.rect.origin.y -= annot.rect.size.height;
      }
    }
  } finally {
    pdfium.FPDF_ClosePage(pagePtr);
  }
}
