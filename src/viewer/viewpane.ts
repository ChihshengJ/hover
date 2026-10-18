import { PageView } from "./page.js";
import { PaneControls } from "../ui/controls/pane_controls.js";
import { ScrollBackButton } from "../ui/controls/scroll_back_button.js";
import { TextSelectionManager } from "./text_manager.js";
import { NearestSpanSelection } from "./nearest_span_selection.js";
import { HandPan } from "./hand_pan.js";
import { SpreadLayout } from "./spread_layout.js";
import { watchDevicePixelRatio } from "./device_pixel_ratio.js";
import { AnnotationManager } from "../ui/annotation/annotation_manager.js";
import { DocEvent, ANNOTATION_EVENTS } from "../model/doc_events.js";
import {
  anchoredScroll,
  captureAnchor,
  clampScale,
  fitOffset,
} from "./zoom_anchor.js";
import {
  cappedSize,
  covers,
  deviceRegion,
  unrotate,
} from "./detail_region.js";

import type { PDFDocumentModel } from "../model/doc.js";
import type { DocEventName } from "../model/doc_events.js";
import type { PageBox, ZoomAnchor } from "./zoom_anchor.js";
import type { Edges } from "./detail_region.js";
import type { SpreadMode } from "./spread_layout.js";
import type {
  AnnotationHost,
  PaneAnnotationCallbacks,
} from "../ui/annotation/host.js";

/** Gap above and below each page, in PDF points; 14px at the default 1.7. */
const PAGE_GAP = 8;
/**
 * How far above and below the viewport pages are kept rendered, in viewport
 * heights. A page renders this far ahead of reaching the screen; at 5K a
 * render can take 100 ms, so a fixed few hundred px let a quick scroll
 * arrive first.
 */
const RENDER_MARGIN = 1;
/**
 * How far past the viewport a detail region reaches once scrolling settles,
 * as a fraction of the viewport on each side, so a short scroll stays sharp.
 */
const DETAIL_MARGIN = 0.125;
/** How long scrolling must pause before detail regions follow it, in ms. */
const DETAIL_SETTLE_MS = 100;
/**
 * Below the size cap, an on-screen page renders the region in view first only
 * when that is under this fraction of the page. Its whole page follows at full
 * resolution anyway, so a crop of most of the page saves the frame little and
 * costs a second render of the same pixels.
 */
const CROP_FIRST_BELOW = 0.75;

export interface ViewerPaneOptions {
  id?: string;
  pinned?: boolean;
}

export type { SpreadMode };

export class ViewerPane {
  document: PDFDocumentModel;
  paneEl: HTMLElement;
  scroller!: HTMLDivElement;
  stage!: HTMLDivElement;
  id: string;
  canvases: HTMLCanvasElement[] = [];

  scale = 1;
  /** 1 for width, 2 for height. */
  fitMode = 1;
  pages: PageView[] = [];
  pageMap = new Map<Element, PageView>();
  visiblePages = new Set<PageView>();
  observer: IntersectionObserver | null = null;
  /**
   * Dedicated observer reporting which page(s) cross the viewport's vertical
   * centre, for `getCurrentPage()`.
   */
  centerObserver: IntersectionObserver | null = null;
  /** Pages currently over the center line. */
  centeredPages = new Set<PageView>();
  controls: PaneControls;
  currentPage = 0;

  spreadMode: SpreadMode = 0;
  spreadLayout = new SpreadLayout();

  handMode = false;
  handPan = new HandPan(() => this.scroller);

  /** CSS-based, per-pane: 0, 90, 180 or 270. */
  rotation = 0;

  textSelectionManager = new TextSelectionManager();
  nearestSpanSelection: NearestSpanSelection | null = null;
  annotationManager: AnnotationManager | null = null;

  scrollBack: ScrollBackButton;

  /**
   * The annotation entry points, republished here for the callers that only
   * have a pane — the drawing controller and the navigation tree.
   */
  onAnnotationHover: PaneAnnotationCallbacks["onAnnotationHover"] | null = null;
  onAnnotationClick: PaneAnnotationCallbacks["onAnnotationClick"] | null = null;
  editAnnotationComment:
    | PaneAnnotationCallbacks["editAnnotationComment"]
    | null = null;
  deleteAnnotationComment:
    | PaneAnnotationCallbacks["deleteAnnotationComment"]
    | null = null;
  selectAnnotation: PaneAnnotationCallbacks["selectAnnotation"] | null = null;

