/**
 * DrawingSelectionManager - Handles selection, moving, resizing, rotating,
 * and deleting of completed drawing annotations.
 *
 * Shows a bounding box overlay with controls when a drawing is selected.
 *
 * @typedef {import('../../viewpane.js').ViewerPane} ViewerPane
 */

const COLOR_NAME_TO_HEX = {
  black: "#000000",
  yellow: "#FFB300",
  red: "#E53935",
  blue: "#1E88E5",
  green: "#43A047",
};

export class DrawingSelectionManager {
  /** @type {ViewerPane} */
  #pane;

  /** @type {string|null} */
  #selectedId = null;

  /** @type {Object|null} */
  #selectedAnnotation = null;

  /** @type {HTMLElement|null} */
  #bbox = null;

  /** @type {string} */
  #dragMode = "none"; // "none" | "move" | "resize" | "rotate"

  #dragStart = { x: 0, y: 0 };
  #origBounds = { x: 0, y: 0, w: 0, h: 0 };
  #origRotation = 0;

  /** @type {AbortController|null} */
  #abortController = null;

  // Bound handlers
  #onDragMove = (e) => this.#handleDragMove(e);
  #onDragEnd = (e) => this.#handleDragEnd(e);

  /**
   * @param {ViewerPane} pane
   */
  constructor(pane) {
    this.#pane = pane;
  }

  get selectedId() {
    return this.#selectedId;
  }

