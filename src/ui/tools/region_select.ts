/**
 * Region-select tool: drag-select a rectangular region on a PDF page,
 * render it at high resolution via PDFium WASM, and open in the image modal.
 *
 * @typedef {SplitWindowManager} SplitWindowManager
 * @typedef {PageView} PageView
 */

import { getSharedImageModal } from "../controls/image_modal.js";
import { onPointerDrag } from "../../viewer/pointer_gesture.js";
import {
  TEXT_GAMMA_ENABLED,
  applyTextGamma,
} from "../../viewer/text_gamma.js";
import { PaneToolBinding } from "./pane_tool_binding.js";
import { renderRect } from "../../pdf/renderer.js";

import type { PageView } from "../../viewer/page.js";
import type { ViewerPane } from "../../viewer/viewpane.js";
import type { SplitWindowManager } from "../../viewer/window_manager.js";
const MIN_SELECTION_PX = 5;
const RENDER_SCALE_FACTOR = 3;
const MAX_BITMAP_DIM = 8192;

export class RegionSelectController {
  #wm: SplitWindowManager;
  #isActive = false;
  #isDragging = false;

  #overlay: HTMLDivElement | null = null;
  #startPage: PageView | null = null;
  #startX = 0;
  #startY = 0;

  /** Pointer ownership and the per-pane listeners; see pane_tool_binding.js. */
  #binding: PaneToolBinding;

  /** The pane the live drag started in. */
  #gesturePane: ViewerPane | null = null;

  /** Ends the active drag early (deactivate / Escape). */
  #endDrag: (() => void) | null = null;

  // Bound event handlers (arrow functions for stable references)
  #onPointerDown = (e: PointerEvent) => this.#handlePointerDown(e);
  #onPointerMove = (e: PointerEvent) => this.#handlePointerMove(e);
  #onPointerUp = (e: PointerEvent) => this.#handlePointerUp(e);
  #onKeyDown = (e: KeyboardEvent) => this.#handleKeyDown(e);

