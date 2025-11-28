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
  }

  async loadDocument(pdfDoc, allNamedDests) {
    this.pdfDoc = pdfDoc;
    this.canvases = await this.#createCanvasPlaceholders(pdfDoc.numPages);
    this.pages = this.canvases.map((canvas, idx) => {
      const wrapper = canvas.parentElement;
      const pageView = new PageView(pdfDoc, idx + 1, wrapper, allNamedDests);
      this.pageMap.set(wrapper, pageView);
      return pageView;
    });
    await this.#resizeAllCanvases(this.scale);
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

  setupLazyRender() {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageView = this.pages.find((p) => p.wrapper === entry.target);
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
    this.#refreshObserver();
  }

  zoomAt(scale, focusX, focusY) {
    const viewer = this.viewerEl;
    const prevScale = this.scale;

    const docX = (viewer.scrollLeft + focusX) / prevScale;
    const docY = (viewer.scrollTop + focusY) / prevScale;
    this.#resizeAllCanvases(scale);
    this.scale = scale;
    this.#refreshObserver();

    const targetLeft = docX * scale - focusX;
    const targetTop = docY * scale - focusY;
    const maxLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
    const maxTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
    viewer.scrollLeft = Math.min(Math.max(0, targetLeft), maxLeft);
    viewer.scrollTop = Math.min(Math.max(0, targetTop), maxTop);

    this.#renderVisiblePages();
  }

  zoom(delta) {
    this.observer.disconnect();
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
    if (
      rect.bottom < -window.innerHeight * 2 ||
      rect.top > window.innerHeight * 3
    ) {
      page.cancel();
      page.textLayer.innerHTML = "";
      page.annotationLayer.innerHTML = "";
      page.canvas.dataset.rendered = "false";
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
    this.scale = scale;
    await Promise.all(
      this.pages.map(async (page) => {
        page.canvas.dataset.rendered = "false";
        await page.resize(scale);
      }),
    );
  }

  #renderVisiblePages() {
    for (const pageView of this.visiblePages) {
      if (pageView.canvas.dataset.rendered === "false") {
        pageView.render(this.scale);
      }
    }
  }

  #refreshObserver() {
    if (!this.observer) return;

    this.pages.forEach((p) => {
      this.observer.unobserve(p.wrapper);
      this.observer.observe(p.wrapper);
    });
  }
}