  /**
   * Select a drawing annotation and show the bounding box.
   * @param {string} annotationId
   * @param {Object} annotation
   */
  select(annotationId, annotation) {
    // Deselect previous
    if (this.#selectedId) {
      this.deselect();
    }

    this.#selectedId = annotationId;
    this.#selectedAnnotation = annotation;
    this.#showBoundingBox(annotation);

    // Listen for clicks outside to deselect
    this.#abortController = new AbortController();
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target.closest(".drawing-bounding-box")) return;
        if (e.target.closest(".annotation-mark.drawing")) return;
        this.deselect();
      },
      { signal: this.#abortController.signal },
    );
  }

  /**
   * Deselect and remove the bounding box.
   */
  deselect() {
    this.#removeBoundingBox();
    this.#selectedId = null;
    this.#selectedAnnotation = null;
    this.#abortController?.abort();
    this.#abortController = null;
  }

  // =========================================================================
  // Bounding Box
  // =========================================================================

  #showBoundingBox(annotation) {
    this.#removeBoundingBox();

    const pr = annotation.pageRanges[0];
    if (!pr || pr.rects.length === 0) return;

    const pageView = this.#pane.pages[pr.pageNumber - 1];
    if (!pageView) return;

    const layerWidth =
      parseFloat(pageView.textLayer.style.width) || pageView.wrapper.clientWidth;
    const layerHeight =
      parseFloat(pageView.textLayer.style.height) || pageView.wrapper.clientHeight;

    // Compute bounding rect from strokes
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (const stroke of annotation.strokes || []) {
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!isFinite(minX)) return;

    const padding = 8;
    const pxLeft = minX * layerWidth - padding;
    const pxTop = minY * layerHeight - padding;
    const pxWidth = (maxX - minX) * layerWidth + padding * 2;
    const pxHeight = (maxY - minY) * layerHeight + padding * 2;

    const hexColor = COLOR_NAME_TO_HEX[annotation.color] || "#000000";

    this.#bbox = document.createElement("div");
    this.#bbox.className = "drawing-bounding-box";
    this.#bbox.style.cssText = `
      left: ${pxLeft}px;
      top: ${pxTop}px;
      width: ${pxWidth}px;
      height: ${pxHeight}px;
      border-color: ${hexColor};
      color: ${hexColor};
    `;

    if (annotation.rotation) {
      this.#bbox.style.transform = `rotate(${annotation.rotation}deg)`;
      this.#bbox.style.transformOrigin = "center center";
    }

    // Control bar at top center
    const controls = document.createElement("div");
    controls.className = "drawing-bbox-controls";

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "drawing-bbox-btn drawing-bbox-delete";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#deleteSelected();
    });

    // Rotate handle
    const rotateBtn = document.createElement("button");
    rotateBtn.className = "drawing-bbox-btn drawing-bbox-rotate";
    rotateBtn.title = "Rotate";
    rotateBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
      <path d="M21.5 2v6h-6"/>
      <path d="M21.34 13.72A9 9 0 1 1 18.57 5.06L21.5 8"/>
    </svg>`;
    rotateBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.#startDrag(e, "rotate");
    });

    controls.appendChild(deleteBtn);
    controls.appendChild(rotateBtn);
    this.#bbox.appendChild(controls);

    // Resize handle at bottom-right
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "drawing-bbox-resize-handle";
    resizeHandle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.#startDrag(e, "resize");
    });
    this.#bbox.appendChild(resizeHandle);

    // Move: drag the bounding box itself
    this.#bbox.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".drawing-bbox-btn, .drawing-bbox-resize-handle")) return;
      e.stopPropagation();
      this.#startDrag(e, "move");
    });

    pageView.rotateInner.appendChild(this.#bbox);
  }

  #removeBoundingBox() {
    if (this.#bbox) {
      this.#bbox.remove();
      this.#bbox = null;
    }
  }

  // =========================================================================
  // Drag (Move / Resize / Rotate)
  // =========================================================================

  #startDrag(e, mode) {
    this.#dragMode = mode;
    this.#dragStart = { x: e.clientX, y: e.clientY };

    if (this.#bbox) {
      this.#origBounds = {
        x: parseFloat(this.#bbox.style.left),
        y: parseFloat(this.#bbox.style.top),
        w: parseFloat(this.#bbox.style.width),
        h: parseFloat(this.#bbox.style.height),
      };
    }
    this.#origRotation = this.#selectedAnnotation?.rotation || 0;

    document.addEventListener("pointermove", this.#onDragMove);
    document.addEventListener("pointerup", this.#onDragEnd);
  }

  /** @param {PointerEvent} e */
  #handleDragMove(e) {
    if (!this.#bbox || !this.#selectedAnnotation) return;

    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;

    if (this.#dragMode === "move") {
      this.#bbox.style.left = `${this.#origBounds.x + dx}px`;
      this.#bbox.style.top = `${this.#origBounds.y + dy}px`;
    } else if (this.#dragMode === "resize") {
      const newW = Math.max(20, this.#origBounds.w + dx);
      const newH = Math.max(20, this.#origBounds.h + dy);
      this.#bbox.style.width = `${newW}px`;
      this.#bbox.style.height = `${newH}px`;
    } else if (this.#dragMode === "rotate") {
      const cx = this.#origBounds.x + this.#origBounds.w / 2;
      const cy = this.#origBounds.y + this.#origBounds.h / 2;

      // Convert center to client coords
      const bboxParent = this.#bbox.parentElement;
      const parentRect = bboxParent.getBoundingClientRect();
      const clientCx = parentRect.left + cx;
      const clientCy = parentRect.top + cy;

      const startAngle = Math.atan2(
        this.#dragStart.y - clientCy,
        this.#dragStart.x - clientCx,
      );
      const currentAngle = Math.atan2(
        e.clientY - clientCy,
        e.clientX - clientCx,
      );
      const angleDelta = ((currentAngle - startAngle) * 180) / Math.PI;
      const newRotation = this.#origRotation + angleDelta;

      this.#bbox.style.transform = `rotate(${newRotation}deg)`;
      this.#bbox.style.transformOrigin = "center center";
    }
  }

  /** @param {PointerEvent} e */
  #handleDragEnd(e) {
    document.removeEventListener("pointermove", this.#onDragMove);
    document.removeEventListener("pointerup", this.#onDragEnd);

    if (!this.#selectedAnnotation || !this.#selectedId) {
      this.#dragMode = "none";
      return;
    }

    const annotation = this.#selectedAnnotation;
    const pr = annotation.pageRanges[0];
    if (!pr) {
      this.#dragMode = "none";
      return;
    }

    const pageView = this.#pane.pages[pr.pageNumber - 1];
    if (!pageView) {
      this.#dragMode = "none";
      return;
    }

    const layerWidth =
      parseFloat(pageView.textLayer.style.width) || pageView.wrapper.clientWidth;
    const layerHeight =
      parseFloat(pageView.textLayer.style.height) || pageView.wrapper.clientHeight;

    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;

    if (this.#dragMode === "move") {
      const dxNorm = dx / layerWidth;
      const dyNorm = dy / layerHeight;

      // Shift all stroke points
      const updatedStrokes = annotation.strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((p) => ({
          x: p.x + dxNorm,
          y: p.y + dyNorm,
        })),
      }));

      // Recompute bounding rect
      const bounds = computeBounds(updatedStrokes);
      const updatedPageRanges = [{
        ...pr,
        rects: [bounds],
      }];

      this.#pane.document.updateAnnotation(this.#selectedId, {
        strokes: updatedStrokes,
        pageRanges: updatedPageRanges,
      });
    } else if (this.#dragMode === "resize") {
      const newW = Math.max(20, this.#origBounds.w + dx);
      const newH = Math.max(20, this.#origBounds.h + dy);
      const scaleX = newW / this.#origBounds.w;
      const scaleY = newH / this.#origBounds.h;

      // Compute original bounds in normalized coords
      const origBounds = computeBoundsRaw(annotation.strokes);

      // Scale all stroke points relative to top-left of bounding box
      const updatedStrokes = annotation.strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((p) => ({
          x: origBounds.minX + (p.x - origBounds.minX) * scaleX,
          y: origBounds.minY + (p.y - origBounds.minY) * scaleY,
        })),
      }));

      const bounds = computeBounds(updatedStrokes);
      const updatedPageRanges = [{
        ...pr,
        rects: [bounds],
      }];

      this.#pane.document.updateAnnotation(this.#selectedId, {
        strokes: updatedStrokes,
        pageRanges: updatedPageRanges,
      });
    } else if (this.#dragMode === "rotate") {
      const cx = this.#origBounds.x + this.#origBounds.w / 2;
      const cy = this.#origBounds.y + this.#origBounds.h / 2;

      const bboxParent = this.#bbox.parentElement;
      const parentRect = bboxParent.getBoundingClientRect();
      const clientCx = parentRect.left + cx;
      const clientCy = parentRect.top + cy;

      const startAngle = Math.atan2(
        this.#dragStart.y - clientCy,
        this.#dragStart.x - clientCx,
      );
      const currentAngle = Math.atan2(
        e.clientY - clientCy,
        e.clientX - clientCx,
      );
      const angleDelta = ((currentAngle - startAngle) * 180) / Math.PI;
      const newRotation = this.#origRotation + angleDelta;

      this.#pane.document.updateAnnotation(this.#selectedId, {
        rotation: newRotation,
      });
    }

    this.#dragMode = "none";

    // Refresh selection after annotation update
    const refreshed = this.#pane.document.getAnnotation(this.#selectedId);
    if (refreshed) {
      // Re-select to update bounding box position
      const id = this.#selectedId;
      this.deselect();
      requestAnimationFrame(() => {
        this.select(id, refreshed);
      });
    }
  }

  // =========================================================================
  // Actions
  // =========================================================================

  #deleteSelected() {
    if (!this.#selectedId) return;
    const id = this.#selectedId;
    this.deselect();
    this.#pane.document.deleteAnnotation(id);
  }

  destroy() {
    this.deselect();
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function computeBoundsRaw(strokes) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const stroke of strokes || []) {
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

function computeBounds(strokes) {
  const { minX, minY, maxX, maxY } = computeBoundsRaw(strokes);
  return {
    leftRatio: minX,
    topRatio: minY,
    widthRatio: maxX - minX,
    heightRatio: maxY - minY,
  };
}
