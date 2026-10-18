import { PageView } from "./page.js";
import { PaneControls } from "../ui/controls/pane_controls.js";
import { ScrollBackButton } from "../ui/controls/scroll_back_button.js";
import { TextSelectionManager } from "./text_manager.js";
import { NearestSpanSelection } from "./nearest_span_selection.js";
import { HandPan } from "./hand_pan.js";
import { SpreadLayout } from "./spread_layout.js";
import { RenderScheduler } from "./render_scheduler.js";
import { CurrentPageTracker } from "./current_page.js";
import { ZoomController } from "./zoom_controller.js";
import { computePageLayout, isQuarterTurn } from "./page_layout.js";
import { watchDevicePixelRatio } from "./device_pixel_ratio.js";
import { AnnotationManager } from "../ui/annotation/annotation_manager.js";
import { DocEvent, ANNOTATION_EVENTS } from "../model/doc_events.js";

import type { PDFDocumentModel } from "../model/doc.js";
import type { DocEventName } from "../model/doc_events.js";
import type { SpreadMode } from "./spread_layout.js";
import type {
  AnnotationHost,
  PaneAnnotationCallbacks,
} from "../ui/annotation/host.js";

/** Gap above and below each page, in PDF points; 14px at the default 1.7. */
const PAGE_GAP = 8;

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

  scale = 1;
  /** 1 for width, 2 for height. */
  fitMode = 1;
  pages: PageView[] = [];
  controls: PaneControls;

  renderScheduler!: RenderScheduler;
  currentPageTracker!: CurrentPageTracker;
  zoomController!: ZoomController;

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

  /** devicePixelRatio the last `layoutPages` sized the backing stores for. */
  #layoutDpr = 0;
  #unwatchDpr: (() => void) | null = null;

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
    this.pages = this.#createCanvasPlaceholders().map((canvas, idx) => {
      return new PageView(
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
    });
    this.renderScheduler = new RenderScheduler({
      scroller: this.scroller,
      pages: this.pages,
      getScale: () => this.scale,
      getRotation: () => this.rotation,
      getLayoutDpr: () => this.#layoutDpr,
      isPaused: () => this.zoomController.pinching,
    });
    this.currentPageTracker = new CurrentPageTracker(
      this.scroller,
      this.pages,
      () => this.controls.notifyPageChange(),
    );
    this.zoomController = new ZoomController({
      paneEl: this.paneEl,
      scroller: this.scroller,
      stage: this.stage,
      pages: this.pages,
      getScale: () => this.scale,
      relayout: (scale) => {
        this.scale = scale;
        this.layoutPages(scale);
      },
      renderVisible: () => this.renderScheduler.renderVisible(),
      onZoomed: () => {
        this.annotationManager?.refresh();
        this.controls.updateZoomDisplay();
      },
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
    this.renderScheduler.observe();
    this.currentPageTracker.observe();
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
    this.paneEl.appendChild(this.scroller);
  }

  #createStage() {
    this.stage = document.createElement("div");
    this.stage.className = "viewer-stage";
    this.stage.id = `stage-${this.id}`;
    this.scroller.appendChild(this.stage);
  }

  #createCanvasPlaceholders(): HTMLCanvasElement[] {
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

  /** Pages within render range of the viewport; see RenderScheduler. */
  get visiblePages(): ReadonlySet<PageView> {
    return this.renderScheduler.visiblePages;
  }

  //*******************
  // Viewer controls
  // ******************

  getCurrentPage() {
    return this.currentPageTracker.get();
  }

  /** See `ZoomController.zoomAt()`. */
  zoomAt(scale: number, focusX: number, focusY: number) {
    this.zoomController.zoomAt(scale, focusX, focusY);
  }

  beginPinch(focusX: number, focusY: number) {
    this.zoomController.beginPinch(focusX, focusY);
  }

  updatePinch(ratio: number, focusX: number, focusY: number) {
    this.zoomController.updatePinch(ratio, focusX, focusY);
  }

  endPinch(ratio: number, focusX: number, focusY: number) {
    this.zoomController.endPinch(ratio, focusX, focusY);
  }

  zoom(delta: number) {
    const rect = this.scroller.getBoundingClientRect();
    const scale = this.zoomController.targetScale + delta;
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
    const originPage = this.currentPageTracker.measure();

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
  layoutPages(scale: number) {
    const dpr = window.devicePixelRatio || 1;
    this.#layoutDpr = dpr;

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

      const dims = this.document.pageDimensions[i];
      page.applyLayout(
        computePageLayout(dims, scale, dpr, this.rotation),
        this.rotation,
      );
    }
  }

  refreshAllPages() {
    this.layoutPages(this.scale);
    this.renderScheduler.renderVisible();
    this.annotationManager?.refresh();
  }

  fit(percentage = 1, overrideMode = 0) {
    const viewRect = this.scroller.getBoundingClientRect();
    const fitMode = overrideMode === 1 ? 1 : this.fitMode;
    const isSwapped = isQuarterTurn(this.rotation);
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

    this.refreshAllPages();
  }

  destroy() {
    this.document.unsubscribe(this);
    this.#unwatchDpr?.();
    this.#unwatchDpr = null;
    this.renderScheduler.destroy();
    this.currentPageTracker.destroy();
    this.zoomController.destroy();
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

    for (const page of this.pages) {
      page.release();
    }
  }
}
