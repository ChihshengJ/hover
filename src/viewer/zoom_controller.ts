import {
  anchoredScroll,
  captureAnchor,
  clampScale,
  fitOffset,
  pageBox,
} from "./zoom_anchor.js";

import type { PageView } from "./page.js";
import type { ZoomAnchor } from "./zoom_anchor.js";

/** A zoom waiting for the next frame; see `ZoomController.zoomAt()`. */
interface PendingZoom {
  scale: number;
  anchor: ZoomAnchor | null;
  focusX: number;
  focusY: number;
}

export interface ZoomHost {
  paneEl: HTMLElement;
  scroller: HTMLElement;
  stage: HTMLElement;
  pages: readonly PageView[];
  getScale(): number;
  /** Adopt `scale` and lay the pages out for it, synchronously. */
  relayout(scale: number): void;
  /** Render what the viewport now shows. */
  renderVisible(): void;
  /** Refresh whatever else depends on the scale, once it has changed. */
  onZoomed(): void;
}

/**
 * Zooming a pane while keeping the document point under the cursor or
 * fingers where it is on screen: batched zooms from buttons, keys and the
 * wheel, and pinches previewed as a transform and committed once at the end.
 * The anchoring itself is zoom_anchor.ts.
 */
export class ZoomController {
  #host: ZoomHost;
  #pending: PendingZoom | null = null;
  #raf: number | null = null;
  /**
   * A pinch in progress: the scale and anchor it started from, the stage
   * point under the fingers then, and the extent of the pages and the stage
   * at that scale — all in scroll-content px.
   */
  #pinch: {
    startScale: number;
    anchor: ZoomAnchor;
    originX: number;
    originY: number;
    contentLeft: number;
    contentWidth: number;
    stageHeight: number;
  } | null = null;

  constructor(host: ZoomHost) {
    this.#host = host;
  }

  get pinching(): boolean {
    return this.#pinch !== null;
  }

  /** The scale the pane is at, or is about to be once a pending zoom lands. */
  get targetScale(): number {
    return this.#pending?.scale ?? this.#host.getScale();
  }

  /**
   * Zoom to `scale`, keeping the document point at (focusX, focusY) — in
   * scroller viewport px — where it is on screen.
   *
   * The relayout waits for the next frame, so zooms requested within one
   * frame (key repeat, a run of button clicks) cost one relayout. The first
   * request's anchor holds for the batch; later ones only move the scale.
   */
  zoomAt(scale: number, focusX: number, focusY: number) {
    // A relayout under the pinch transform would pull the page out from
    // under the fingers; the pinch commits its own zoom when it ends.
    if (this.#pinch) return;

    scale = clampScale(scale);
    const pending = this.#pending;
    if (scale === this.targetScale) return;

    if (pending) {
      pending.scale = scale;
      return;
    }

    const { scroller } = this.#host;
    this.#schedule({
      scale,
      anchor: captureAnchor(
        this.#pageBoxes(),
        scroller.scrollLeft + focusX,
        scroller.scrollTop + focusY,
      ),
      focusX,
      focusY,
    });
  }

  #schedule(zoom: PendingZoom) {
    this.#pending = zoom;
    this.#raf = requestAnimationFrame(() => this.#commit());
  }

  #commit() {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    const zoom = this.#pending;
    if (!zoom) return;
    this.#pending = null;

    this.#host.relayout(zoom.scale);
    if (zoom.anchor) this.#scrollToAnchor(zoom.anchor, zoom.focusX, zoom.focusY);

    this.#host.renderVisible();
    this.#host.onZoomed();
  }

  /**
   * Start a pinch centred at (focusX, focusY), in scroller viewport px.
   *
   * Until `endPinch()`, the stage is only transformed: the document point
   * under the fingers at the start follows them as they spread and move,
   * and the pages are relaid and re-rendered once, at the end.
   */
  beginPinch(focusX: number, focusY: number) {
    if (this.#pinch) return;
    // A zoom still waiting for its frame would relayout under the transform.
    this.#commit();

    const { scroller, stage, paneEl, pages } = this.#host;
    const boxes = this.#pageBoxes();
    const originX = scroller.scrollLeft + focusX;
    const originY = scroller.scrollTop + focusY;
    // Null only with no pages, and then there is nothing to pinch.
    const anchor = captureAnchor(boxes, originX, originY);
    if (!anchor) return;
    const contentLeft = Math.min(...boxes.map((b) => b.left));
    const contentRight = Math.max(...boxes.map((b) => b.left + b.width));
    this.#pinch = {
      startScale: this.#host.getScale(),
      anchor,
      originX,
      originY,
      contentLeft,
      contentWidth: contentRight - contentLeft,
      stageHeight: stage.offsetHeight,
    };
    // The stage's box is at least the pane's width, so scaling it up
    // overflows sideways even while the pages still fit, which would flash
    // the horizontal scrollbar. If there's no horizontal scroll yet, the
    // commit decides whether there is one.
    if (scroller.scrollWidth <= scroller.clientWidth) {
      scroller.style.overflowX = "hidden";
    }

    // Hover interactions would chase anchors that are moving under the
    // cursor: block them for the pinch and drop any popup already pending.
    paneEl.classList.add("pinching");
    for (const page of pages) page.cancelCitationHover();
  }

  /** `ratio` is the scale since `beginPinch()`; the focus is where it is now. */
  updatePinch(ratio: number, focusX: number, focusY: number) {
    const pinch = this.#pinch;
    if (!pinch) return;

    const { scrollLeft, scrollTop, clientWidth, clientHeight } =
      this.#host.scroller;
    const r = clampScale(pinch.startScale * ratio) / pinch.startScale;

    // A stage point P shows at `t + r·P − scroll` in the viewport. Follow the
    // fingers: put the point under them at the start where they are now.
    // Scroll is read fresh, as a shrinking stage can make the scroller clamp it.
    const tx = scrollLeft + focusX - r * pinch.originX;
    const ty = scrollTop + focusY - r * pinch.originY;

    // Then hold the pages where the commit will put them: centred across
    // while narrower than the pane, and never past the document's edges.
    const left = fitOffset(
      tx + r * pinch.contentLeft - scrollLeft,
      r * pinch.contentWidth,
      clientWidth,
      true,
    );
    const top = fitOffset(
      ty - scrollTop,
      r * pinch.stageHeight,
      clientHeight,
      false,
    );
    const x = left - r * pinch.contentLeft + scrollLeft;
    const y = top + scrollTop;
    this.#host.stage.style.transform = `translate(${x}px, ${y}px) scale(${r})`;
  }

  endPinch(ratio: number, focusX: number, focusY: number) {
    const pinch = this.#pinch;
    if (!pinch) return;
    this.#pinch = null;

    this.#host.stage.style.transform = "";
    this.#host.scroller.style.overflowX = "";
    this.#host.paneEl.classList.remove("pinching");

    const scale = clampScale(pinch.startScale * ratio);
    if (scale !== this.#host.getScale()) {
      // Held by the anchor from the pinch's start, not one taken now: with the
      // transform gone, the point under the fingers is no longer that one.
      this.#schedule({ scale, anchor: pinch.anchor, focusX, focusY });
      return;
    }
    // No zoom to commit, but the fingers may have moved: keep the pan.
    this.#scrollToAnchor(pinch.anchor, focusX, focusY);
    // Pages the pinch brought into view were left for its end, and the
    // observer won't report those still in view again.
    this.#host.renderVisible();
  }

  destroy() {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.#pending = null;
  }

  #pageBoxes() {
    const { pages, stage } = this.#host;
    return pages.map((page) => pageBox(page.wrapper, stage));
  }

  /** Scroll so `anchor` sits at (focusX, focusY), in scroller viewport px. */
  #scrollToAnchor(anchor: ZoomAnchor, focusX: number, focusY: number) {
    const { pages, stage, scroller } = this.#host;
    const page = pages[anchor.index];
    if (!page) return;
    const { left, top } = anchoredScroll(
      pageBox(page.wrapper, stage),
      anchor,
      focusX,
      focusY,
    );
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
  }
}
