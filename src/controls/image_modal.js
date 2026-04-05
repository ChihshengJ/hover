/**
 * Full-screen image modal with zoom and copy-to-clipboard.
 * Singleton pattern — use getSharedImageModal().
 */

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;
const ZOOM_SENSITIVITY = 0.002;
const PINCH_SENSITIVITY = 0.01;

let instance = null;

export function getSharedImageModal() {
  if (!instance) instance = new ImageModal();
  return instance;
}

class ImageModal {
  constructor() {
    /** @type {HTMLElement} */
    this.backdrop = null;
    /** @type {HTMLImageElement} */
    this.img = null;
    /** @type {HTMLButtonElement} */
    this.copyBtn = null;
    /** @type {HTMLCanvasElement|null} */
    this._canvas = null;

    this._scale = 1;
    this._translateX = 0;
    this._translateY = 0;
    this._isDragging = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragBaseX = 0;
    this._dragBaseY = 0;
    this._visible = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onWheel = this._onWheel.bind(this);

    this.#createDOM();
  }

  #createDOM() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "image-modal-backdrop";

    const container = document.createElement("div");
    container.className = "image-modal-container";

    this.img = document.createElement("img");
    this.img.className = "image-modal-img";
    this.img.draggable = false;

    container.appendChild(this.img);
    this.backdrop.appendChild(container);

    // Copy button
    this.copyBtn = document.createElement("button");
    this.copyBtn.className = "image-modal-copy-btn";
    this.copyBtn.title = "Copy image";
    this.copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    this.backdrop.appendChild(this.copyBtn);

    // Events
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop || e.target.classList.contains("image-modal-container")) {
        this.hide();
      }
    });

    this.img.addEventListener("mousedown", (e) => {
      if (this._scale <= 1) return;
      e.preventDefault();
      this._isDragging = true;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._dragBaseX = this._translateX;
      this._dragBaseY = this._translateY;
      this.img.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (!this._isDragging) return;
      this._translateX = this._dragBaseX + (e.clientX - this._dragStartX);
      this._translateY = this._dragBaseY + (e.clientY - this._dragStartY);
      this.#applyTransform();
    });

    window.addEventListener("mouseup", () => {
      if (!this._isDragging) return;
      this._isDragging = false;
      this.img.style.cursor = this._scale > 1 ? "grab" : "";
    });

    this.copyBtn.addEventListener("click", () => this.#handleCopy());

    document.body.appendChild(this.backdrop);
  }

  /**
   * @param {import('../data/image_extractor.js').ImageObjectInfo} imageInfo
   */
  show(imageInfo) {
    const pixelData = imageInfo.getPixelData();
    if (!pixelData) return;

    const canvas = document.createElement("canvas");
    canvas.width = pixelData.width;
    canvas.height = pixelData.height;
    canvas.getContext("2d").putImageData(pixelData, 0, 0);
    this._canvas = canvas;

    this.img.src = canvas.toDataURL("image/png");

    this._scale = 1;
    this._translateX = 0;
    this._translateY = 0;
    this.#applyTransform();
    this.img.style.cursor = "";

    this.#resetCopyBtn();

    this.backdrop.classList.add("visible");
    this._visible = true;

    document.addEventListener("keydown", this._onKeyDown);
    this.backdrop.addEventListener("wheel", this._onWheel, { passive: false });
  }

  hide() {
    if (!this._visible) return;

    this.backdrop.classList.remove("visible");
    this._visible = false;
    this._isDragging = false;

    document.removeEventListener("keydown", this._onKeyDown);
    this.backdrop.removeEventListener("wheel", this._onWheel);

    // Defer cleanup so fade-out animation completes
    setTimeout(() => {
      if (!this._visible) {
        this.img.src = "";
        this._canvas = null;
      }
    }, 300);
  }

  _onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
    }
  }

  _onWheel(e) {
    e.preventDefault();

    // ctrlKey is set for trackpad pinch gestures
    const delta = e.ctrlKey
      ? -e.deltaY * PINCH_SENSITIVITY
      : -e.deltaY * ZOOM_SENSITIVITY;

    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this._scale * (1 + delta)));
    if (newScale === this._scale) return;

    // Zoom toward cursor: adjust translate so the point under the cursor stays fixed
    const rect = this.img.getBoundingClientRect();
    const imgCenterX = rect.left + rect.width / 2;
    const imgCenterY = rect.top + rect.height / 2;
    const cursorOffsetX = e.clientX - imgCenterX;
    const cursorOffsetY = e.clientY - imgCenterY;

    const ratio = 1 - newScale / this._scale;
    this._translateX += cursorOffsetX * ratio;
    this._translateY += cursorOffsetY * ratio;

    this._scale = newScale;
    this.img.style.cursor = this._scale > 1 ? "grab" : "";
    this.#applyTransform();
  }

  #applyTransform() {
    this.img.style.transform =
      `translate(${this._translateX}px, ${this._translateY}px) scale(${this._scale})`;
  }

  async #handleCopy() {
    if (!this._canvas) return;

    try {
      const blob = await new Promise((resolve) =>
        this._canvas.toBlob(resolve, "image/png"),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      this.#showCopiedFeedback();
    } catch (err) {
      console.error("[ImageModal] Copy failed:", err);
    }
  }

  #showCopiedFeedback() {
    this.copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    this.copyBtn.classList.add("copied");
    setTimeout(() => this.#resetCopyBtn(), 1500);
  }

  #resetCopyBtn() {
    this.copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    this.copyBtn.classList.remove("copied");
  }
}
