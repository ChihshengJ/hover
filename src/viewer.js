import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PageView } from "./page.js";
import { GestureDetector } from "./helpers.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export class PDFViewer {
  constructor(viewerEl) {
    this.viewerEl = viewerEl;
    this.pages = [];
    this.scale = 1;
    this.observer = null;
    this.pdfDoc = null;
  }

  async loadDocument(pdfDoc, allNamedDests) {
    this.pdfDoc = pdfDoc;
    const canvases = await this.#createCanvasPlaceholders(pdfDoc.numPages, this.viewerEl);

    this.pages = canvases.map((canvas, idx) => {
      const wrapper = canvas.parentElement;
      return new PageView(pdfDoc, idx + 1, wrapper, allNamedDests);
    });

    this.#resizeAllCanvases(this.scale);

    this.setupLazyRender();

    this.viewerEl.addEventListener("scroll", () => {
      let currentPage = 1;
      for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        if (rect.top < window.innerHeight / 2 && rect.bottom > 0) {
          currentPage = parseInt(canvas.dataset.pageNumber);
        }
      }
      document.getElementById("page-num").textContent = currentPage;
    });

    window.addEventListener("resize", () => {
      this.#renderAtScale(this.scale);
    });
    
    let tempScale = this.scale;
    const gesture = new GestureDetector(document.getElementById("viewer-container"));
    
    gesture.getEventTarget().addEventListener("pinchupdate", (e) => {
      const ratio = e.detail.startScaleRatio;
      tempScale = Math.max(0.5, Math.min(3, this.scale * ratio));
    });

    gesture.getEventTarget().addEventListener("pinchend", (e) => {
      const containerRect = this.viewerEl.getBoundingClientRect();
      console.log(e.detail);
      const focusX = e.detail.center.x - containerRect.left;
      const focusY = e.detail.center.y - containerRect.top;
      this.#zoomAt(tempScale, focusX, focusY);
    });
  }

  async #createCanvasPlaceholders(numPages, viewerEl) {
    const canvases = [];
    for (let i = 1; i <= numPages; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper";
      wrapper.style.margin = "10px 0";
      wrapper.style.display = "flex";
      wrapper.style.flexDirection = "column";
      wrapper.style.alignItems = "center";

      const label = document.createElement("div");
      label.textContent = `Page ${i}`;
      label.style.color = "#888";
      label.style.fontSize = "0.8rem";

      const canvas = document.createElement("canvas");
      canvas.dataset.pageNumber = i;

      wrapper.appendChild(canvas);
      wrapper.appendChild(label);
      viewerEl.appendChild(wrapper);

      canvases.push(canvas);
    }
    return canvases;
  }

  setupLazyRender() {
    const observer = new IntersectionObserver(
      (entries) => {
        // console.log(entries[0]);
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageView = this.pages.find(
              (p) => p.wrapper === entry.target
            );
            if (!pageView) continue;

            if (entry.isIntersecting) {
                if(pageView.canvas.dataset.rendered === "false") {
                  pageView.render(this.scale);
                }
            } else {
              this.#maybeRelease(pageView);
            }
          }
        }
      },
      {
        // root: this.viewerEl,
        // rootMargin: "500px 0px",
        threshold: 0.1,
      });
    this.observer = observer;

    for (const pageView of this.pages) {
      this.observer.observe(pageView.wrapper);
    }
  }

  #refreshObserver() {
    if (!this.observer) return;
    
    this.pages.forEach(p => {
      this.observer.unobserve(p.wrapper);
      this.observer.observe(p.wrapper);
    });
  }

  #renderAtScale(scale) {
    this.scale = scale
    this.#resizeAllCanvases(scale);
    this.#refreshObserver();
  }

  #zoomAt(scale, focusX, focusY) {
    const viewer = this.viewerEl;
    const prevScale = this.scale;

    const docX = (viewer.scrollLeft + focusX) / prevScale;
    const docY = (viewer.scrollTop + focusY)/ prevScale;
    this.#resizeAllCanvases(scale);
    this.scale = scale;
    this.#refreshObserver();

    viewer.scrollLeft = docX * scale - focusX;
    viewer.scrollTop = docY * scale - focusY;
  }

  zoom(delta) {
    this.observer.disconnect();
    const viewer = this.viewerEl;
    const rect = viewer.getBoundingClientRect();
    const focusX = rect.width / 2;
    const focusY = rect.height / 2;

    const newScale = Math.min(Math.max(this.scale + delta, 0.5), 3);
    this.#zoomAt(newScale, focusX, focusY);
  }

  #maybeRelease(page) {
    const rect = page.wrapper.getBoundingClientRect();
    if (rect.bottom < -window.innerHeight * 2 || rect.top > window.innerHeight * 3) {
      page.cancel();
      page.canvas.width = 0;
      page.canvas.height = 0;
      page.textLayer.innerHTML = "";
      page.annotationLayer.innerHTML = "";
      page.canvas.dataset.rendered = "false";
    }
  }
  
  scrollToRelative(delta) {
    const current = parseInt(document.getElementById("page-num").textContent); 
    const target = this.pages.find(
      (p) => p.pageNumber === current + delta,
    );
    if (target) target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  #resizeAllCanvases(scale) {
    this.scale = scale;
    for (const page of this.pages) {
      page.canvas.dataset.rendered = "false";
      page.resize(scale);
    }
  }

}