  constructor(wm: SplitWindowManager) {
    this.#wm = wm;
    this.#binding = new PaneToolBinding(wm, {
      className: "region-select-active",
      onPointerDown: this.#onPointerDown,
    });
  }

  get isActive() {
    return this.#isActive;
  }

  activate() {
    if (this.#isActive) return;
    if (!this.#wm.activePane?.scroller) return;

    this.#isActive = true;
    this.#binding.attach();
    document.addEventListener("keydown", this.#onKeyDown);
  }

  /** Called by the pane lifecycle when a pane appears or goes away. */
  syncPanes() {
    this.#binding.sync();
  }

  deactivate() {
    if (!this.#isActive) return;
    this.#isActive = false;

    this.#cancelDrag();
    this.#removeOverlay();

    this.#binding.detach();
    this.#gesturePane = null;

    document.removeEventListener("keydown", this.#onKeyDown);
    document.getSelection()?.removeAllRanges();
  }

  // ===========================================================================
  // Event handlers
  // ===========================================================================

  #handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("a, button, .pane-controls")) return;

    const pane = this.#binding.paneFor(e);
    if (!pane) return;

    const page = this.#findPageFromPoint(e.clientX, e.clientY, pane);
    if (!page) return;

    e.preventDefault();

    this.#gesturePane = pane;
    this.#isDragging = true;
    this.#startPage = page;

    const coords = this.#clientToPageCoords(e.clientX, e.clientY, page);
    this.#startX = coords.x;
    this.#startY = coords.y;

    this.#createOverlay(page, coords.x, coords.y);

    this.#endDrag = onPointerDrag(e, {
      onMove: this.#onPointerMove,
      onEnd: this.#onPointerUp,
    });
  }

  #handlePointerMove(e: PointerEvent) {
    if (!this.#isDragging || !this.#startPage) return;
    e.preventDefault();

    const coords = this.#clientToPageCoords(
      e.clientX,
      e.clientY,
      this.#startPage,
    );

    // Clamp to page bounds
    const inner = this.#startPage.rotateInner;
    const x = Math.max(0, Math.min(coords.x, inner.offsetWidth));
    const y = Math.max(0, Math.min(coords.y, inner.offsetHeight));

    this.#updateOverlay(x, y);
  }

  #handlePointerUp(e: PointerEvent) {
    this.#endDrag = null;
    if (!this.#isDragging || !this.#startPage) return;

    this.#isDragging = false;

    const coords = this.#clientToPageCoords(
      e.clientX,
      e.clientY,
      this.#startPage,
    );
    const inner = this.#startPage.rotateInner;
    const cx = Math.max(0, Math.min(coords.x, inner.offsetWidth));
    const cy = Math.max(0, Math.min(coords.y, inner.offsetHeight));

    const left = Math.min(this.#startX, cx);
    const top = Math.min(this.#startY, cy);
    const width = Math.abs(cx - this.#startX);
    const height = Math.abs(cy - this.#startY);

    const page = this.#startPage;
    const pane = this.#gesturePane;
    this.#removeOverlay();
    this.#startPage = null;
    this.#gesturePane = null;

    if (width < MIN_SELECTION_PX || height < MIN_SELECTION_PX) return;
    if (!pane) return;

    const imageData = this.#renderRegion(
      page,
      { left, top, width, height },
      pane,
    );
    if (imageData) {
      this.deactivate();
      getSharedImageModal().show({ getPixelData: () => imageData });
    }
  }

  #handleKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();

    if (this.#isDragging) {
      this.#cancelDrag();
      this.#removeOverlay();
    }
  }

  // ===========================================================================
  // Overlay management
  // ===========================================================================

  #createOverlay(pageView: PageView, x: number, y: number) {
    this.#removeOverlay();
    this.#overlay = document.createElement("div");
    this.#overlay.className = "region-select-overlay";
    this.#overlay.style.left = `${x}px`;
    this.#overlay.style.top = `${y}px`;
    this.#overlay.style.width = "0px";
    this.#overlay.style.height = "0px";
    pageView.rotateInner.appendChild(this.#overlay);
  }

  #updateOverlay(currentX: number, currentY: number) {
    if (!this.#overlay) return;
    const left = Math.min(this.#startX, currentX);
    const top = Math.min(this.#startY, currentY);
    const width = Math.abs(currentX - this.#startX);
    const height = Math.abs(currentY - this.#startY);
    this.#overlay.style.left = `${left}px`;
    this.#overlay.style.top = `${top}px`;
    this.#overlay.style.width = `${width}px`;
    this.#overlay.style.height = `${height}px`;
  }

  #removeOverlay() {
    if (this.#overlay) {
      this.#overlay.remove();
      this.#overlay = null;
    }
  }

  #cancelDrag() {
    if (!this.#isDragging) return;
    // Cleared first so the onEnd below short-circuits instead of cropping.
    this.#isDragging = false;
    this.#startPage = null;
    this.#gesturePane = null;
    this.#endDrag?.();
    this.#endDrag = null;
  }

  // ===========================================================================
  // Page hit-testing & coordinate conversion
  // ===========================================================================

  #findPageFromPoint(
    clientX: number,
    clientY: number,
    pane: ViewerPane,
  ): PageView | null {
    for (const pageView of pane.pages) {
      const rect = pageView.rotateInner.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return pageView;
      }
    }
    return null;
  }

  #clientToPageCoords(
    clientX: number,
    clientY: number,
    pageView: PageView,
  ): { x: number; y: number } {
    const rect = pageView.rotateInner.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  // ===========================================================================
  // High-resolution region rendering via PDFium WASM
  // ===========================================================================

  /**
   * @param rect CSS pixels
   */
  #renderRegion(
    pageView: PageView,
    rect: { left: number; top: number; width: number; height: number },
    pane: ViewerPane,
  ): ImageData | null {
    const doc = pane.document;
    const pdf = doc.document;
    if (!pdf) {
      console.warn("[RegionSelect] No document open");
      return null;
    }

    const pageIndex = pageView.pageNumber - 1;
    const dims = doc.pageDimensions[pageIndex];
    if (!dims) return null;

    const pageWidthPdf = dims.width;
    const pageHeightPdf = dims.height;

    // textScale: CSS pixels per PDF unit
    const cssWidth = parseFloat(pageView.canvas.style.width);
    const textScale = cssWidth / pageWidthPdf;

    // Convert CSS pixel rect to PDF units (screen-oriented, Y-down)
    const region = {
      x: rect.left / textScale,
      y: rect.top / textScale,
      width: rect.width / textScale,
      height: rect.height / textScale,
    };

    // Compute render scale, capping bitmap dimensions
    let S = RENDER_SCALE_FACTOR * textScale;
    if (region.width * S > MAX_BITMAP_DIM) {
      S = MAX_BITMAP_DIM / region.width;
    }
    if (region.height * S > MAX_BITMAP_DIM) {
      S = MAX_BITMAP_DIM / region.height;
    }

    // The viewer's renderer, so the crop matches the page on screen. Not
    // PDFium's annotation pass (FPDF_ANNOT): building a page's annotation
    // list makes PDFium stamp its private /PDFIUM_HasGeneratedAP on every
    // annotation there, and this document is the one that gets saved.
    let pixels;
    try {
      pixels = renderRect(pdf, pageIndex, S, region);
    } catch (error) {
      console.warn("[RegionSelect] Render failed:", error);
      return null;
    }
    const { data, width, height } = pixels;

    // Match the on-screen text weight.
    if (TEXT_GAMMA_ENABLED) {
      const boxes = doc.getPageTextBoxes(pageIndex);
      if (boxes) {
        const sx = width / region.width;
        const sy = height / region.height;
        applyTextGamma(data, width, height, boxes, {
          x: -region.x * sx,
          y: -region.y * sy,
          width: pageWidthPdf * sx,
          height: pageHeightPdf * sy,
        });
      }
    }

    return new ImageData(data, width, height);
  }
}
