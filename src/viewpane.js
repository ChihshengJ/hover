import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

import { PageView } from "./page.js";
import { PaneControls } from "./controls/pane_controls.js";
import { TextSelectionManager } from "./text_manager.js";
import { AnnotationManager } from "./annotation/annotation_manager.js";

/**
 * @typedef {import('./page.js').PageView} PageView;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./text_manager.js').TextSelectionManager} TextSelectionManager;
 * @typedef {import('./annotation/annotation_manager.js').AnnotationManager} AnnotationManager;
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
    this.fitMode = 1; // 1 or width, 2 for height
    this.pages = [];
    this.pageMap = new Map();
    this.visiblePages = new Set();
    this.observer = null;
    this.controls = new PaneControls(this);
    this.currentPage = 0;

    // 0: no spread; 1: even spread; 2: odd spread
    this.spreadMode = 0;
    this.spreadRows = [];

    this.handMode = false;
    this.isPanning = false;
    this.panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };

    this.textSelectionManager = new TextSelectionManager(this);
    this.annotationManager = null;

    this.onAnnotationHover = null;
    this.onAnnotationClick = null;
    this.editAnnotationComment = null;
    this.deleteAnnotationComment = null;
    this.selectAnnotation = null;

    this.document.subscribe(this);
  }

  async initialize(scale = 1.5) {
    this.scale = scale;
    this.#createScroller();
    this.#createStage();
    this.canvases = await this.#createCanvasPlaceholders();
    this.pages = this.canvases.map((canvas, idx) => {
      // Wrapper is a page-wrapper containing a canvas, a page number, and everything in a page
      const pageView = new PageView(this, idx + 1, canvas);
      const wrapper = canvas.parentElement;
      this.pageMap.set(wrapper, pageView);
      return pageView;
    });
    this.resizeAllCanvases(this.scale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setupLazyRender();
    this.controls.attach();
    this.#setupGlobalClickToSelect();
    this.annotationManager = new AnnotationManager(this);
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

  #setupGlobalClickToSelect() {
    let isSelecting = false;
    let anchorNode = null;
    let anchorOffset = 0;

    const findNearestSpanAndOffset = (clientX, clientY) => {
      let nearestSpan = null;
      let nearestDistance = Infinity;

      for (const pageView of this.visiblePages) {
        const textLayer = pageView.textLayer;
        const spans = textLayer.querySelectorAll("span");

        for (const span of spans) {
          if (!span.textContent || !span.firstChild) continue;

          const rect = span.getBoundingClientRect();

          let dx;
          if (clientX < rect.left) {
            dx = rect.left - clientX;
          } else if (clientX > rect.right) {
            dx = clientX - rect.right;
          } else {
            dx = 0;
          }

          let dy;
          if (clientY < rect.top) {
            dy = rect.top - clientY;
          } else if (clientY > rect.bottom) {
            dy = clientY - rect.bottom;
          } else {
            dy = 0;
          }

          const distSq = dx * dx + dy * dy * 4;

          if (distSq < nearestDistance) {
            nearestDistance = distSq;
            nearestSpan = span;
          }
        }
      }

      if (!nearestSpan || !nearestSpan.firstChild) return null;

      // Calculate offset within text
      const rect = nearestSpan.getBoundingClientRect();
      const textNode = nearestSpan.firstChild;
      const text = textNode.textContent;

      let offset;
      if (clientX <= rect.left) {
        offset = 0;
      } else if (clientX >= rect.right) {
        offset = text.length;
      } else {
        const proportion = (clientX - rect.left) / rect.width;
        offset = Math.round(proportion * text.length);
      }

      return { node: textNode, offset, span: nearestSpan };
    };

    const updateSelection = (clientX, clientY) => {
      const focus = findNearestSpanAndOffset(clientX, clientY);
      if (!focus || !anchorNode) return;

      const selection = document.getSelection();
      const range = document.createRange();

      // Determine order: is anchor before or after focus in DOM?
      const position = anchorNode.compareDocumentPosition(focus.node);

      let startNode, startOffset, endNode, endOffset;

      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        // Anchor comes before focus
        startNode = anchorNode;
        startOffset = anchorOffset;
        endNode = focus.node;
        endOffset = focus.offset;
      } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        // Focus comes before anchor
        startNode = focus.node;
        startOffset = focus.offset;
        endNode = anchorNode;
        endOffset = anchorOffset;
      } else {
        // Same node
        startNode = anchorNode;
        endNode = anchorNode;
        if (anchorOffset < focus.offset) {
          startOffset = anchorOffset;
          endOffset = focus.offset;
        } else {
          startOffset = focus.offset;
          endOffset = anchorOffset;
        }
      }

      try {
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (e) {
        console.warn("Selection range error:", e);
      }
    };

    this.scroller.addEventListener("mousedown", (e) => {
      // If clicked on a text span already, let native behavior work
      if (e.target.closest(".textLayer span")) return;

      // If clicked on interactive elements, ignore
      if (e.target.closest("a, button, .pane-controls, .annotationLayer a"))
        return;

      if (e.button !== 0) return;

      const anchor = findNearestSpanAndOffset(e.clientX, e.clientY);
      if (!anchor) return;

      const maxDistance = 500;
      const rect = anchor.span.getBoundingClientRect();
      const dx = Math.max(
        0,
        Math.max(rect.left - e.clientX, e.clientX - rect.right),
      );
      const dy = Math.max(
        0,
        Math.max(rect.top - e.clientY, e.clientY - rect.bottom),
      );
      if (dx * dx + dy * dy > maxDistance * maxDistance) return;

      e.preventDefault();

      isSelecting = true;
      anchorNode = anchor.node;
      anchorOffset = anchor.offset;

      // Set initial collapsed selection
      const selection = document.getSelection();
      const range = document.createRange();
      range.setStart(anchorNode, anchorOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      // Add selecting classes
      anchor.span.closest(".textLayer")?.classList.add("selecting");
      anchor.span.closest(".page-wrapper")?.classList.add("text-selecting");
    });

    document.addEventListener("mousemove", (e) => {
      if (!isSelecting) return;
      e.preventDefault();
      updateSelection(e.clientX, e.clientY);
    });

    document.addEventListener("mouseup", (e) => {
      if (!isSelecting) return;
      isSelecting = false;
      anchorNode = null;
      anchorOffset = 0;
    });
  }

  //*******************
  // Viewer controls
  // ******************
  getCurrentPage() {
    const viewRect = this.scroller.getBoundingClientRect();
    const viewportMidY = viewRect.top + viewRect.height / 2;
    for (const canvas of this.canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.top <= viewportMidY && rect.bottom >= viewportMidY) {
        this.currentPage = parseInt(canvas.dataset.pageNumber);
        return this.currentPage;
      }
    }
    return this.currentPage;
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

    // Refresh annotations after layout changes
    this.annotationManager?.refresh();
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

    const wrapper = this.pages[pageIndex]?.wrapper;
    if (!wrapper) return;

    const targetTop = wrapper.offsetTop + Math.max(0, y);

    this.scroller.scrollTo({ top: targetTop, behavior: "instant" });
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

  goToPage(n) {
    const target = this.pages.find((p) => p.pageNumber === n);
    if (target)
      target.wrapper.scrollIntoView({ behavior: "instant", block: "start" });
  }

  async resizeAllCanvases(scale) {
    const outputScale = window.devicePixelRatio || 1;
    const MAX_RENDER_SCALE = 7.0;

    const effectiveScale = Math.min(scale, MAX_RENDER_SCALE);

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const dims = this.document.pageDimensions[i];
      page.canvas.dataset.rendered = "false";

      // Round WIDTH only, then derive height to maintain aspect ratio
      const visualWidth = Math.round(dims.width * effectiveScale);
      const aspectRatio = dims.height / dims.width;
      const visualHeight = Math.round(visualWidth * aspectRatio);

      // Canvas buffer dimensions
      const canvasWidth = visualWidth * outputScale;
      const canvasHeight = visualHeight * outputScale;

      page.canvas.width = canvasWidth;
      page.canvas.height = canvasHeight;

      Object.assign(page.canvas.style, {
        width: `${visualWidth}px`,
        height: `${visualHeight}px`,
        transform: "",
        transformOrigin: "",
      });

      Object.assign(page.wrapper.style, {
        width: `${visualWidth}px`,
        height: `${visualHeight}px`,
      });

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
    }
  }

  async refreshAllPages() {
    await this.resizeAllCanvases(this.scale);
    this.#renderVisiblePages();
    // Refresh annotations after layout changes
    this.annotationManager?.refresh();
  }

  fit(percentage = 1, overrideMode = 0) {
    const viewRect = this.scroller.getBoundingClientRect();
    const fitMode = overrideMode === 1 ? 1 : this.fitMode;
    if (fitMode === 1) {
      if (this.spreadMode === 0) {
        const intrinsicWidth = this.document.pageDimensions[0]?.width;
        if (!intrinsicWidth) return;

        const targetScale = (viewRect.width / intrinsicWidth) * percentage;
        this.zoomAt(targetScale, viewRect.width / 2, viewRect.height / 2);
      } else {
        // For spread mode, use intrinsic width of two pages + gap
        const pageWidth = this.document.pageDimensions[0]?.width || 0;
        const spreadWidth = pageWidth * 2 + 4; // 4px gap from CSS
        const targetScale = (viewRect.width / spreadWidth) * percentage;
        this.zoomAt(targetScale, viewRect.width / 2, viewRect.height / 2);
      }
      this.fitMode = 2;
    } else {
      const intrinsicHeight = this.document.pageDimensions[0]?.height;
      if (!intrinsicHeight) return;
      const targetScale = (viewRect.height / intrinsicHeight) * percentage;
      this.zoomAt(targetScale, viewRect.width / 2, viewRect.height / 2);
      this.fitMode = 1;
    }

    return this.fitMode;
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

    if (currentPage > 0) {
      this.goToPage(currentPage);
    }

    requestAnimationFrame(() => {
      this.fitWidth();
      this.#renderVisiblePages();
      this.annotationManager?.refresh();
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
      while (this.spreadContainer.firstChild) {
        this.stage.appendChild(this.spreadContainer.firstChild);
      }
      this.spreadContainer.remove();
      this.spreadContainer = null;
    }
  }

  #layoutSinglePage() {
    for (const pageView of this.pages) {
      pageView.wrapper.classList.remove(
        "spread-page",
        "spread-page-left",
        "spread-page-right",
        "spread-page-single",
      );
      this.stage.appendChild(pageView.wrapper);
    }
  }

  #layoutSpread(mode) {
    this.spreadContainer = document.createElement("div");
    this.spreadContainer.className = "spread-container";
    this.stage.appendChild(this.spreadContainer);

    // Group pages into pairs based on mode
    const pairs = this.#createPagePairs(mode);

    for (const pair of pairs) {
      const row = document.createElement("div");
      row.className = "spread-row";

      if (pair.length === 1) {
        // Single page (first page in odd mode, or last page if odd total)
        const pageView = pair[0];
        pageView.wrapper.classList.add("spread-page", "spread-page-single");
        pageView.wrapper.classList.remove(
          "spread-page-left",
          "spread-page-right",
        );
        row.appendChild(pageView.wrapper);
        row.classList.add("spread-row-single");
      } else {
        // Page pair
        const [left, right] = pair;

        left.wrapper.classList.add("spread-page", "spread-page-left");
        left.wrapper.classList.remove(
          "spread-page-single",
          "spread-page-right",
        );
        row.appendChild(left.wrapper);

        right.wrapper.classList.add("spread-page", "spread-page-right");
        right.wrapper.classList.remove(
          "spread-page-single",
          "spread-page-left",
        );
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

  onDocumentChange(event, data) {
    if (event == "highlight-added") {
      const { pageNum } = data;
      const pageView = this.pages[pageNum - 1];
      if (pageView && this.visiblePages.has(pageView)) {
        pageView.renderHightlights(this.document.highlights.get(pageNum));
      }
    }
    if (event.startsWith("annotation-")) {
      this.annotationManager?.onDocumentChange(event, data);
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

  toggleHandMode() {
    this.handMode = !this.handMode;

    if (this.handMode) {
      // Clear any existing selection
      this.clearSelection();
      this.scroller.classList.add("hand-mode");
      this.#setupPanHandler();
    } else {
      this.scroller.classList.remove("hand-mode", "panning");
      this.#teardownPanHandler();
    }

    return this.handMode;
  }

  #setupPanHandler() {
    this._onPanStart = (e) => {
      // Only handle left mouse button
      if (e.button !== 0) return;

      // Ignore clicks on interactive elements
      if (
        e.target.closest(
          "a, button, .pane-controls, .annotation-toolbar-container",
        )
      )
        return;

      e.preventDefault();
      this.isPanning = true;
      this.scroller.classList.add("panning");

      this.panStart = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: this.scroller.scrollLeft,
        scrollTop: this.scroller.scrollTop,
      };
    };

    this._onPanMove = (e) => {
      if (!this.isPanning) return;

      const deltaX = e.clientX - this.panStart.x;
      const deltaY = e.clientY - this.panStart.y;

      this.scroller.scrollLeft = this.panStart.scrollLeft - deltaX;
      this.scroller.scrollTop = this.panStart.scrollTop - deltaY;
    };

    this._onPanEnd = () => {
      if (!this.isPanning) return;
      this.isPanning = false;
      this.scroller.classList.remove("panning");
    };

    this.scroller.addEventListener("mousedown", this._onPanStart);
    document.addEventListener("mousemove", this._onPanMove);
    document.addEventListener("mouseup", this._onPanEnd);
  }

  #teardownPanHandler() {
    if (this._onPanStart) {
      this.scroller.removeEventListener("mousedown", this._onPanStart);
      document.removeEventListener("mousemove", this._onPanMove);
      document.removeEventListener("mouseup", this._onPanEnd);
      this._onPanStart = null;
      this._onPanMove = null;
      this._onPanEnd = null;
    }
  }

  destroy() {
    this.document.unsubscribe(this);
    if (this.observer) {
      for (const page of this.pages) {
        this.observer.unobserve(page.wrapper);
      }
      this.observer?.disconnect();
      this.observer = null;
    }
    this.controls.destroy();
    this.textSelectionManager.destroy();
    this.annotationManager?.destroy();

    // Clean up spread layout
    this.#clearSpreadLayout();

    for (const page of this.pages) {
      page.release();
    }
  }
}
