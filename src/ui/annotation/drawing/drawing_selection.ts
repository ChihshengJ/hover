/**
 * DrawingSelectionManager - Handles selection, moving, resizing, rotating,
 * and deleting of completed drawing annotations.
 *
 * Shows a bounding box overlay with controls when a drawing is selected.
 *
 * The overlay lives on the pane stage rather than inside a page, in the same
 * pixel space as the rendered SVG strokes. Anchoring it to a page clipped the
 * controls away (`.page-wrapper` has `content-visibility: auto`, which paints
 * with containment) as soon as a drawing was dragged past that page's edge, so
 * a drawing moved onto a neighbouring page could be selected but never edited
 * again. Every edit re-homes the annotation to whichever page it now covers.
 *
 * @typedef {ViewerPane} ViewerPane
 */

import { onPointerDrag } from "../../../viewer/pointer_gesture.js";
import {
  COLOR_NAME_TO_HEX,
  computeBounds,
  computeBoundsRaw,
  findPageAtStagePoint,
  getPageMetrics,
  pageToStage,
  stageToPage,
} from "./drawing_geometry.js";

import type { AnnotationHost } from "../host.js";
import type {
  Annotation,
  DrawingStroke,
} from "../../../model/annotation_data.js";

/** Which handle the live drag was started from. */
type DragMode = "none" | "move" | "resize" | "rotate";
/** Gap between the strokes and the dashed border, in stage pixels. */
const BBOX_PADDING = 8;

/** Smallest content box a resize can produce, in stage pixels. */
const MIN_SIZE = 20;

export class DrawingSelectionManager {
  #host: AnnotationHost;

  #selectedId: string | null = null;

  #selectedAnnotation: Annotation | null = null;

  #bbox: HTMLElement | null = null;

  #dragMode: DragMode = "none";

  #dragStart = { x: 0, y: 0 };

  /** Content box (padding excluded) at drag start, in stage pixels. */
  #origBounds = { x: 0, y: 0, w: 0, h: 0 };
  #origRotation = 0;

  #abortController: AbortController | null = null;

  // Bound handlers
  #onDragMove = (e: PointerEvent) => this.#handleDragMove(e);
  #onDragEnd = (e: PointerEvent) => this.#handleDragEnd(e);

  constructor(host: AnnotationHost) {
    this.#host = host;
  }

  get selectedId() {
    return this.#selectedId;
  }

