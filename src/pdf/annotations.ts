/**
 * Annotation reads that need raw PDFium, not the engine's object model.
 *
 * `@embedpdf/engines` returns annotation rects in whichever vertical convention
 * the document happens to use, so the y origin cannot be trusted without asking
 * PDFium directly. That question is FFI-shaped, which is why it lives here
 * rather than in `model/annotation_data.js` where its one caller is — and being
 * here it is also reachable from `scripts/build_fixtures.ts`, which has to
 * produce the same annotation shape the model does.
 */

import type { PdfiumDocumentHandle } from "./text_extractor.js";

/** The slice of an engine annotation object this file touches. */
export interface NormalizableAnnotation {
  target?: unknown;
  rect?: {
    origin: { x: number; y: number };
    size: { width: number; height: number };
  };
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
  handle: PdfiumDocumentHandle | null,
  pageIndex: number,
  annotations: NormalizableAnnotation[],
) {
  if (!annotations || annotations.length === 0) return;
  if (!handle) return;

  const pdfium = handle.pdfium;
  const ffi = handle.extractor.reader.ffi;

  const pagePtr = pdfium.FPDF_LoadPage(handle.docPtr, pageIndex);
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
