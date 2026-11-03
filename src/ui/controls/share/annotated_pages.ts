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

const THUMB_HEIGHT = 88;
/** Past this many annotated pages the strip stops and says how many remain. */
const MAX_THUMBS = 24;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileCard {
  /** A `.share-attachment`, to sit on a `.share-compose` sheet. */
  el: HTMLElement;
  /** Show or hide the annotated pages; they render the first time they show. */
  showPages(show: boolean): void;
  /** The size beside the name, or a word like "Preparing…". */
  setSize(text: string): void;
}

/** The exported file: its name and size, and a strip of its annotated pages. */
export function createFileCard(
  doc: PDFDocumentModel,
  fileName: string,
): FileCard {
  const el = document.createElement("div");
  el.className = "share-attachment";
  el.innerHTML = `
    <div class="share-attachment-file">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 3 14 8 19 8"/>
      </svg>
      <span class="share-attachment-name"></span>
      <span class="share-attachment-size"></span>
    </div>
    <div class="share-attachment-pages" hidden></div>
  `;
  (el.querySelector(".share-attachment-name") as HTMLElement).textContent =
    fileName;
  const sizeLabel = el.querySelector(
    ".share-attachment-size",
  ) as HTMLSpanElement;
  const strip = el.querySelector(".share-attachment-pages") as HTMLDivElement;

  let built = false;

  /** Lay out a placeholder per annotated page now, and fill them in as they render. */
  const build = () => {
    built = true;
    const pages = annotatedPages(doc);
    const shown = pages.slice(0, MAX_THUMBS);
    const frames = shown.map((pageNumber) => {
      const frame = document.createElement("figure");
      frame.className = "share-thumb";
      frame.innerHTML = `<div class="share-thumb-sheet"></div><figcaption>p. ${pageNumber}</figcaption>`;
      const sheet = frame.firstElementChild as HTMLDivElement;
      sheet.style.height = `${THUMB_HEIGHT}px`;
      sheet.style.width = `${Math.round(THUMB_HEIGHT * pageAspect(doc, pageNumber))}px`;
      strip.appendChild(frame);
      return sheet;
    });
    if (pages.length > shown.length) {
      const more = document.createElement("span");
      more.className = "share-thumb-more";
      more.textContent = `+${pages.length - shown.length} more`;
      strip.appendChild(more);
    }

    // One at a time, so the viewer's own renders aren't starved.
    (async () => {
      for (let i = 0; i < shown.length; i++) {
        try {
          const canvas = await renderThumbnail(doc, shown[i], THUMB_HEIGHT);
          if (canvas) frames[i].appendChild(canvas);
        } catch (error) {
          console.warn(`Thumbnail for page ${shown[i]} failed:`, error);
        }
      }
    })();
  };

  return {
    el,
    showPages: (show) => {
      const visible = show && annotatedPages(doc).length > 0;
      if (visible && !built) build();
      strip.hidden = !visible;
    },
    setSize: (text) => (sizeLabel.textContent = text),
  };
}
