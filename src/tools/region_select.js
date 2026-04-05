/**
 * Region-select tool: drag-select a rectangular region on a PDF page,
 * render it at high resolution via PDFium WASM, and open in the image modal.
 *
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager
 * @typedef {import('../page.js').PageView} PageView
 */

import { getSharedImageModal } from "../controls/image_modal.js";

const MIN_SELECTION_PX = 5;
const RENDER_SCALE_FACTOR = 3;
const MAX_BITMAP_DIM = 8192;

export class RegionSelectController {
  /** @type {SplitWindowManager} */
  #wm;
  #isActive = false;
  #isDragging = false;

  /** @type {HTMLDivElement|null} */
  #overlay = null;
  /** @type {PageView|null} */
  #startPage = null;
  #startX = 0;
  #startY = 0;

  /** @type {HTMLElement|null} */
  #boundScroller = null;

  // Bound event handlers (arrow functions for stable references)
  #onPointerDown = (e) => this.#handlePointerDown(e);
  #onPointerMove = (e) => this.#handlePointerMove(e);
  #onPointerUp = (e) => this.#handlePointerUp(e);
  #onKeyDown = (e) => this.#handleKeyDown(e);

  /**
   * @param {SplitWindowManager} wm
   */
  constructor(wm) {
    this.#wm = wm;
  }

  get isActive() {
    return this.#isActive;
  }

