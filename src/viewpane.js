import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

import { PageView } from "./page.js";
import { PaneControls } from "./controls/pane_controls.js";

export class ViewerPane {
  constructor(documentModel, containerEl, options = {}) {
    this.document = documentModel;
    this.viewerEl = containerEl;
    this.scroller = null;
    this.stage = null;
    this.id = options.id || crypto.randomUUID();

    this.scale = 1;
    this.fitMode = "width";
    this.pages = [];
    this.pageMap = new Map();
    this.visiblePages = new Set();
    this.observer = null;
    this.controls = new PaneControls(this);

    this.document.subscribe(this);
  }

  async initialize(scale = 1) {
    this.scale = scale;
    this.#createScroller();
    this.#createStage();
    this.canvases = await this.#createCanvasPlaceholders();
    this.pages = this.canvases.map((canvas, idx) => {
      const wrapper = canvas.parentElement;
      const pageView = new PageView(
        this.document.pdfDoc,
        idx + 1,
        wrapper,
        this.document.allNamedDests,
      );
      this.pageMap.set(wrapper, pageView);
      return pageView;
    });
    this.#resizeAllCanvases(this.scale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setupLazyRender();
    this.controls.attach();
  }

  #createScroller() {
    this.scroller = document.createElement("div");
    this.scroller.className = "pane-scroll-area";
    this.viewerEl.appendChild(this.scroller);
  }

  #createStage() {
    this.stage = document.createElement("div");
    this.stage.className = "viewer-stage";
    this.stage.id = `stage-${this.id}`;
    this.scroller.appendChild(this.stage);
  }

  async #createCanvasPlaceholders() {
    const canvases = [];
    const numPages = this.document.numPages;

    for (let i = 1; i <= numPages; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper";
      wrapper.style.margin = "14px 0";
      wrapper.style.display = "block";
      wrapper.style.width = "fit-content";

      const label = document.createElement("div");
      label.className = "page-num";
      label.textContent = `| Page ${i}`;

      const canvas = document.createElement("canvas");
      canvas.dataset.pageNumber = i;

      wrapper.appendChild(canvas);
      wrapper.appendChild(label);
      this.stage.appendChild(wrapper);

      canvases.push(canvas);
    }
    return canvases;
  }

  setupLazyRender() {
    if (this.observer) {
      this.observer.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageView = this.pageMap.get(entry.target);
          if (!pageView) continue;

          if (entry.isIntersecting) {
            this.visiblePages.add(pageView);
            if (pageView.canvas.dataset.rendered === "false") {
              pageView.render(this.scale);
            }
          } else {
            this.visiblePages.delete(pageView);
            this.#maybeRelease(pageView);
          }
        }
      },
      {
        root: this.scroller,
        rootMargin: "300px 0px",
        threshold: 0.1,
      },
    );
    this.observer = observer;

    for (const pageView of this.pages) {
      this.observer.observe(pageView.wrapper);
    }
  }

  renderAtScale(scale) {
    this.scale = scale;
    this.#resizeAllCanvases(scale);
    this.#renderVisiblePages();
  }

  zoomAt(scale, focusX, focusY) {
    const scroller = this.scroller;
    const prevScale = this.scale;

    const docX = (scroller.scrollLeft + focusX) / prevScale;
    const docY = (scroller.scrollTop + focusY) / prevScale;
    this.scale = scale;
    this.#resizeAllCanvases(scale);

    // restore scroll position after resizing
    const targetLeft = docX * scale - focusX;
    const targetTop = docY * scale - focusY;
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollLeft = Math.min(Math.max(0, targetLeft), maxLeft);
    scroller.scrollTop = Math.min(Math.max(0, targetTop), maxTop);

    this.#renderVisiblePages();
  }

  zoom(delta) {
    const scroller = this.scroller;
    const rect = scroller.getBoundingClientRect();
    const focusX = rect.width / 2;
    const focusY = rect.height / 2;

    const newScale = Math.min(Math.max(this.scale + delta, 0.5), 4);
    this.zoomAt(newScale, focusX, focusY);
  }

  getCurrentPage() {
    const viewRect = this.scroller.getBoundingClientRect();
    const viewportMidY = viewRect.top + viewRect.height / 2;
    for (const canvas of this.canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.top <= viewportMidY && rect.bottom > viewportMidY) {
        return parseInt(canvas.dataset.pageNumber);
      }
    }
    return 1;
  }

  getScale() {
    return this.scale;
  }

  #maybeRelease(page) {
    const rect = page.wrapper.getBoundingClientRect();
    const threshold = window.innerHeight * 2;

    if (rect.bottom < -threshold || rect.top > window.innerHeight + threshold) {
      page.release();
    }
  }

  scrollToRelative(delta) {
    const current = this.getCurrentPage();
    const target = this.pages.find((p) => p.pageNumber === current + delta);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  goToPage(n) {
    const target = this.pages.find((p) => p.pageNumber === n);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "instant", block: "center" });
  }

  scrollToTop() {
    const target = this.pages.find((p) => p.pageNumber === 1);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async #resizeAllCanvases(scale) {
    const outputScale = window.devicePixelRatio || 1;
    const MAX_RENDER_SCALE = 3.0; // Cap render scale for performance
    const renderScale = Math.min(scale, MAX_RENDER_SCALE);
    const visualScale = scale / renderScale; // The CSS transform scale
    console.log(scale, renderScale, visualScale, outputScale);

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const dims = this.document.pageDimensions[i];

      page.canvas.dataset.rendered = "false";

      // Canvas render dimensions (at renderScale)
      const canvasWidth = dims.width * renderScale;
      const canvasHeight = dims.height * renderScale;

      // Visual dimensions after transform (what user sees)
      const visualWidth = canvasWidth * visualScale;
      const visualHeight = canvasHeight * visualScale;

      page.canvas.width = canvasWidth * outputScale;
      page.canvas.height = canvasHeight * outputScale;

      Object.assign(page.canvas.style, {
        width: `${canvasWidth}px`,
        height: `${canvasHeight}px`,
      });

      Object.assign(page.wrapper.style, {
        // Set wrapper to VISUAL size so scroll container sees correct dimensions
        width: `${visualWidth}px`,
        height: `${visualHeight}px`,
      });

      // Apply transform to canvas instead, positioned within the wrapper
      Object.assign(page.canvas.style, {
        transformOrigin: "top left",
        transform: visualScale !== 1 ? `scale(${visualScale})` : "",
      });

      const layerStyles = {
        left: "0px",
        top: "0px",
        width: `${canvasWidth}px`,
        height: `${canvasHeight}px`,
        transformOrigin: "top left",
        transform: visualScale !== 1 ? `scale(${visualScale})` : "",
      };
      Object.assign(page.annotationLayer.style, layerStyles);
      Object.assign(page.textLayer.style, layerStyles);

      page.pendingRenderScale = renderScale;
    }
  }

  #renderVisiblePages() {
    for (const pageView of this.visiblePages) {
      if (pageView.canvas.dataset.rendered === "false") {
        pageView.render(this.scale);
      }
    }
  }

  onDocumentChange(event, data) {
    if (event == "highlight-added") {
      const { pageNum } = data;
      const pageView = this.pages[pageNum - 1];
      if (pageView && this.visiblePages.has(pageView)) {
        pageView.renderHightlights(this.document.highlights.get(pageNum));
      }
    }
  }

  destroy() {
    this.document.unsubscribe(this);
    this.observer?.disconnect();
    this.controls.destroy();
    for (const page of this.pages) {
      page.release();
    }
    // this.containerEl.innerHTML = "";
  }
}
