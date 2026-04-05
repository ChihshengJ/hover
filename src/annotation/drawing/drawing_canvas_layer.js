/**
 * DrawingCanvasLayer - Temporary HTML canvas overlay for real-time stroke rendering.
 * Uses canvas (not SVG) during active drawing for 60fps performance.
 * Positioned over the active page's rotateInner element.
 */
export class DrawingCanvasLayer {
  /** @type {HTMLCanvasElement|null} */
  #canvas = null;

  /** @type {CanvasRenderingContext2D|null} */
  #ctx = null;

  /** @type {HTMLElement|null} */
  #parent = null;

  /** @type {number} */
  #lastX = 0;

  /** @type {number} */
  #lastY = 0;

  /** @type {number} */
  #lastMidX = 0;

  /** @type {number} */
  #lastMidY = 0;

  /** @type {boolean} */
  #hasFirstPoint = false;

  /**
   * Ensure a canvas overlay exists on the given page element.
   * Reuses the existing canvas if the parent hasn't changed.
   * @param {HTMLElement} pageRotateInner - The page's rotateInner element
   * @param {number} width - CSS pixel width
   * @param {number} height - CSS pixel height
   */
  ensureCanvas(pageRotateInner, width, height) {
    // Reuse existing canvas if same parent
    if (this.#canvas && this.#parent === pageRotateInner) return;

    // Different page — destroy old canvas and create new one
    this.destroy();

    this.#parent = pageRotateInner;
    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "drawing-canvas-overlay";
    this.#canvas.width = width * devicePixelRatio;
    this.#canvas.height = height * devicePixelRatio;
    this.#canvas.style.width = `${width}px`;
    this.#canvas.style.height = `${height}px`;
    // Inline styles to override `.page-wrapper canvas { position: relative; z-index: 0 }`
    this.#canvas.style.position = "absolute";
    this.#canvas.style.zIndex = "100";

    this.#ctx = this.#canvas.getContext("2d");
    this.#ctx.scale(devicePixelRatio, devicePixelRatio);
    this.#ctx.lineCap = "round";
    this.#ctx.lineJoin = "round";

    this.#parent.appendChild(this.#canvas);
  }

  /**
   * Begin a new stroke.
   * @param {number} x - Page-relative pixel X
   * @param {number} y - Page-relative pixel Y
   * @param {string} color - CSS color string
   * @param {number} lineWidth - Stroke width in CSS pixels
   */
  beginStroke(x, y, color, lineWidth) {
    if (!this.#ctx) return;
    this.#ctx.strokeStyle = color;
    this.#ctx.lineWidth = lineWidth;
    this.#lastX = x;
    this.#lastY = y;
    this.#lastMidX = x;
    this.#lastMidY = y;
    this.#hasFirstPoint = false;
  }

  /**
   * Add a point to the current stroke with quadratic bezier smoothing.
   * @param {number} x - Page-relative pixel X
   * @param {number} y - Page-relative pixel Y
   */
  addPoint(x, y) {
    if (!this.#ctx) return;

    const midX = (this.#lastX + x) / 2;
    const midY = (this.#lastY + y) / 2;

    this.#ctx.beginPath();
    if (!this.#hasFirstPoint) {
      // First segment: just a line from start to midpoint
      this.#ctx.moveTo(this.#lastX, this.#lastY);
      this.#ctx.lineTo(midX, midY);
      this.#hasFirstPoint = true;
    } else {
      // Subsequent segments: curve from last midpoint through last point to new midpoint
      this.#ctx.moveTo(this.#lastMidX, this.#lastMidY);
      this.#ctx.quadraticCurveTo(this.#lastX, this.#lastY, midX, midY);
    }
    this.#ctx.stroke();

    this.#lastX = x;
    this.#lastY = y;
    this.#lastMidX = midX;
    this.#lastMidY = midY;
  }

  /**
   * End the current stroke (draw final segment to last point).
   */
  endStroke() {
    if (!this.#ctx || !this.#hasFirstPoint) return;
    this.#ctx.beginPath();
    this.#ctx.moveTo(this.#lastMidX, this.#lastMidY);
    this.#ctx.lineTo(this.#lastX, this.#lastY);
    this.#ctx.stroke();
  }

  /**
   * Clear the canvas contents.
   */
  clear() {
    if (!this.#ctx || !this.#canvas) return;
    this.#ctx.clearRect(
      0,
      0,
      this.#canvas.width / devicePixelRatio,
      this.#canvas.height / devicePixelRatio,
    );
  }

  /**
   * Remove the canvas from the DOM and clean up.
   */
  destroy() {
    if (this.#canvas) {
      this.#canvas.remove();
      this.#canvas = null;
    }
    this.#ctx = null;
    this.#parent = null;
    this.#hasFirstPoint = false;
  }
}