  /** A zoom waiting for the next frame; see `zoomAt()`. */
  _pendingZoom: {
    scale: number;
    anchor: ZoomAnchor | null;
    focusX: number;
    focusY: number;
  } | null = null;
  _zoomRAF: number | null = null;
  /**
   * A pinch in progress: the scale and anchor it started from, the stage
   * point under the fingers then, and the extent of the pages and the stage
   * at that scale — all in scroll-content px.
   */
  _pinch: {
    startScale: number;
    anchor: ZoomAnchor;
    originX: number;
    originY: number;
    contentLeft: number;
    contentWidth: number;
    stageHeight: number;
  } | null = null;

  constructor(
    documentModel: PDFDocumentModel,
    paneEl: HTMLElement,
    options: ViewerPaneOptions = {},
  ) {
    this.document = documentModel;
    this.paneEl = paneEl;
    this.id = options.id || crypto.randomUUID();

    this.controls = new PaneControls({
      paneEl: this.paneEl,
      getScroller: () => this.scroller,
      getPageCount: () => this.document.numPages,
      getCurrentPage: () => this.getCurrentPage(),
      getScale: () => this.scale,
      getHandMode: () => this.handMode,
      zoom: (delta) => this.zoom(delta),
      fit: (mode, target) => this.fit(mode, target),
      setHandMode: (on) => this.setHandMode(on),
      scrollToRelative: (delta) => this.scrollToRelative(delta),
    });
    this.scrollBack = new ScrollBackButton({
      paneEl: this.paneEl,
      getScroller: () => this.scroller,
    });

    this.document.subscribe(this);
  }

