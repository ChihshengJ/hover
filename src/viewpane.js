import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

import { PageView } from "./page.js";
import { PaneControls } from "./controls/pane_controls.js";

/**
* @typedef {import('./page.js').PageView} PageView;
* @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
*/

export class ViewerPane {
  /**
  * @param {PDFDocumentModel} documentModel;
  * @param {HTMLElement} paneEl;
  */
  constructor(documentModel, paneEl, options = {}) {
    this.document = documentModel;
    this.paneEl = paneEl;
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

    this.spreadMode = 0;
    this.spreadRows = [];

    this.document.subscribe(this);
  }

  async initialize(scale = 1) {
    this.scale = scale;
    this.#createScroller();
    this.#createStage();
    this.canvases = await this.#createCanvasPlaceholders();
    this.pages = this.canvases.map((canvas, idx) => {
      // Wrapper is a page-wrapper containing a canvas, a page number, and everything in a page
      const pageView = new PageView(
        this,
        idx + 1,
        canvas,
      );
      const wrapper = canvas.parentElement;
      this.pageMap.set(wrapper, pageView);
      return pageView;
    });
    this.resizeAllCanvases(this.scale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setupLazyRender();
    this.controls.attach();
  }
 
  //*******************
  // Creating elements
  // ******************
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

  #maybeRelease(page) {
    const rect = page.wrapper.getBoundingClientRect();
    const threshold = window.innerHeight * 2;

    if (rect.bottom < -threshold || rect.top > window.innerHeight + threshold) {
      page.release();
    }
  }

