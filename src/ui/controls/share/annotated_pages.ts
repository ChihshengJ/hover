/**
 * What the Email tab shows of the annotated copy: which pages carry
 * annotations, and tiny renders of those pages.
 */

import type { PDFDocumentModel } from "../../../model/doc.js";

/** The pages that carry annotations, in order. */
export function annotatedPages(doc: PDFDocumentModel): number[] {
  const pages = new Set<number>();
  for (const annotation of doc.getAllAnnotations()) {
    for (const range of annotation.pageRanges) pages.add(range.pageNumber);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Width over height of a page, for sizing a thumbnail before it renders. */
export function pageAspect(doc: PDFDocumentModel, pageNumber: number): number {
  const page = doc.getPage(pageNumber);
  return page ? page.size.width / page.size.height : 1 / Math.SQRT2;
}

/**
 * Render a page, annotations included, `cssHeight` tall. PDFium draws the
 * annotations from the same document the export saves, so this is what the
 * recipient's reader will show.
 */
export async function renderThumbnail(
  doc: PDFDocumentModel,
  pageNumber: number,
  cssHeight: number,
): Promise<HTMLCanvasElement | null> {
  const page = doc.getPage(pageNumber);
  const { native, pdfDoc } = doc;
  if (!page || !native || !pdfDoc) return null;

  const scaleFactor = (cssHeight * window.devicePixelRatio) / page.size.height;
  const image = await native
    .renderPageRaw(pdfDoc, page, { scaleFactor, withAnnotations: true })
    .toPromise();

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas
    .getContext("2d")!
    .putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}