  /**
   * Select a drawing annotation and show the bounding box.
   */
  select(annotationId: string, annotation: Annotation) {
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
        if ((e.target as Element).closest(".drawing-bounding-box")) return;
        if ((e.target as Element).closest(".annotation-mark.drawing")) return;
        this.deselect();
      },
      { signal: this.#abortController.signal },
    );
  }

  /**
   * Re-measure the bounding box against the current page layout. Called after
   * zoom or resize, which move the pages under a stage-positioned overlay.
   */
  refresh() {
    if (!this.#selectedId || this.#dragMode !== "none") return;

    const annotation = this.#host.doc.getAnnotation(this.#selectedId);
    if (!annotation) {
      this.deselect();
      return;
    }

    this.#selectedAnnotation = annotation;
    this.#showBoundingBox(annotation);
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

  /**
   * Content box of a drawing's strokes in stage pixels, or null if the
   * annotation has no usable geometry.
   */
  #stageBoundsOf(annotation: Record<string, any>) {
    const pr = annotation.pageRanges?.[0];
    if (!pr) return null;

    const pageView = this.#host.getPages()[pr.pageNumber - 1];
    if (!pageView) return null;

    const bounds = computeBoundsRaw(annotation.strokes);
    if (!isFinite(bounds.minX)) return null;

    const metrics = getPageMetrics(pageView);
    const topLeft = pageToStage({ x: bounds.minX, y: bounds.minY }, metrics);
    const bottomRight = pageToStage(
      { x: bounds.maxX, y: bounds.maxY },
      metrics,
    );

    return {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
  }

  #showBoundingBox(annotation: Annotation) {
    this.#removeBoundingBox();

    const bounds = this.#stageBoundsOf(annotation);
    if (!bounds) return;

    const hexColor = COLOR_NAME_TO_HEX[annotation.color] || "#000000";

    this.#bbox = document.createElement("div");
    this.#bbox.className = "drawing-bounding-box";
    this.#bbox.style.cssText = `
      left: ${bounds.x - BBOX_PADDING}px;
      top: ${bounds.y - BBOX_PADDING}px;
      width: ${bounds.w + BBOX_PADDING * 2}px;
      height: ${bounds.h + BBOX_PADDING * 2}px;
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
      if (
        (e.target as Element).closest(
          ".drawing-bbox-btn, .drawing-bbox-resize-handle",
        )
      )
        return;
      e.stopPropagation();
      this.#startDrag(e, "move");
    });

    this.#host.getStage().appendChild(this.#bbox);
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

  #startDrag(e: PointerEvent, mode: DragMode) {
    const bounds =
      this.#selectedAnnotation && this.#stageBoundsOf(this.#selectedAnnotation);
    if (!bounds) return;

    this.#dragMode = mode;
    this.#dragStart = { x: e.clientX, y: e.clientY };
    this.#origBounds = bounds;
    this.#origRotation = this.#selectedAnnotation?.rotation || 0;

    onPointerDrag(e, {
      onMove: this.#onDragMove,
      onEnd: this.#onDragEnd,
    });
  }

  /**
   * Rotation implied by the pointer's position relative to the bounding box
   * centre, measured from where the drag started.
   */
  #rotationFor(e: PointerEvent) {
    const cx = this.#origBounds.x + this.#origBounds.w / 2;
    const cy = this.#origBounds.y + this.#origBounds.h / 2;

    // Stage pixels -> client coords
    const stageRect = this.#host.getStage().getBoundingClientRect();
    const clientCx = stageRect.left + cx;
    const clientCy = stageRect.top + cy;

    const startAngle = Math.atan2(
      this.#dragStart.y - clientCy,
      this.#dragStart.x - clientCx,
    );
    const currentAngle = Math.atan2(e.clientY - clientCy, e.clientX - clientCx);
    const angleDelta = ((currentAngle - startAngle) * 180) / Math.PI;

    return this.#origRotation + angleDelta;
  }

  /**
   * Content-box size a resize drag implies, clamped to a usable minimum.
   * An axis-aligned line has zero extent on one axis; there is no scale factor
   * that stretches it, so that axis is left alone rather than dividing by zero.
   */
  #resizeFor(dx: number, dy: number) {
    const { w, h } = this.#origBounds;
    return {
      w: w > 0 ? Math.max(MIN_SIZE, w + dx) : w,
      h: h > 0 ? Math.max(MIN_SIZE, h + dy) : h,
    };
  }

  #handleDragMove(e: PointerEvent) {
    if (!this.#bbox || !this.#selectedAnnotation) return;

    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;

    if (this.#dragMode === "move") {
      this.#bbox.style.left = `${this.#origBounds.x + dx - BBOX_PADDING}px`;
      this.#bbox.style.top = `${this.#origBounds.y + dy - BBOX_PADDING}px`;
    } else if (this.#dragMode === "resize") {
      const { w, h } = this.#resizeFor(dx, dy);
      this.#bbox.style.width = `${w + BBOX_PADDING * 2}px`;
      this.#bbox.style.height = `${h + BBOX_PADDING * 2}px`;
    } else if (this.#dragMode === "rotate") {
      this.#bbox.style.transform = `rotate(${this.#rotationFor(e)}deg)`;
      this.#bbox.style.transformOrigin = "center center";
    }
  }

  #handleDragEnd(e: PointerEvent) {
    const mode = this.#dragMode;
    this.#dragMode = "none";

    if (!this.#selectedAnnotation || !this.#selectedId) return;

    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;

    if (mode === "move") {
      this.#commitTransform({ dx, dy, scaleX: 1, scaleY: 1 });
    } else if (mode === "resize") {
      const { w, h } = this.#resizeFor(dx, dy);
      this.#commitTransform({
        dx: 0,
        dy: 0,
        scaleX: this.#origBounds.w > 0 ? w / this.#origBounds.w : 1,
        scaleY: this.#origBounds.h > 0 ? h / this.#origBounds.h : 1,
      });
    } else if (mode === "rotate") {
      this.#commit({ rotation: this.#rotationFor(e) });
    }
  }

  /**
   * Apply a translate/scale (in stage pixels, anchored at the drawing's
   * top-left) to every stroke point, then store the result against whichever
   * page the drawing now sits on.
   */
  #commitTransform({
    dx,
    dy,
    scaleX,
    scaleY,
  }: {
    dx: number;
    dy: number;
    scaleX: number;
    scaleY: number;
  }) {
    const annotation = this.#selectedAnnotation;
    const pr = annotation.pageRanges[0];
    const sourcePage = this.#host.getPages()[pr.pageNumber - 1];
    if (!sourcePage) return;

    const source = getPageMetrics(sourcePage);
    const origin = { x: this.#origBounds.x, y: this.#origBounds.y };

    // Strokes in stage pixels, with the drag applied.
    const stageStrokes = annotation.strokes!.map((stroke: DrawingStroke) => ({
      ...stroke,
      points: stroke.points.map((p) => {
        const stagePoint = pageToStage(p, source);
        return {
          x: origin.x + dx + (stagePoint.x - origin.x) * scaleX,
          y: origin.y + dy + (stagePoint.y - origin.y) * scaleY,
        };
      }),
    }));

    // Re-home to the page the drawing now covers — the drag may have carried it
    // onto a neighbour.
    const moved = computeBoundsRaw(stageStrokes);
    const targetPage =
      findPageAtStagePoint(
        this.#host.getPages(),
        (moved.minX + moved.maxX) / 2,
        (moved.minY + moved.maxY) / 2,
      ) || sourcePage;
    const target = getPageMetrics(targetPage);

    // Stroke widths are ratios of page width; rescale so a drawing that lands
    // on a differently sized page keeps its on-screen thickness.
    const widthRatio = source.width / target.width;

    const updatedStrokes = stageStrokes.map((stroke: DrawingStroke) => ({
      ...stroke,
      strokeWidth: (stroke.strokeWidth || 0.003) * widthRatio,
      points: stroke.points.map((p) => stageToPage(p, target)),
    }));

    this.#commit({
      strokes: updatedStrokes,
      pageRanges: [
        {
          ...pr,
          pageNumber: targetPage.pageNumber,
          rects: [computeBounds(updatedStrokes)],
        },
      ],
    });
  }

  /**
   * Persist an update and rebuild the bounding box around the stored result.
   */
  #commit(changes: Record<string, any>) {
    const id = this.#selectedId;
    this.#host.doc.updateAnnotation(id, changes);

    const refreshed = this.#host.doc.getAnnotation(id);
    if (!refreshed) return;

    this.deselect();
    requestAnimationFrame(() => {
      this.select(id, refreshed);
    });
  }

  // =========================================================================
  // Actions
  // =========================================================================

  #deleteSelected() {
    if (!this.#selectedId) return;
    const id = this.#selectedId;
    this.deselect();
    this.#host.doc.deleteAnnotation(id);
  }

  destroy() {
    this.deselect();
  }
}