  #renderVisiblePages() {
    for (const pageView of this.visiblePages) {
      if (pageView.canvas.dataset.rendered === "false") {
        pageView.render(this.scale);
      }
    }
  }

  //*******************
  // Viewer controls
  // ******************
  getCurrentPage() {
    const viewRect = this.scroller.getBoundingClientRect();
    const viewportMidY = viewRect.top + viewRect.height / 2;
    for (const canvas of this.canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.top <= viewportMidY && rect.bottom > viewportMidY) {
        return parseInt(canvas.dataset.pageNumber);
      }
    }
    return 0;
  }

  zoomAt(scale, focusX, focusY) {
    const scroller = this.scroller;
    const prevScale = this.scale;

    const docX = (scroller.scrollLeft + focusX) / prevScale;
    const docY = (scroller.scrollTop + focusY) / prevScale;
    this.scale = scale;
    this.resizeAllCanvases(scale);

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

    const newScale = Math.min(Math.max(this.scale + delta, 0.5), 7);
    this.zoomAt(newScale, focusX, focusY);
  }

  scrollToRelative(delta) {
    const current = this.getCurrentPage();
    const target = this.pages.find((p) => p.pageNumber === current + delta);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  
  async scrollToPoint(pageIndex, left, top) {
    const page = await this.document.pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: this.scale });
    const [, y] = viewport.convertToViewportPoint(left, top);

    //Have to manually set the offset to 35 somehow otherwise there's a scaled offset
    const targetTop = this.stage.offsetTop + Math.max(0, y - 35);
    this.scroller.scrollTo({ top: targetTop, behavior: "instant" });
  }

  scrollToTop() {
    const target = this.pages.find((p) => p.pageNumber === 1);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  goToPage(n) {
    const target = this.pages.find((p) => p.pageNumber === n);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "instant", block: "center" });
  }

  async resizeAllCanvases(scale) {
    const outputScale = window.devicePixelRatio || 1;
    const MAX_RENDER_SCALE = 7.0; // Cap render scale for performance
    
    const effectiveScale = Math.min(scale, MAX_RENDER_SCALE);
    
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const dims = this.document.pageDimensions[i];
      page.canvas.dataset.rendered = "false";
      
      // Visual dimensions (what the user sees in CSS pixels)
      const visualWidth = dims.width * effectiveScale;
      const visualHeight = dims.height * effectiveScale;
      
      // Canvas backing store dimensions (accounting for device pixel ratio)
      const canvasWidth = Math.round(visualWidth * outputScale);
      const canvasHeight = Math.round(visualHeight * outputScale);
      
      // Set the actual canvas buffer size
      page.canvas.width = canvasWidth;
      page.canvas.height = canvasHeight;
      
      // Set CSS dimensions to match visual size (no transform needed)
      Object.assign(page.canvas.style, {
        width: `${visualWidth}px`,
        height: `${visualHeight}px`,
        transform: "",  // Clear any existing transform
        transformOrigin: "",
      });
      
      // Wrapper matches visual size exactly
      Object.assign(page.wrapper.style, {
        width: `${visualWidth}px`,
        height: `${visualHeight}px`,
      });
      
      // Overlay layers match visual dimensions, no transform
      const layerStyles = {
        left: "0px",
        top: "0px",
        width: `${visualWidth}px`,
        height: `${visualHeight}px`,
        transform: "",
        transformOrigin: "",
      };
      Object.assign(page.annotationLayer.style, layerStyles);
      Object.assign(page.textLayer.style, layerStyles);
      
      // Store the effective scale for the actual PDF rendering pass
      // page.pendingRenderScale = effectiveScale * outputScale;
      // console.log(page.pendingRenderScale);
    }
  }

  async refreshAllPages() {
    await this.resizeAllCanvases(this.scale);
    this.#renderVisiblePages();
  }

  fitWidth() {

  }

  spread() {
    const modes = [0, 1, 2];
    const nextMode = (this.spreadMode + 1) % modes.length;
    
    this.setSpreadMode(nextMode);
    return this.spreadMode;
  }

  setSpreadMode(mode) {
    if (this.spreadMode === mode) return;
    
    const currentPage = this.getCurrentPage();
    
    this.#clearSpreadLayout();
    
    this.spreadMode = mode;
    
    if (mode === 0) {
      this.#layoutSinglePage();
    } else {
      this.#layoutSpread(mode);
    }
    
    // Restore scroll position
    if (currentPage > 0) {
      this.goToPage(currentPage);
    }
    
    // Re-render visible pages after layout change
    requestAnimationFrame(() => {
      this.#renderVisiblePages();
    });
  }

  #clearSpreadLayout() {
    for (const row of this.spreadRows) {
      while (row.firstChild) {
        this.stage.appendChild(row.firstChild);
      }
      row.remove();
    }
    this.spreadRows = [];
    
    if (this.spreadContainer) {
      // Move any remaining children back to stage
      while (this.spreadContainer.firstChild) {
        this.stage.appendChild(this.spreadContainer.firstChild);
      }
      this.spreadContainer.remove();
      this.spreadContainer = null;
    }
  }

  #layoutSinglePage() {
  // Pages are already direct children of stage after #clearSpreadLayout
  // Just ensure they're in the correct order
    for (const pageView of this.pages) {
      pageView.wrapper.classList.remove('spread-page', 'spread-page-left', 'spread-page-right', 'spread-page-single');
      this.stage.appendChild(pageView.wrapper);
    }
  }

  #layoutSpread(mode) {
    this.spreadContainer = document.createElement('div');
    this.spreadContainer.className = 'spread-container';
    this.stage.appendChild(this.spreadContainer);
    
    // Group pages into pairs based on mode
    const pairs = this.#createPagePairs(mode);
    
    for (const pair of pairs) {
      const row = document.createElement('div');
      row.className = 'spread-row';
      
      if (pair.length === 1) {
        // Single page (first page in odd mode, or last page if odd total)
        const pageView = pair[0];
        pageView.wrapper.classList.add('spread-page', 'spread-page-single');
        pageView.wrapper.classList.remove('spread-page-left', 'spread-page-right');
        row.appendChild(pageView.wrapper);
        row.classList.add('spread-row-single');
      } else {
        // Page pair
        const [left, right] = pair;
        
        left.wrapper.classList.add('spread-page', 'spread-page-left');
        left.wrapper.classList.remove('spread-page-single', 'spread-page-right');
        row.appendChild(left.wrapper);
        
        right.wrapper.classList.add('spread-page', 'spread-page-right');
        right.wrapper.classList.remove('spread-page-single', 'spread-page-left');
        row.appendChild(right.wrapper);
      }
      
      this.spreadContainer.appendChild(row);
      this.spreadRows.push(row);
    }
  }

  #createPagePairs(mode) {
    const pairs = [];
    if (mode === 1) {
      for (let i = 0; i < this.pages.length; i += 2) {
        if (i + 1 < this.pages.length) {
          pairs.push([this.pages[i], this.pages[i + 1]]);
        } else {
          pairs.push([this.pages[i]]);
        }
      }
    } else if (mode === 2) {
      pairs.push([this.pages[0]]);
      for (let i = 1; i < this.pages.length; i += 2) {
        if (i + 1 < this.pages.length) {
          pairs.push([this.pages[i], this.pages[i + 1]]);
        } else {
          pairs.push([this.pages[i]]);
        }
      }
    }
    
    return pairs;
  }

  getSpreadMode() {
    return this.spreadMode;
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
    
    // Clean up spread layout
    this.#clearSpreadLayout();
    
    for (const page of this.pages) {
      page.release();
    }
  }
}
