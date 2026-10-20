/**
 * What the Email tab shows of the annotated copy: which pages carry
 * annotations, a one-line tally, and tiny renders of those pages.
 */

import type { PDFDocumentModel } from "../../../model/doc.js";
import type { AnnotationType } from "../../../model/annotation_data.js";

const NOUNS: Record<AnnotationType | "comment", [string, string]> = {
  highlight: ["highlight", "highlights"],
  underline: ["underline", "underlines"],
  drawing: ["drawing", "drawings"],
  comment: ["comment", "comments"],
};

export function summarizeAnnotations(doc: PDFDocumentModel): {
  pages: number[];
  summary: string;
} {
  const pages = new Set<number>();
  const counts = new Map<keyof typeof NOUNS, number>();
  const bump = (key: keyof typeof NOUNS) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);

  for (const annotation of doc.getAllAnnotations()) {
    bump(annotation.type);
    if (annotation.comment) bump("comment");
    for (const range of annotation.pageRanges) pages.add(range.pageNumber);
  }

  const summary = (Object.keys(NOUNS) as (keyof typeof NOUNS)[])
    .filter((key) => counts.has(key))
    .map((key) => {
      const n = counts.get(key)!;
      return `${n} ${NOUNS[key][n === 1 ? 0 : 1]}`;
    })
    .join(" · ");

  return { pages: [...pages].sort((a, b) => a - b), summary };
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
