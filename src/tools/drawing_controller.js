/**
 * DrawingController - Freehand drawing tool for PDF annotation.
 *
 * Manages activate/deactivate state, pointer event capture, stroke collection,
 * and 3-second inactivity commit timer. Each committed group of strokes
 * becomes one "drawing" annotation.
 *
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager
 * @typedef {import('../controls/action_button.js').ActionButton} ActionButton
 * @typedef {import('../page.js').PageView} PageView
 */

import { DrawingCanvasLayer } from "../annotation/drawing/drawing_canvas_layer.js";
import { DrawingToolbar } from "../annotation/drawing/drawing_toolbar.js";
import { LazyBrush } from "../annotation/drawing/lazy_brush.js";

const COMMIT_DELAY_MS = 1000;

const STROKE_WIDTHS = {
  thin: 0.0015,
  medium: 0.003,
  thick: 0.006,
};

export class DrawingController {
  /** @type {SplitWindowManager} */
  #wm;

  /** @type {ActionButton} */
  #actionButton;

  #isActive = false;
  #isDrawing = false;

  /** @type {{x: number, y: number}[]} */
  #currentStroke = [];

  /** @type {Array<{points: {x:number,y:number}[], strokeWidth: number}>} */
  #pendingStrokes = [];

  /** @type {number|null} */
  #commitTimer = null;

  /** @type {PageView|null} */
  #currentPage = null;

  /** @type {string} */
  #color = "black";

  /** @type {string} */
  #strokeWidthName = "medium";

  /** @type {HTMLElement|null} */
  #boundScroller = null;

  /** @type {DrawingCanvasLayer|null} */
  #canvasLayer = null;

  /** @type {DrawingToolbar|null} */
  #toolbar = null;

  /** @type {LazyBrush} */
  #lazyBrush = new LazyBrush({ radius: 8 });

  /** @type {HTMLElement|null} */
  #brushCursor = null;

  // Bound event handlers
  #onPointerDown = (e) => this.#handlePointerDown(e);
  #onPointerMove = (e) => this.#handlePointerMove(e);
  #onPointerUp = (e) => this.#handlePointerUp(e);
  #onKeyDown = (e) => this.#handleKeyDown(e);

  /**
   * @param {SplitWindowManager} wm
   * @param {ActionButton} actionButton
   */
  constructor(wm, actionButton) {
    this.#wm = wm;
    this.#actionButton = actionButton;
  }

  get isActive() {
    return this.#isActive;
  }

  // =========================================================================
  // Activate / Deactivate
  // =========================================================================

  activate() {
    if (this.#isActive) return;
    const pane = this.#wm.activePane;
    if (!pane?.scroller) return;

    this.#isActive = true;
    this.#boundScroller = pane.scroller;
    this.#boundScroller.classList.add("drawing-mode-active");

    // Clear any existing text selection to prevent annotation toolbar from firing
    document.getSelection()?.removeAllRanges();

    this.#boundScroller.addEventListener("pointerdown", this.#onPointerDown);
    document.addEventListener("keydown", this.#onKeyDown);

    // Create canvas layer
    this.#canvasLayer = new DrawingCanvasLayer();
    // Canvas is created per-page on first stroke

    // Create toolbar
    this.#toolbar = new DrawingToolbar({
      onColorChange: (color) => this.setColor(color),
      onWidthChange: (width) => this.setStrokeWidth(width),
    });
    this.#toolbar.show(this.#actionButton.container);

    // Create brush cursor indicator
    this.#brushCursor = document.createElement("div");
    this.#brushCursor.className = "lazy-brush-cursor";
    Object.assign(this.#brushCursor.style, {
      position: "fixed",
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      background: "rgba(0, 0, 0, 0.5)",
      border: "1px solid rgba(255, 255, 255, 0.8)",
      pointerEvents: "none",
      zIndex: "10000",
      display: "none",
      transform: "translate(-50%, -50%)",
    });
    document.body.appendChild(this.#brushCursor);

    // Signal active state on the action button
    this.#actionButton.setToolActive(true);
  }

