import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

import { PageView } from "./page.js";

export class PDFViewer {
  constructor(viewerEl) {
    this.viewerEl = viewerEl;
    this.pages = [];
    this.pageMap = new Map();
    this.scale = 1;
    this.observer = null;
    this.pdfDoc = null;
    this.canvases = null;
    this.visiblePages = new Set();

    this.pageDimensions = [];
  }

  async loadDocument(pdfDoc, allNamedDests) {
    this.pdfDoc = pdfDoc;

    await this.#cachePageDimensions(pdfDoc.numPages);
    this.canvases = await this.#createCanvasPlaceholders(pdfDoc.numPages);
    this.pages = this.canvases.map((canvas, idx) => {
      const wrapper = canvas.parentElement;
      const pageView = new PageView(pdfDoc, idx + 1, wrapper, allNamedDests);
      this.pageMap.set(wrapper, pageView);
      return pageView;
    });
    this.#resizeAllCanvases(this.scale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setupLazyRender();
  }

  async #createCanvasPlaceholders(numPages) {
    const canvases = [];
    const stage = this.viewerEl.querySelector("#viewer-stage");

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
      stage.appendChild(wrapper);

      canvases.push(canvas);
    }
    return canvases;
  }

  async #cachePageDimensions(numPages) {
    const firstPage = await this.pdfDoc.getPage(1);
    const defaultViewport = firstPage.getViewport({ scale: 1 });
    const defaultDims = {
      width: defaultViewport.width,
      height: defaultViewport.height,
    };

    this.pageDimensions = new Array(numPages).fill(defaultDims);
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
        root: this.viewerEl,
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
    const viewer = this.viewerEl;
    const prevScale = this.scale;

    const docX = (viewer.scrollLeft + focusX) / prevScale;
    const docY = (viewer.scrollTop + focusY) / prevScale;
    this.scale = scale;
    this.#resizeAllCanvases(scale);

    // restore scroll position after resizing
    const targetLeft = docX * scale - focusX;
    const targetTop = docY * scale - focusY;
    const maxLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
    const maxTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
    viewer.scrollLeft = Math.min(Math.max(0, targetLeft), maxLeft);
    viewer.scrollTop = Math.min(Math.max(0, targetTop), maxTop);

    this.#renderVisiblePages();
  }

  zoom(delta) {
    // this.observer.disconnect();
    const viewer = this.viewerEl;
    const rect = viewer.getBoundingClientRect();
    const focusX = rect.width / 2;
    const focusY = rect.height / 2;

    const newScale = Math.min(Math.max(this.scale + delta, 0.5), 4);
    this.zoomAt(newScale, focusX, focusY);
  }

  getCurrentPage() {
    const viewRect = this.viewerEl.getBoundingClientRect();
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

  scrollToTop() {
    const target = this.pages.find((p) => p.pageNumber === 1);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async #resizeAllCanvases(scale) {
    const outputScale = window.devicePixelRatio || 1;
    const MAX_RENDER_SCALE = 4.0;
    const renderScale = Math.min(scale, MAX_RENDER_SCALE);
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const dims = this.pageDimensions[i];

      page.canvas.dataset.rendered = "false";

      const width = dims.width * renderScale;
      const height = dims.height * renderScale;

      page.canvas.width = width * outputScale;
      page.canvas.height = height * outputScale;

      Object.assign(page.wrapper.style, {
        width: `${width}px`,
        height: `${height}px`,
        transformOrigin: "top left",
        transform: `scale(${scale / renderScale})`,
      });
      Object.assign(page.canvas.style, {
        width: `${width}px`,
        height: `${height}px`,
      });
      const layerStyles = {
        left: "0px",
        top: "0px",
        width: `${width}px`,
        height: `${height}px`,
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

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    for (const page of this.pages) {
      page.release();
    }
    this.pages = [];
    this.pageMap.clear();
    this.visiblePages.clear();
  }

  #refreshObserver() {
    if (!this.observer) return;

    this.pages.forEach((p) => {
      this.observer.unobserve(p.wrapper);
      this.observer.observe(p.wrapper);
    });
  }
}