  activate() {
    if (this.#isActive) return;
    const pane = this.#wm.activePane;
    if (!pane?.scroller) return;

    this.#isActive = true;
    this.#boundScroller = pane.scroller;
    this.#boundScroller.classList.add("region-select-active");
    this.#boundScroller.addEventListener("pointerdown", this.#onPointerDown);
    document.addEventListener("keydown", this.#onKeyDown);
  }

  deactivate() {
    if (!this.#isActive) return;
    this.#isActive = false;

    this.#cancelDrag();
    this.#removeOverlay();

    if (this.#boundScroller) {
      this.#boundScroller.classList.remove("region-select-active");
      this.#boundScroller.removeEventListener(
        "pointerdown",
        this.#onPointerDown,
      );
      this.#boundScroller = null;
    }

    document.removeEventListener("keydown", this.#onKeyDown);
    document.getSelection()?.removeAllRanges();
  }

  // ===========================================================================
  // Event handlers
  // ===========================================================================

  /** @param {PointerEvent} e */
  #handlePointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest("a, button, .pane-controls")) return;

    const page = this.#findPageFromPoint(e.clientX, e.clientY);
    if (!page) return;

    e.preventDefault();

    this.#isDragging = true;
    this.#startPage = page;

    const coords = this.#clientToPageCoords(e.clientX, e.clientY, page);
    this.#startX = coords.x;
    this.#startY = coords.y;

    this.#createOverlay(page, coords.x, coords.y);

    document.addEventListener("pointermove", this.#onPointerMove);
    document.addEventListener("pointerup", this.#onPointerUp);
  }

  /** @param {PointerEvent} e */
  #handlePointerMove(e) {
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

  /** @param {PointerEvent} e */
  #handlePointerUp(e) {
    if (!this.#isDragging || !this.#startPage) return;

    document.removeEventListener("pointermove", this.#onPointerMove);
    document.removeEventListener("pointerup", this.#onPointerUp);
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
    this.#removeOverlay();
    this.#startPage = null;

    if (width < MIN_SELECTION_PX || height < MIN_SELECTION_PX) return;

    const imageData = this.#renderRegion(page, { left, top, width, height });
    if (imageData) {
      this.deactivate();
      getSharedImageModal().show({ getPixelData: () => imageData });
    }
  }

  /** @param {KeyboardEvent} e */
  #handleKeyDown(e) {
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

  /**
   * @param {PageView} pageView
   * @param {number} x
   * @param {number} y
   */
  #createOverlay(pageView, x, y) {
    this.#removeOverlay();
    this.#overlay = document.createElement("div");
    this.#overlay.className = "region-select-overlay";
    this.#overlay.style.left = `${x}px`;
    this.#overlay.style.top = `${y}px`;
    this.#overlay.style.width = "0px";
    this.#overlay.style.height = "0px";
    pageView.rotateInner.appendChild(this.#overlay);
  }

  /**
   * @param {number} currentX
   * @param {number} currentY
   */
  #updateOverlay(currentX, currentY) {
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
    this.#isDragging = false;
    this.#startPage = null;
    document.removeEventListener("pointermove", this.#onPointerMove);
    document.removeEventListener("pointerup", this.#onPointerUp);
  }

  // ===========================================================================
  // Page hit-testing & coordinate conversion
  // ===========================================================================

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {PageView|null}
   */
  #findPageFromPoint(clientX, clientY) {
    const pane = this.#wm.activePane;
    if (!pane) return null;

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

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {PageView} pageView
   * @returns {{x: number, y: number}}
   */
  #clientToPageCoords(clientX, clientY, pageView) {
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
   * @param {PageView} pageView
   * @param {{left: number, top: number, width: number, height: number}} rect - CSS pixels
   * @returns {ImageData|null}
   */
  #renderRegion(pageView, rect) {
    const pane = this.#wm.activePane;
    if (!pane) return null;

    const doc = pane.document;
    const handle = doc.lowLevelHandle;
    if (!handle) {
      console.warn("[RegionSelect] Low-level handle unavailable");
      return null;
    }

    const pdfium = handle.pdfium;
    const docPtr = handle.docPtr;
    const pageIndex = pageView.pageNumber - 1;
    const dims = doc.pageDimensions[pageIndex];
    if (!dims) return null;

    const pageWidthPdf = dims.width;
    const pageHeightPdf = dims.height;

    // textScale: CSS pixels per PDF unit
    const cssWidth = parseFloat(pageView.canvas.style.width);
    const textScale = cssWidth / pageWidthPdf;

    // Convert CSS pixel rect to PDF units (screen-oriented, Y-down)
    const regionLeftPdf = rect.left / textScale;
    const regionTopPdf = rect.top / textScale;
    const regionWidthPdf = rect.width / textScale;
    const regionHeightPdf = rect.height / textScale;

    // Compute render scale, capping bitmap dimensions
    let S = RENDER_SCALE_FACTOR * textScale;
    if (regionWidthPdf * S > MAX_BITMAP_DIM) {
      S = MAX_BITMAP_DIM / regionWidthPdf;
    }
    if (regionHeightPdf * S > MAX_BITMAP_DIM) {
      S = MAX_BITMAP_DIM / regionHeightPdf;
    }

    const bitmapW = Math.max(1, Math.ceil(regionWidthPdf * S));
    const bitmapH = Math.max(1, Math.ceil(regionHeightPdf * S));

    const bitmapPtr = pdfium.FPDFBitmap_Create(bitmapW, bitmapH, 0);
    if (!bitmapPtr) {
      console.warn("[RegionSelect] Failed to create bitmap");
      return null;
    }

    try {
      // White background
      pdfium.FPDFBitmap_FillRect(bitmapPtr, 0, 0, bitmapW, bitmapH, 0xffffffff);

      const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
      if (!pagePtr) return null;

      try {
        const sizeX = Math.ceil(pageWidthPdf * S);
        const sizeY = Math.ceil(pageHeightPdf * S);
        const startX = Math.round(-regionLeftPdf * S);
        const startY = Math.round(-regionTopPdf * S);

        // flags: FPDF_ANNOT (0x01) | FPDF_PRINTING (0x800)
        pdfium.FPDF_RenderPageBitmap(
          bitmapPtr,
          pagePtr,
          startX,
          startY,
          sizeX,
          sizeY,
          0,
          0x01 | 0x800,
        );
      } finally {
        pdfium.FPDF_ClosePage(pagePtr);
      }

      // Read BGRA pixels and convert to RGBA
      const stride = pdfium.FPDFBitmap_GetStride(bitmapPtr);
      const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
      if (!bufferPtr) return null;

      const src = pdfium.pdfium.HEAPU8.subarray(
        bufferPtr,
        bufferPtr + bitmapH * stride,
      );
      const rgba = new Uint8ClampedArray(bitmapW * bitmapH * 4);

      for (let row = 0; row < bitmapH; row++) {
        const rowOff = row * stride;
        for (let col = 0; col < bitmapW; col++) {
          const s = rowOff + col * 4;
          const dst = (row * bitmapW + col) * 4;
          rgba[dst] = src[s + 2]; // R <- B
          rgba[dst + 1] = src[s + 1]; // G
          rgba[dst + 2] = src[s]; // B <- R
          rgba[dst + 3] = 255; // A (opaque, bitmap has no alpha)
        }
      }

      return new ImageData(rgba, bitmapW, bitmapH);
    } finally {
      pdfium.FPDFBitmap_Destroy(bitmapPtr);
    }
  }
}
