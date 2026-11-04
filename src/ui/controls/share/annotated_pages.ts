/**
 * The exported file as the dialogs show it: its name and size, which pages
 * carry annotations, and tiny renders of those pages.
 */

import { COLOR_NAME_TO_HEX } from "../../annotation/drawing/drawing_geometry.js";

import type {
  Annotation,
  AnnotationColorName,
} from "../../../model/annotation_data.js";
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
 * Render a page `cssHeight` tall, with Hover's annotations unless asked not
 * to. PDFium draws the bare page and the marks are painted over it the way
 * the viewer draws them, so the preview shows the user's own highlights,
 * underlines and drawings. PDFium's own annotation pass would also draw
 * whatever else the file carries, such as the coloured boxes LaTeX puts
 * around links, which the viewer never shows.
 */
export async function renderThumbnail(
  doc: PDFDocumentModel,
  pageNumber: number,
  cssHeight: number,
  withAnnotations = true,
): Promise<HTMLCanvasElement | null> {
  const page = doc.getPage(pageNumber);
  const { native, pdfDoc } = doc;
  if (!page || !native || !pdfDoc) return null;

  const scaleFactor = (cssHeight * window.devicePixelRatio) / page.size.height;
  const image = await native
    .renderPageRaw(pdfDoc, page, { scaleFactor, withAnnotations: false })
    .toPromise();

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.putImageData(
    new ImageData(image.data, image.width, image.height),
    0,
    0,
  );
  if (withAnnotations) paintAnnotations(context, doc, pageNumber);
  return canvas;
}

interface MarkColors {
  highlight: string;
  underline: string;
}

/** The viewer's fills for one palette colour, read once from its CSS. */
const markColors = new Map<AnnotationColorName, MarkColors>();
function colorsFor(color: AnnotationColorName): MarkColors {
  let colors = markColors.get(color);
  if (!colors) {
    const probe = document.createElement("span");
    probe.dataset.color = color;
    probe.hidden = true;
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const fallback = COLOR_NAME_TO_HEX[color];
    colors = {
      highlight: style.getPropertyValue("--anno-fill").trim() || fallback,
      underline: style.getPropertyValue("--anno-underline").trim() || fallback,
    };
    probe.remove();
    markColors.set(color, colors);
  }
  return colors;
}

/** Paint a page's annotations onto its render, filling the whole canvas. */
function paintAnnotations(
  context: CanvasRenderingContext2D,
  doc: PDFDocumentModel,
  pageNumber: number,
) {
  const { width, height } = context.canvas;

  for (const annotation of doc.getAllAnnotations()) {
    const range = annotation.pageRanges.find(
      (r) => r.pageNumber === pageNumber,
    );
    if (!range) continue;
    if (annotation.type === "drawing") {
      paintDrawing(context, annotation, width, height);
      continue;
    }

    // An underline is as thick, and as far below its text, as the viewer's
    // 2px on a page about a thousand pixels tall.
    const rule = Math.max(1, height * 0.002);
    context.fillStyle = colorsFor(annotation.color)[annotation.type];
    for (const rect of range.rects) {
      const x = rect.leftRatio * width;
      const y = rect.topRatio * height;
      const w = rect.widthRatio * width;
      const h = rect.heightRatio * height;
      if (annotation.type === "highlight") context.fillRect(x, y, w, h);
      else context.fillRect(x, y + h + rule, w, rule);
    }
  }
}

/** A drawing's strokes, smoothed and turned as the viewer's renderer does. */
function paintDrawing(
  context: CanvasRenderingContext2D,
  annotation: Annotation,
  width: number,
  height: number,
) {
  const strokes = (annotation.strokes ?? []).filter((s) => s.points.length);
  if (strokes.length === 0) return;

  context.save();
  if (annotation.rotation) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x * width);
        minY = Math.min(minY, p.y * height);
        maxX = Math.max(maxX, p.x * width);
        maxY = Math.max(maxY, p.y * height);
      }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    context.translate(cx, cy);
    context.rotate((annotation.rotation * Math.PI) / 180);
    context.translate(-cx, -cy);
  }

  context.strokeStyle = COLOR_NAME_TO_HEX[annotation.color] ?? "#000000";
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    const points = stroke.points.map((p) => ({
      x: p.x * width,
      y: p.y * height,
    }));
    context.lineWidth = Math.max(0.5, (stroke.strokeWidth || 0.003) * width);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    // Through the midpoints, with each point as a control: the viewer's curve.
    for (let i = 1; i < points.length - 1; i++) {
      const mid = {
        x: (points[i].x + points[i + 1].x) / 2,
        y: (points[i].y + points[i + 1].y) / 2,
      };
      context.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
    }
    const last = points[points.length - 1];
    context.lineTo(last.x + (points.length === 1 ? 0.1 : 0), last.y);
    context.stroke();
  }
  context.restore();
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
