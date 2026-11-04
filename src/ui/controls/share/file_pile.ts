/**
 * Share › Email's attachment, drawn as paper: the document is a stack of
 * sheets held by a paper clip. With the annotations included, the stack
 * splits: it gives way to the annotated pages alone, fanned out and each
 * flagged with its page number. Left out, they gather back into the stack.
 *
 * Below the stage, a strip names the file and takes the annotations toggle.
 */

import {
  annotatedPages,
  pageAspect,
  renderThumbnail,
} from "./annotated_pages.js";

import type { PDFDocumentModel } from "../../../model/doc.js";
import type { FileCard } from "./annotated_pages.js";

export type FilePile = FileCard & { addRow(row: HTMLElement): void };

const STACK_HEIGHT = 150;
const FANNED_HEIGHT = 132;
const MAX_FANNED = 5;

/** How far the outermost fanned sheets' centers reach from the middle. */
const FAN_REACH = 104;
/** The most a fanned sheet moves along from the one before it. */
const FAN_MAX_STEP = 52;
/** Tilt between neighbouring fanned sheets, in degrees. */
const FAN_TILT = 4;

/** The sheets showing under the top one, slightly askew like a real stack. */
const UNDER_SHEETS = [
  { x: -4, y: 3, r: -3 },
  { x: 5, y: 2, r: 2.5 },
  { x: 1, y: 5, r: -1.2 },
];

const CLIP_SVG = `
  <svg class="share-pile-clip" viewBox="0 0 20 56" aria-hidden="true">
    <defs>
      <linearGradient id="share-pile-clip-metal" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="#7f858d"/>
        <stop offset="0.45" stop-color="#f2f4f6"/>
        <stop offset="1" stop-color="#8d939b"/>
      </linearGradient>
    </defs>
    <path d="M7 18V40a3 3 0 0 0 6 0V9a5.5 5.5 0 0 0-11 0V44a8 8 0 0 0 16 0V16"
      fill="none" stroke="url(#share-pile-clip-metal)" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

/** A blank sheet `height` tall, shaped like `pageNumber`. */
function createSheet(
  doc: PDFDocumentModel,
  pageNumber: number,
  height: number,
): HTMLDivElement {
  const sheet = document.createElement("div");
  sheet.className = "share-pile-sheet";
  sheet.style.height = `${height}px`;
  sheet.style.width = `${Math.round(height * pageAspect(doc, pageNumber))}px`;
  return sheet;
}

export function createFilePile(
  doc: PDFDocumentModel,
  fileName: string,
): FilePile {
  const el = document.createElement("div");
  el.className = "share-pile";
  el.innerHTML = `
    <div class="share-pile-stage">
      <div class="share-pile-stack">${CLIP_SVG}</div>
      <div class="share-pile-fan"></div>
    </div>
    <div class="share-pile-foot">
      <div class="share-pile-info">
        <span class="share-pile-name"></span>
        <span class="share-pile-meta"></span>
      </div>
    </div>
  `;
  const stack = el.querySelector(".share-pile-stack") as HTMLDivElement;
  const fan = el.querySelector(".share-pile-fan") as HTMLDivElement;
  const foot = el.querySelector(".share-pile-foot") as HTMLDivElement;
  const meta = el.querySelector(".share-pile-meta") as HTMLSpanElement;
  (el.querySelector(".share-pile-name") as HTMLElement).textContent = fileName;

  const pageCount = doc.numPages;
  const pageWord = pageCount === 1 ? "page" : "pages";

  // The stack: up to three sheets underneath, then the first page on top.
  UNDER_SHEETS.slice(0, Math.max(0, pageCount - 1)).forEach(({ x, y, r }) => {
    const sheet = createSheet(doc, 1, STACK_HEIGHT);
    sheet.classList.add("under");
    sheet.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg)`;
    stack.insertBefore(sheet, stack.lastElementChild);
  });
  const top = createSheet(doc, 1, STACK_HEIGHT);
  stack.insertBefore(top, stack.lastElementChild);

  // The stack is the paper as it was opened; the marks are the fan's to show.
  let topRendered = false;
  const renderTop = async () => {
    topRendered = true;
    try {
      const canvas = await renderThumbnail(doc, 1, STACK_HEIGHT, false);
      if (canvas) top.appendChild(canvas);
    } catch (error) {
      console.warn("Thumbnail for page 1 failed:", error);
    }
  };

  let fanned = false;
  /** Lay out a sheet per annotated page, and fill them in as they render. */
  const buildFan = () => {
    fanned = true;
    const pages = annotatedPages(doc);
    const shown = pages.slice(0, MAX_FANNED);
    const mid = (shown.length - 1) / 2;
    const step =
      shown.length > 1
        ? Math.min(FAN_MAX_STEP, (2 * FAN_REACH) / (shown.length - 1))
        : 0;
    const sheets = shown.map((pageNumber, i) => {
      const sheet = createSheet(doc, pageNumber, FANNED_HEIGHT);
      // Few pages overlap like a hand of cards rather than spreading apart.
      const x = (i - mid) * step;
      sheet.style.setProperty("--x", `${Math.round(x)}px`);
      sheet.style.setProperty("--y", `${Math.abs(i - mid) * 3}px`);
      sheet.style.setProperty("--r", `${(i - mid) * FAN_TILT}deg`);
      sheet.style.setProperty("--i", String(i));
      sheet.style.marginLeft = `-${parseInt(sheet.style.width) / 2}px`;

      const flag = document.createElement("span");
      flag.className = "share-pile-flag";
      flag.textContent = String(pageNumber);
      sheet.appendChild(flag);
      fan.appendChild(sheet);
      return sheet;
    });
    if (pages.length > shown.length) {
      const more = document.createElement("span");
      more.className = "share-pile-more";
      more.textContent = `+${pages.length - shown.length}`;
      sheets[sheets.length - 1].appendChild(more);
    }

    // One at a time, so the viewer's own renders aren't starved.
    (async () => {
      for (let i = 0; i < shown.length; i++) {
        try {
          const canvas = await renderThumbnail(doc, shown[i], FANNED_HEIGHT);
          if (canvas) sheets[i].prepend(canvas);
        } catch (error) {
          console.warn(`Thumbnail for page ${shown[i]} failed:`, error);
        }
      }
    })();
  };

  return {
    el,
    showPages: (show) => {
      if (!topRendered) renderTop();
      const split = show && annotatedPages(doc).length > 0;
      if (split && !fanned) {
        buildFan();
        // Start the sheets in the stack, so the first split fans them out.
        void fan.offsetWidth;
      }
      el.classList.toggle("split", split);
    },
    setSize: (text) => {
      meta.textContent = [`${pageCount} ${pageWord}`, text]
        .filter(Boolean)
        .join(" · ");
    },
    addRow: (row) => foot.appendChild(row),
  };
}
