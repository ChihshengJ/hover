/**
 * DrawingCanvasLayer - Temporary HTML canvas overlay for real-time stroke rendering.
 * Uses canvas (not SVG) during active drawing for 60fps performance.
 * Positioned over the active page's rotateInner element.
 */
export class DrawingCanvasLayer {
  #canvas: HTMLCanvasElement | null = null;

  #ctx: CanvasRenderingContext2D | null = null;

  #parent: HTMLElement | null = null;

  /** devicePixelRatio the backing store and transform were sized for. */
  #dpr = 1;

  /** Size `ensureCanvas` was last asked for, in CSS px. */
  #width = 0;

  #height = 0;

  #lastX: number = 0;

  #lastY: number = 0;

  #lastMidX: number = 0;

  #lastMidY: number = 0;

  #hasFirstPoint: boolean = false;

  /**
   * Ensure a canvas overlay exists on the given page element.
   * Reuses the existing canvas if the parent hasn't changed.
   * @param pageRotateInner The page's rotateInner element
   * @param width CSS pixel width
   * @param height CSS pixel height
   */
  ensureCanvas(pageRotateInner: HTMLElement, width: number, height: number) {
    const dpr = window.devicePixelRatio || 1;

    // Reuse existing canvas if same parent, dimensions and pixel ratio match.
    // The ratio changes when the window moves to a display of another density;
    // a canvas sized for the old one would draw the live stroke blurry.
    if (
      this.#canvas &&
      this.#parent === pageRotateInner &&
      this.#dpr === dpr
    ) {
      const curW = Math.round(width);
      const curH = Math.round(height);
      const canW = Math.round(this.#width);
      const canH = Math.round(this.#height);
      if (curW === canW && curH === canH) return;
    }

    // Different page, dimensions or ratio — destroy old canvas and create new one
    this.destroy();

    this.#parent = pageRotateInner;
    this.#dpr = dpr;
    this.#width = width;
    this.#height = height;
    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "drawing-canvas-overlay";
    // Whole-pixel store with the CSS box derived from it, as the page canvases
    // do (see ViewerPane.layoutPages), so the stroke maps 1:1 to the screen.
    this.#canvas.width = Math.ceil(width * dpr);
    this.#canvas.height = Math.ceil(height * dpr);
    this.#canvas.style.width = `${this.#canvas.width / dpr}px`;
    this.#canvas.style.height = `${this.#canvas.height / dpr}px`;
    // Inline styles to override `.page-wrapper canvas { position: relative; z-index: 0 }`
    this.#canvas.style.position = "absolute";
    this.#canvas.style.zIndex = "100";

    this.#ctx = this.#canvas.getContext("2d");
    this.#ctx.scale(dpr, dpr);
    this.#ctx.lineCap = "round";
    this.#ctx.lineJoin = "round";

    this.#parent.appendChild(this.#canvas);
  }

  /**
   * Begin a new stroke.
   * @param x Page-relative pixel X
   * @param y Page-relative pixel Y
   * @param color CSS color string
   * @param lineWidth Stroke width in CSS pixels
   */
  beginStroke(x: number, y: number, color: string, lineWidth: number) {
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
   * @param x Page-relative pixel X
   * @param y Page-relative pixel Y
   */
  addPoint(x: number, y: number) {
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
    // In the units of the transform set at creation, not the current ratio:
    // after a display change the latter would clear only part of the canvas.
    this.#ctx.clearRect(
      0,
      0,
      this.#canvas.width / this.#dpr,
      this.#canvas.height / this.#dpr,
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