  async initialize(scale = 1.7) {
    this.scale = scale;
    this.#createScroller();
    this.#createStage();
    this.canvases = await this.#createCanvasPlaceholders();
    this.pages = this.canvases.map((canvas, idx) => {
      const pageView = new PageView(
        {
          doc: this.document,
          // Assigned in this constructor but read on click, long after; and
          // null until `initialize()` runs for the annotation layer.
          getTextSelectionManager: () => this.textSelectionManager,
          scrollToPoint: (pageIndex, top, center) =>
            this.scrollToPoint(pageIndex, top, center),
        },
        idx + 1,
        canvas,
      );
      this.pageMap.set(pageView.wrapper, pageView);
      return pageView;
    });
    this.layoutPages(this.scale);
    // Browser zoom changes the ratio *and* fires `resize`, whose handler
    // already re-lays out every pane. So refresh only if nothing has laid out
    // at the new ratio by the watcher's frame — otherwise each zoom step
    // would render every visible page twice.
    this.#unwatchDpr = watchDevicePixelRatio(() => {
      if ((window.devicePixelRatio || 1) !== this.#layoutDpr) {
        this.refreshAllPages();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setupLazyRender();
    this.nearestSpanSelection = new NearestSpanSelection({
      scroller: this.scroller,
      getVisiblePages: () => this.visiblePages,
      getHandMode: () => this.handMode,
    });
    this.controls.bindScrollEvents();
    this.annotationManager = new AnnotationManager(this.#annotationHost());
  }

  /**
   * The slice of this pane the annotation layer works against. Built here so
   * the shape of that dependency is written down in one place.
   */
  #annotationHost(): AnnotationHost {
    return {
      doc: this.document,
      getStage: () => this.stage,
      getScroller: () => this.scroller,
      getPages: () => this.pages,
      getHandMode: () => this.handMode,
      getSelection: () => this.textSelectionManager.getSelection(),
      publishCallbacks: (callbacks) => {
        this.onAnnotationHover = callbacks.onAnnotationHover;
        this.onAnnotationClick = callbacks.onAnnotationClick;
        this.editAnnotationComment = callbacks.editAnnotationComment;
        this.deleteAnnotationComment = callbacks.deleteAnnotationComment;
        this.selectAnnotation = callbacks.selectAnnotation;
      },
    };
  }

  #createScroller() {
    this.scroller = document.createElement("div");
    this.scroller.className = "pane-scroll-area";
    this.scroller.addEventListener("scroll", this.#scheduleDetailRefresh, {
      passive: true,
    });
    this.paneEl.appendChild(this.scroller);
  }

  #createStage() {
    this.stage = document.createElement("div");
    this.stage.className = "viewer-stage";
    this.stage.id = `stage-${this.id}`;
    this.scroller.appendChild(this.stage);
  }

  async #createCanvasPlaceholders(): Promise<HTMLCanvasElement[]> {
    const canvases: HTMLCanvasElement[] = [];
    const numPages = this.document.numPages;

    for (let i = 1; i <= numPages; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper";
      wrapper.style.display = "block";
      wrapper.style.width = "fit-content";

      const label = document.createElement("div");
      label.className = "page-num";
      label.textContent = `| Page ${i}`;

      const canvas = document.createElement("canvas");
      canvas.dataset.pageNumber = String(i);
      // A fresh canvas defaults to a 300x150 buffer. Nothing renders into it
      // until PageView sizes it, so drop it and let `width` mean what it says
      // everywhere else: this page currently holds pixels.
      canvas.width = 0;
      canvas.height = 0;

      wrapper.appendChild(canvas);
      wrapper.appendChild(label);
      this.stage.appendChild(wrapper);

      canvases.push(canvas);
    }
    return canvases;
  }

  //*******************
  // Render management
  // ******************
  setupLazyRender() {
    if (this.observer) {
      this.observer.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageView = this.pageMap.get(entry.target);
          if (!pageView) continue;

          // In range, the page is painted ahead like the rest of the screen,
          // not left for `content-visibility` to paint as it arrives; see
          // viewer.css.
          pageView.wrapper.classList.toggle("in-range", entry.isIntersecting);
          if (entry.isIntersecting) {
            this.visiblePages.add(pageView);
          } else {
            this.visiblePages.delete(pageView);
            pageView.dropDetail();
            this.#maybeRelease(pageView);
          }
        }
        this.#renderVisiblePages();
      },
      {
        root: this.scroller,
        rootMargin: `${RENDER_MARGIN * 100}% 0px`,
        threshold: 0.1,
      },
    );
    this.observer = observer;

    for (const pageView of this.pages) {
      this.observer.observe(pageView.wrapper);
    }

    this.#setupCurrentPageTracking();
  }

  /**
   * Tracks the current page under the viewport's vertical center.
   * The negative top/bottom rootMargin collapses the observer root to a thin
   * band at the scroller's mid-height, so a page is "intersecting" exactly
   * while it crosses that center line.
   */
  #setupCurrentPageTracking() {
    if (this.centerObserver) {
      this.centerObserver.disconnect();
    }
    this.centeredPages.clear();

    this.centerObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageView = this.pageMap.get(entry.target);
          if (!pageView) continue;
          if (entry.isIntersecting) {
            this.centeredPages.add(pageView);
          } else {
            this.centeredPages.delete(pageView);
          }
        }
        // In gaps between pages the set is briefly empty — keep the last value.
        // In spread mode two pages share the center line; pick the lower number
        // to match the old left-to-right scan order.
        let min = Infinity;
        for (const pv of this.centeredPages) {
          if (pv.pageNumber < min) min = pv.pageNumber;
        }
        // Notify on change so page indicators refresh even when the page
        // changed via an instant jump (where the scroll handler already ran
        // before this async callback updated currentPage).
        if (min !== Infinity && min !== this.currentPage) {
          this.currentPage = min;
          this.controls.notifyPageChange();
        }
      },
      {
        root: this.scroller,
        rootMargin: "-50% 0px -50% 0px",
        threshold: 0,
      },
    );

    for (const pageView of this.pages) {
      this.centerObserver.observe(pageView.wrapper);
    }
  }

  #maybeRelease(page: PageView) {
    const rect = page.wrapper.getBoundingClientRect();
    const threshold = window.innerHeight * 2;

    if (rect.bottom < -threshold || rect.top > window.innerHeight + threshold) {
      page.release();
    }
  }

  /**
   * Render the visible pages that need it. PDFium renders synchronously on
   * this thread, so a batch holds the frame until every page in it is done.
   * Only the pages on screen render now, for the frame being built; those
   * only in the observer's margin are queued, nearest the viewport first, and
   * render one per task so frames can paint in between.
   *
   * An on-screen page renders only the region in view now, at full
   * resolution, when it is past the size cap or mostly out of view; its whole
   * page — capped or not — joins the front of the queue. The work in the
   * frame then follows the viewport rather than the pages it cuts across.
   *
   * Nothing renders mid-pinch: the scale is about to change, and the pinch
   * calls this again when it ends.
   */
  #renderVisiblePages() {
    if (this._pinch) return;

    const view = this.scroller.getBoundingClientRect();
    // Measure everything before rendering any of it, as a render touches the
    // DOM and the next read would force another layout.
    const pending: { page: PageView; rect: DOMRect }[] = [];
    for (const page of this.visiblePages) {
      if (page.canvas.dataset.rendered === "false") {
        pending.push({ page, rect: page.wrapper.getBoundingClientRect() });
      }
    }

    const queued: { page: PageView; gap: number }[] = [];
    for (const { page, rect } of pending) {
      const gapX = Math.max(view.left - rect.right, rect.left - view.right);
      const gapY = Math.max(view.top - rect.bottom, rect.top - view.bottom);
      if (gapX >= 0 || gapY >= 0) {
        queued.push({ page, gap: Math.max(gapX, 0) + Math.max(gapY, 0) });
        continue;
      }
      const region = this.#detailRegion(page, rect, view, 0);
      const cropFirst =
        region &&
        (page.capped ||
          (region.right - region.left) * (region.bottom - region.top) <
            CROP_FIRST_BELOW * page.fullWidth * page.fullHeight);
      if (cropFirst) {
        page.renderDetail(region, this.scale);
        queued.push({ page, gap: -1 });
      } else {
        page.render(this.scale);
      }
    }

    this.#renderQueue = queued
      .sort((a, b) => a.gap - b.gap)
      .map(({ page }) => page);
    if (this.#renderQueue.length > 0 && this.#renderTimer === null) {
      this.#renderTimer = setTimeout(() => this.#renderNextQueued(), 0);
    }
  }

  /** Margin pages waiting to render; see `#renderVisiblePages()`. */
  #renderQueue: PageView[] = [];
  #renderTimer: ReturnType<typeof setTimeout> | null = null;

  #renderNextQueued() {
    this.#renderTimer = null;
    // The pinch's end rebuilds the queue for the scale it commits.
    if (this._pinch) return;

    // A page may have been rendered by a rebuild, or moved out of range,
    // since it was queued — after a zoom with no pinch, the visible set is
    // the one from before it until the observer next reports.
    const view = this.scroller.getBoundingClientRect();
    let page: PageView | undefined;
    while ((page = this.#renderQueue.shift())) {
      if (
        !this.visiblePages.has(page) ||
        page.canvas.dataset.rendered !== "false"
      ) {
        continue;
      }
      const rect = page.wrapper.getBoundingClientRect();
      if (
        rect.bottom < view.top - view.height * RENDER_MARGIN ||
        rect.top > view.bottom + view.height * RENDER_MARGIN
      ) {
        continue;
      }
      page.render(this.scale);
      break;
    }
    if (this.#renderQueue.length > 0) {
      this.#renderTimer = setTimeout(() => this.#renderNextQueued(), 0);
    }
  }

  /**
   * The region of `page` to render in detail, in its full-resolution device
   * px: the part inside the viewport, grown by `margin` of the viewport on
   * each side. Null when none of the page is in range. `rect` and `view` are
   * the page wrapper's and the scroller's client rects.
   */
  #detailRegion(
    page: PageView,
    rect: DOMRect,
    view: DOMRect,
    margin: number,
  ): Edges | null {
    const mx = view.width * margin;
    const my = view.height * margin;
    const local = {
      left: Math.max(view.left - mx, rect.left) - rect.left,
      top: Math.max(view.top - my, rect.top) - rect.top,
      right: Math.min(view.right + mx, rect.right) - rect.left,
      bottom: Math.min(view.bottom + my, rect.bottom) - rect.top,
    };
    const swapped = this.rotation === 90 || this.rotation === 270;
    const inner = unrotate(
      local,
      this.rotation,
      swapped ? rect.height : rect.width,
      swapped ? rect.width : rect.height,
    );
    return deviceRegion(inner, this.#layoutDpr, {
      width: page.fullWidth,
      height: page.fullHeight,
    });
  }

  #detailTimer: ReturnType<typeof setTimeout> | null = null;
  #scheduleDetailRefresh = () => {
    if (this.#detailTimer !== null) clearTimeout(this.#detailTimer);
    this.#detailTimer = setTimeout(
      () => this.#refreshDetails(),
      DETAIL_SETTLE_MS,
    );
  };

  /**
   * Once scrolling settles, move each on-screen page's detail region to
   * where the page now is, if it no longer covers the part in view. Until
   * then the uncovered part shows the capped base, a little soft.
   */
  #refreshDetails() {
    this.#detailTimer = null;
    if (this._pinch) return;

    const view = this.scroller.getBoundingClientRect();
    const updates: { page: PageView; region: Edges }[] = [];
    for (const page of this.visiblePages) {
      if (!page.capped) continue;
      const rect = page.wrapper.getBoundingClientRect();
      const inView = this.#detailRegion(page, rect, view, 0);
      if (!inView) {
        page.dropDetail();
        continue;
      }
      if (page.detailRegion && covers(page.detailRegion, inView)) continue;
      updates.push({
        page,
        region: this.#detailRegion(page, rect, view, DETAIL_MARGIN)!,
      });
    }
    for (const { page, region } of updates) {
      page.renderDetail(region, this.scale);
    }
  }

  //*******************
  // Viewer controls
  // ******************

  getCurrentPage() {
    return this.currentPage || this.#computeCurrentPage();
  }

  /**
   * Precise synchronous measurement of the centered page. Use after a
   * programmatic instant scroll, where the async observer hasn't fired yet.
   * Updates this.currentPage as a side effect.
   */
  #computeCurrentPage() {
    const viewRect = this.scroller.getBoundingClientRect();
    const viewportMidY = viewRect.top + viewRect.height / 2;
    for (const canvas of this.canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.top <= viewportMidY && rect.bottom >= viewportMidY) {
        this.currentPage = parseInt(canvas.dataset.pageNumber!);
        return this.currentPage;
      }
    }
    return this.currentPage;
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
    if (this._pinch) return;

    scale = clampScale(scale);
    const pending = this._pendingZoom;
    if (scale === (pending?.scale ?? this.scale)) return;

    if (pending) {
      pending.scale = scale;
      return;
    }

    this._pendingZoom = {
      scale,
      anchor: captureAnchor(
        this.pages.map((page) => this.#pageBox(page)),
        this.scroller.scrollLeft + focusX,
        this.scroller.scrollTop + focusY,
      ),
      focusX,
      focusY,
    };
    this._zoomRAF = requestAnimationFrame(() => this.#commitZoom());
  }

  #commitZoom() {
    if (this._zoomRAF !== null) cancelAnimationFrame(this._zoomRAF);
    this._zoomRAF = null;
    const zoom = this._pendingZoom;
    if (!zoom) return;
    this._pendingZoom = null;

    this.scale = zoom.scale;
    this.layoutPages(zoom.scale);
    if (zoom.anchor) this.#scrollToAnchor(zoom.anchor, zoom.focusX, zoom.focusY);

    this.#renderVisiblePages();
    this.annotationManager?.refresh();
    this.controls.updateZoomDisplay();
  }

  /**
   * Start a pinch centred at (focusX, focusY), in scroller viewport px.
   *
   * Until `endPinch()`, the stage is only transformed: the document point
   * under the fingers at the start follows them as they spread and move,
   * and the pages are relaid and re-rendered once, at the end.
   */
  beginPinch(focusX: number, focusY: number) {
    if (this._pinch) return;
    // A zoom still waiting for its frame would relayout under the transform.
    this.#commitZoom();

    const scroller = this.scroller;
    const boxes = this.pages.map((page) => this.#pageBox(page));
    const originX = scroller.scrollLeft + focusX;
    const originY = scroller.scrollTop + focusY;
    // Null only with no pages, and then there is nothing to pinch.
    const anchor = captureAnchor(boxes, originX, originY);
    if (!anchor) return;
    const contentLeft = Math.min(...boxes.map((b) => b.left));
    const contentRight = Math.max(...boxes.map((b) => b.left + b.width));
    this._pinch = {
      startScale: this.scale,
      anchor,
      originX,
      originY,
      contentLeft,
      contentWidth: contentRight - contentLeft,
      stageHeight: this.stage.offsetHeight,
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
    this.paneEl.classList.add("pinching");
    for (const page of this.pages) page.cancelCitationHover();
  }

  /** `ratio` is the scale since `beginPinch()`; the focus is where it is now. */
  updatePinch(ratio: number, focusX: number, focusY: number) {
    const pinch = this._pinch;
    if (!pinch) return;

    const { scrollLeft, scrollTop, clientWidth, clientHeight } = this.scroller;
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
    this.stage.style.transform = `translate(${x}px, ${y}px) scale(${r})`;
  }

  endPinch(ratio: number, focusX: number, focusY: number) {
    const pinch = this._pinch;
    if (!pinch) return;
    this._pinch = null;

    this.stage.style.transform = "";
    this.scroller.style.overflowX = "";
    this.paneEl.classList.remove("pinching");

    const scale = clampScale(pinch.startScale * ratio);
    if (scale !== this.scale) {
      // Held by the anchor from the pinch's start, not one taken now: with the
      // transform gone, the point under the fingers is no longer that one.
      this._pendingZoom = { scale, anchor: pinch.anchor, focusX, focusY };
      this._zoomRAF = requestAnimationFrame(() => this.#commitZoom());
      return;
    }
    // No zoom to commit, but the fingers may have moved: keep the pan.
    this.#scrollToAnchor(pinch.anchor, focusX, focusY);
    // Pages the pinch brought into view were left for its end, and the
    // observer won't report those still in view again.
    this.#renderVisiblePages();
  }

  /** Scroll so `anchor` sits at (focusX, focusY), in scroller viewport px. */
  #scrollToAnchor(anchor: ZoomAnchor, focusX: number, focusY: number) {
    const page = this.pages[anchor.index];
    if (!page) return;
    const { left, top } = anchoredScroll(
      this.#pageBox(page),
      anchor,
      focusX,
      focusY,
    );
    this.scroller.scrollLeft = left;
    this.scroller.scrollTop = top;
  }

  /**
   * A page's box in scroll-content px. Built from offsets, which are layout
   * positions, so a transform on the stage doesn't move it. The stage is the
   * scroller's only in-flow child and sits at the content origin.
   */
  #pageBox(page: PageView): PageBox {
    let left = 0;
    let top = 0;
    for (
      let el: HTMLElement | null = page.wrapper;
      el && el !== this.stage;
      el = el.offsetParent as HTMLElement | null
    ) {
      left += el.offsetLeft;
      top += el.offsetTop;
    }
    return {
      left,
      top,
      width: page.wrapper.offsetWidth,
      height: page.wrapper.offsetHeight,
    };
  }

  zoom(delta: number) {
    const rect = this.scroller.getBoundingClientRect();
    const scale = (this._pendingZoom?.scale ?? this.scale) + delta;
    this.zoomAt(scale, rect.width / 2, rect.height / 2);
  }

  scrollToRelative(delta: number) {
    const current = this.getCurrentPage();
    const target = this.pages.find((p) => p.pageNumber === current + delta);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async scrollToPoint(pageIndex: number, top: number, center = false) {
    const page = this.document.getPage(pageIndex + 1);
    if (!page) return;

    const originScrollTop = this.scroller.scrollTop;
    const originPage = this.#computeCurrentPage();

    const pageHeight = page.size.height;
    const viewportY = (pageHeight - top) * this.scale;
    const wrapper = this.pages[pageIndex]?.wrapper;
    if (!wrapper) return;

    let targetTop = wrapper.offsetTop + Math.max(0, viewportY);

    if (center) {
      const viewportHeight = this.scroller.clientHeight;
      targetTop -= viewportHeight / 2.3;
    }

    this.scroller.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });

    this.scrollBack.show(originScrollTop, originPage);
  }

  scrollToTop() {
    const target = this.pages.find((p) => p.pageNumber === 1);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "instant", block: "start" });
  }

  scrollToBottom() {
    this.scroller.scrollTo({
      top: this.scroller.scrollHeight,
      behavior: "instant",
    });
  }

  goToPage(n: number) {
    const target = this.pages.find((p) => p.pageNumber === n);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "instant", block: "start" });
  }

  /**
   * Lay out every page for `scale` and the current rotation: wrapper boxes,
   * overlay layers, and the backing-store size each page should render at.
   *
   * It sizes no canvas itself. Buffers follow visibility — PageView allocates
   * one on render and frees it on release — so this publishes the target and
   * drops the pixels of anything now off-screen. Every caller follows it with
   * a render of the visible pages, which is what puts those pixels back.
   */
  async layoutPages(scale: number) {
    const outputScale = window.devicePixelRatio || 1;
    this.#layoutDpr = outputScale;
    const isSwapped = this.rotation === 90 || this.rotation === 270;

    // The gap above and below each page (or spread row) scales with the
    // pages, so a pinch's preview — one transform over the whole stage —
    // shows the gaps where its commit leaves them. Whole px, so pages land
    // on pixel boundaries and the compositor never resamples them.
    this.stage.style.setProperty(
      "--page-gap",
      `${Math.round(PAGE_GAP * scale)}px`,
    );

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const dims = this.document.pageDimensions[i];

      // Off-screen pages are released; on-screen ones keep their pixels until
      // the re-render, but not a render in flight or a detail region, both cut
      // for the old layout.
      if (this.visiblePages.has(page)) {
        page.canvas.dataset.rendered = "false";
        page.cancel();
        page.dropDetail();
      } else {
        page.release();
      }

      // Original (unrotated) visual dimensions
      const origWidth = Math.round(dims.width * scale);
      const aspectRatio = dims.height / dims.width;
      const origHeight = Math.round(origWidth * aspectRatio);

      // A canvas backing store is whole pixels, so round here rather than let
      // the `canvas.width` setter truncate. At a fractional devicePixelRatio
      // (browser zoom, 125%/150% display scaling) the CSS box is then derived
      // from the rounded store, so one buffer pixel maps to one device pixel
      // and the compositor never resamples (blurs) the page. Round *up*: the
      // wrapper stays `origWidth` and is transparent, so a canvas a fraction
      // of a pixel short would leave a seam of wallpaper along its edge; one
      // that overhangs is clipped by the wrapper's paint containment.
      const fullWidth = Math.ceil(origWidth * outputScale);
      const fullHeight = Math.ceil(origHeight * outputScale);

      // Publish the size this page renders at: in full, or capped with a
      // detail region over it (detail_region.ts). The CSS box is the full
      // size either way, so a capped store is stretched to fill it.
      const store = cappedSize({ width: fullWidth, height: fullHeight });
      page.canvasWidth = store.width;
      page.canvasHeight = store.height;
      page.fullWidth = fullWidth;
      page.fullHeight = fullHeight;

      Object.assign(page.canvas.style, {
        width: `${fullWidth / outputScale}px`,
        height: `${fullHeight / outputScale}px`,
        transform: "",
        transformOrigin: "",
      });

      // Inner container keeps original page dimensions
      Object.assign(page.rotateInner.style, {
        width: `${origWidth}px`,
        height: `${origHeight}px`,
        transformOrigin: "0 0",
      });

      // Apply rotation transform to inner container
      switch (this.rotation) {
        case 0:
          page.rotateInner.style.transform = "";
          break;
        case 90:
          page.rotateInner.style.transform = "rotate(90deg) translateY(-100%)";
          break;
        case 180:
          page.rotateInner.style.transform =
            "rotate(180deg) translate(-100%, -100%)";
          break;
        case 270:
          page.rotateInner.style.transform = "rotate(270deg) translateX(-100%)";
          break;
      }

      // Wrapper dimensions account for rotation
      const wrapperWidth = isSwapped ? origHeight : origWidth;
      const wrapperHeight = isSwapped ? origWidth : origHeight;

      Object.assign(page.wrapper.style, {
        width: `${wrapperWidth}px`,
        height: `${wrapperHeight}px`,
        // Placeholder size used while content-visibility:auto skips this page
        // off-screen. `auto` lets the browser remember the real rendered size
        // once seen; the lengths are the fallback for not-yet-rendered pages,
        // matching the explicit box so the scrollbar never jumps.
        containIntrinsicSize: `auto ${wrapperWidth}px auto ${wrapperHeight}px`,
      });

      // Overlay layers use original dimensions (inside rotateInner)
      const layerStyles = {
        left: "0px",
        top: "0px",
        width: `${origWidth}px`,
        height: `${origHeight}px`,
        transform: "",
        transformOrigin: "",
      };
      Object.assign(page.annotationLayer.style, layerStyles);
      Object.assign(page.textLayer.style, layerStyles);
    }
  }

  /** devicePixelRatio the last `layoutPages` sized the backing stores for. */
  #layoutDpr = 0;
  #unwatchDpr: (() => void) | null = null;

  async refreshAllPages() {
    await this.layoutPages(this.scale);
    this.#renderVisiblePages();
    this.annotationManager?.refresh();
  }

  fit(percentage = 1, overrideMode = 0) {
    const viewRect = this.scroller.getBoundingClientRect();
    const fitMode = overrideMode === 1 ? 1 : this.fitMode;
    const isSwapped = this.rotation === 90 || this.rotation === 270;
    const dims = this.document.pageDimensions[0];

    if (fitMode === 1) {
      if (this.spreadMode === 0) {
        const intrinsicWidth = isSwapped ? dims?.height : dims?.width;
        if (!intrinsicWidth) return;

        const targetScale = (viewRect.width / intrinsicWidth) * percentage;
        this.zoomAt(targetScale, viewRect.width / 2, viewRect.height / 2);
      } else {
        const pageWidth = (isSwapped ? dims?.height : dims?.width) || 0;
        const spreadWidth = pageWidth * 2 + 4;
        const targetScale = (viewRect.width / spreadWidth) * percentage;
        this.zoomAt(targetScale, viewRect.width / 2, viewRect.height / 2);
      }
      this.fitMode = 2;
    } else {
      const intrinsicHeight = isSwapped ? dims?.width : dims?.height;
      if (!intrinsicHeight) return;
      const targetScale = (viewRect.height / intrinsicHeight) * percentage;
      this.zoomAt(targetScale, viewRect.width / 2, viewRect.height / 2);
      this.fitMode = 1;
    }

    return this.fitMode;
  }

  spread() {
    const modes: SpreadMode[] = [0, 1, 2];
    const nextMode = modes[(this.spreadMode + 1) % modes.length];

    this.setSpreadMode(nextMode);
    return this.spreadMode;
  }

  setSpreadMode(mode: SpreadMode) {
    if (this.spreadMode === mode) return;

    const currentPage = this.getCurrentPage();
    this.spreadMode = mode;
    this.spreadLayout.apply(this.stage, this.pages, mode);

    if (currentPage > 0) {
      this.goToPage(currentPage);
    }

    requestAnimationFrame(() => {
      this.fit(1, 1);
      this.annotationManager?.refresh();
    });
  }

  onDocumentChange(event: DocEventName, data?: Record<string, any>) {
    if (ANNOTATION_EVENTS.has(event)) {
      this.annotationManager?.onDocumentChange(event, data);
    }
    if (event === DocEvent.INDEX_READY) {
      for (const pageView of this.visiblePages) {
        pageView.refreshOverlays();
      }
    }
  }

  getSelection() {
    return this.textSelectionManager.getSelection();
  }

  hasSelection() {
    return this.textSelectionManager.hasSelection();
  }

  clearSelection() {
    this.textSelectionManager.clearSelection();
  }

  setHandMode(on: boolean) {
    if (this.handMode === on) return;
    this.handMode = on;

    if (on) {
      // Clear any existing selection
      this.clearSelection();
      this.handPan.enable();
    } else {
      this.handPan.disable();
    }
  }

  // ==================
  // Rotation
  // ==================

  rotate() {
    this.rotation = (this.rotation + 90) % 360;
    this.#applyRotation();
  }

  resetRotation() {
    if (this.rotation === 0) return;
    this.rotation = 0;
    this.#applyRotation();
  }

  get isRotated() {
    return this.rotation !== 0;
  }

  #applyRotation() {
    const isRotated = this.rotation !== 0;
    this.paneEl.classList.toggle("pane-rotated", isRotated);

    // Dismiss annotation toolbar and clear selection when entering rotation
    if (isRotated) {
      this.clearSelection();
      document
        .querySelector(".annotation-toolbar-container")
        ?.classList.remove("visible");
    }

    this.layoutPages(this.scale);
    this.#renderVisiblePages();
    this.annotationManager?.refresh();
  }

  destroy() {
    this.document.unsubscribe(this);
    this.#unwatchDpr?.();
    this.#unwatchDpr = null;
    if (this.observer) {
      for (const page of this.pages) {
        this.observer.unobserve(page.wrapper);
      }
      this.observer?.disconnect();
      this.observer = null;
    }
    if (this.centerObserver) {
      this.centerObserver.disconnect();
      this.centerObserver = null;
      this.centeredPages.clear();
    }
    // Hand mode and the off-span selection park listeners on `document`;
    // without this they outlive the pane.
    this.handPan.disable();
    this.nearestSpanSelection?.destroy();
    this.nearestSpanSelection = null;
    this.controls.destroy();
    this.textSelectionManager.destroy();
    this.annotationManager?.destroy();
    this.scrollBack.destroy();

    // Clean up spread layout
    this.spreadLayout.clear(this.stage);

    if (this.#renderTimer !== null) clearTimeout(this.#renderTimer);
    this.#renderTimer = null;
    this.#renderQueue = [];
    this.scroller.removeEventListener("scroll", this.#scheduleDetailRefresh);
    if (this.#detailTimer !== null) clearTimeout(this.#detailTimer);
    this.#detailTimer = null;
    if (this._zoomRAF !== null) cancelAnimationFrame(this._zoomRAF);
    this._zoomRAF = null;
    this._pendingZoom = null;
    for (const page of this.pages) {
      page.release();
    }
  }
}