  deactivate() {
    if (!this.#isActive) return;

    // Finalize in-progress stroke if any
    if (this.#isDrawing) {
      this.#finalizeCurrentStroke();
    }

    // Commit pending strokes immediately
    if (this.#pendingStrokes.length > 0) {
      clearTimeout(this.#commitTimer);
      this.#commitTimer = null;
      this.#commitDrawing();
    }

    this.#isActive = false;

    if (this.#boundScroller) {
      this.#boundScroller.classList.remove("drawing-mode-active");
      this.#boundScroller.removeEventListener(
        "pointerdown",
        this.#onPointerDown,
      );
      this.#boundScroller = null;
    }

    document.removeEventListener("keydown", this.#onKeyDown);

    this.#canvasLayer?.destroy();
    this.#canvasLayer = null;

    this.#toolbar?.destroy();
    this.#toolbar = null;

    this.#brushCursor?.remove();
    this.#brushCursor = null;

    this.#actionButton.setToolActive(false);

    document.getSelection()?.removeAllRanges();
  }

  // =========================================================================
  // Event Handlers
  // =========================================================================

  /** @param {PointerEvent} e */
  #handlePointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest(".drawing-toolbar, .action-btn-container, button, a"))
      return;

    // Skip drawing if clicking on an existing drawing annotation (let selection handle it)
    if (e.target.closest(".annotation-mark.drawing")) return;



    const pane = this.#wm.activePane;
    if (!pane) return;

    const page = this.#findPageFromPoint(e.clientX, e.clientY, pane);
    if (!page) return;

    e.preventDefault();

    // Cancel commit timer (new stroke within the 3s window)
    if (this.#commitTimer !== null) {
      clearTimeout(this.#commitTimer);
      this.#commitTimer = null;
    }

    this.#isDrawing = true;
    this.#currentPage = page;
    this.#currentStroke = [];

    // Ensure canvas is set up on this page (reuses if same page)
    const inner = page.rotateInner;
    const width = parseFloat(page.textLayer.style.width) || inner.offsetWidth;
    const height =
      parseFloat(page.textLayer.style.height) || inner.offsetHeight;
    this.#canvasLayer.ensureCanvas(inner, width, height);

    // First point — snap lazy brush to start position
    const coords = this.#clientToPageCoords(e.clientX, e.clientY, page);
    this.#lazyBrush.update({ x: coords.x, y: coords.y }, { both: true });
    const brush = this.#lazyBrush.getBrushCoordinates();
    const norm = this.#pixelToNormalized(brush.x, brush.y, page);
    this.#currentStroke.push(norm);

    const strokeWidthPx = this.#getStrokeWidthPx(page);
    const hexColor = this.#getColorHex();
    this.#canvasLayer.beginStroke(brush.x, brush.y, hexColor, strokeWidthPx);

    this.#updateBrushCursor(brush, page);

    document.addEventListener("pointermove", this.#onPointerMove);
    document.addEventListener("pointerup", this.#onPointerUp);
  }

  /** @param {PointerEvent} e */
  #handlePointerMove(e) {
    if (!this.#isDrawing || !this.#currentPage) return;
    e.preventDefault();

    const coords = this.#clientToPageCoords(
      e.clientX,
      e.clientY,
      this.#currentPage,
    );

    // Clamp to page bounds
    const inner = this.#currentPage.rotateInner;
    const x = Math.max(0, Math.min(coords.x, inner.offsetWidth));
    const y = Math.max(0, Math.min(coords.y, inner.offsetHeight));

    this.#lazyBrush.update({ x, y }, { friction: 0.01 });
    if (!this.#lazyBrush.brushHasMoved()) return;

    const brush = this.#lazyBrush.getBrushCoordinates();
    const norm = this.#pixelToNormalized(brush.x, brush.y, this.#currentPage);
    this.#currentStroke.push(norm);

    this.#canvasLayer.addPoint(brush.x, brush.y);
    this.#updateBrushCursor(brush, this.#currentPage);
  }

  /** @param {PointerEvent} e */
  #handlePointerUp(e) {
    if (!this.#isDrawing || !this.#currentPage) return;

    document.removeEventListener("pointermove", this.#onPointerMove);
    document.removeEventListener("pointerup", this.#onPointerUp);

    if (this.#brushCursor) this.#brushCursor.style.display = "none";

    this.#finalizeCurrentStroke();

    // Start 3-second commit timer
    this.#commitTimer = setTimeout(() => {
      this.#commitTimer = null;
      this.#commitDrawing();
    }, COMMIT_DELAY_MS);
  }

  /** @param {KeyboardEvent} e */
  #handleKeyDown(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.deactivate();
  }

  // =========================================================================
  // Stroke Finalization & Commit
  // =========================================================================

  #finalizeCurrentStroke() {
    if (this.#currentStroke.length < 2) {
      // Too few points, discard
      this.#currentStroke = [];
      this.#isDrawing = false;
      return;
    }

    // Simplify the stroke
    const simplified = simplifyStroke(this.#currentStroke, 0.001);

    this.#pendingStrokes.push({
      points: simplified,
      strokeWidth: STROKE_WIDTHS[this.#strokeWidthName] || STROKE_WIDTHS.medium,
    });

    this.#canvasLayer?.endStroke();
    this.#currentStroke = [];
    this.#isDrawing = false;
  }

  async #commitDrawing() {
    if (this.#pendingStrokes.length === 0) return;

    const pane = this.#wm.activePane;
    if (!pane || !this.#currentPage) return;

    const pageNumber = this.#currentPage.pageNumber;

    // Compute bounding rect from all stroke points
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;
    for (const stroke of this.#pendingStrokes) {
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    if (!isFinite(minX)) {
      this.#pendingStrokes = [];
      return;
    }

    const annotationData = {
      type: "drawing",
      color: this.#color,
      pageRanges: [
        {
          pageNumber,
          rects: [
            {
              leftRatio: minX,
              topRatio: minY,
              widthRatio: maxX - minX,
              heightRatio: maxY - minY,
            },
          ],
          text: "",
        },
      ],
      strokes: this.#pendingStrokes,
      rotation: 0,
    };

    const annotation = await pane.document.addAnnotation(annotationData);

    // Clear canvas and pending state
    this.#canvasLayer?.clear();
    this.#pendingStrokes = [];

    // Auto-select the committed drawing as visual feedback
    requestAnimationFrame(() => {
      pane.onAnnotationClick?.(annotation.id);
    });
  }

  // =========================================================================
  // Color & Width
  // =========================================================================

  setColor(colorName) {
    this.#color = colorName;
  }

  setStrokeWidth(widthName) {
    this.#strokeWidthName = widthName;
  }

  #getColorHex() {
    const map = {
      black: "#000000",
      yellow: "#FFB300",
      red: "#E53935",
      blue: "#1E88E5",
      green: "#43A047",
    };
    return map[this.#color] || "#000000";
  }

  #getStrokeWidthPx(pageView) {
    const layerWidth =
      parseFloat(pageView.textLayer.style.width) ||
      pageView.rotateInner.offsetWidth;
    return (
      (STROKE_WIDTHS[this.#strokeWidthName] || STROKE_WIDTHS.medium) *
      layerWidth
    );
  }

  // =========================================================================
  // Coordinate Helpers
  // =========================================================================

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {import('../viewpane.js').ViewerPane} pane
   * @returns {PageView|null}
   */
  #findPageFromPoint(clientX, clientY, pane) {
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
  #updateBrushCursor(brush, page) {
    if (!this.#brushCursor) return;
    const rect = page.rotateInner.getBoundingClientRect();
    this.#brushCursor.style.left = `${rect.left + brush.x}px`;
    this.#brushCursor.style.top = `${rect.top + brush.y}px`;
    this.#brushCursor.style.display = "block";
  }

  #clientToPageCoords(clientX, clientY, pageView) {
    const rect = pageView.rotateInner.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  /**
   * Convert pixel coordinates to normalized 0-1 ratios.
   * @param {number} x - Page-relative pixel X
   * @param {number} y - Page-relative pixel Y
   * @param {PageView} pageView
   * @returns {{x: number, y: number}}
   */
  #pixelToNormalized(x, y, pageView) {
    const layerWidth =
      parseFloat(pageView.textLayer.style.width) ||
      pageView.rotateInner.offsetWidth;
    const layerHeight =
      parseFloat(pageView.textLayer.style.height) ||
      pageView.rotateInner.offsetHeight;
    return {
      x: x / layerWidth,
      y: y / layerHeight,
    };
  }
}

// ===========================================================================
// Douglas-Peucker Stroke Simplification
// ===========================================================================

/**
 * Simplify a polyline using the Douglas-Peucker algorithm.
 * @param {{x: number, y: number}[]} points
 * @param {number} tolerance - Distance tolerance in normalized units
 * @returns {{x: number, y: number}[]}
 */
function simplifyStroke(points, tolerance) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyStroke(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyStroke(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }

  return [first, last];
}

/**
 * @param {{x: number, y: number}} point
 * @param {{x: number, y: number}} lineStart
 * @param {{x: number, y: number}} lineEnd
 * @returns {number}
 */
function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }

  const num = Math.abs(
    dy * point.x -
    dx * point.y +
    lineEnd.x * lineStart.y -
    lineEnd.y * lineStart.x,
  );
  return num / Math.sqrt(lenSq);
}
