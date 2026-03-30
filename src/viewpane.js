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

    // Page rotation (0, 90, 180, 270) — CSS-based, per-pane
    this.rotation = 0;

    this.textSelectionManager = new TextSelectionManager(this);
    this.annotationManager = null;

    this._scrollBack = { scrollTop: 0, page: 0, timer: null, el: null };

    this.onAnnotationHover = null;
    this.onAnnotationClick = null;
    this.editAnnotationComment = null;
    this.deleteAnnotationComment = null;
    this.selectAnnotation = null;

    this.document.subscribe(this);
  }

  async initialize(scale = 1.7) {
    this.scale = scale;
    this.#createScroller();
    this.#createStage();
    this.canvases = await this.#createCanvasPlaceholders();
    this.pages = this.canvases.map((canvas, idx) => {
      const pageView = new PageView(this, idx + 1, canvas);
      this.pageMap.set(pageView.wrapper, pageView);
      return pageView;
    });
    this.resizeAllCanvases(this.scale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.setupLazyRender();
    this.#setupGlobalClickToSelect();
    this.controls.bindScrollEvents();
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
        rootMargin: "400px 0px",
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

    this.scroller.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".textLayer span")) return;

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

      const selection = document.getSelection();
      const range = document.createRange();
      range.setStart(anchorNode, anchorOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      anchor.span.closest(".textLayer")?.classList.add("selecting");
      anchor.span.closest(".page-wrapper")?.classList.add("text-selecting");
    });

    document.addEventListener("pointermove", (e) => {
      if (!isSelecting) return;
      e.preventDefault();
      updateSelection(e.clientX, e.clientY);
    });

    document.addEventListener("pointerup", (e) => {
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
    const prevScale = this._pendingScale ?? this.scale;
    if (scale === prevScale) return;

    this._pendingScale = scale;
    const ratio = scale / this.scale;

    this.stage.style.transformOrigin = `${scroller.scrollLeft + focusX}px ${scroller.scrollTop + focusY}px`;
    this.stage.style.transform = `scale(${ratio})`;

    if (this._zoomRAF) cancelAnimationFrame(this._zoomRAF);
    this._zoomRAF = requestAnimationFrame(() => {
      this._zoomRAF = null;
      const finalScale = this._pendingScale;
      this._pendingScale = null;

      this.stage.style.transform = "";
      this.stage.style.transformOrigin = "";

      const docX = (scroller.scrollLeft + focusX) / this.scale;
      const docY = (scroller.scrollTop + focusY) / this.scale;

      this.scale = finalScale;
      this.resizeAllCanvases(finalScale);

      const targetLeft = docX * finalScale - focusX;
      const targetTop = docY * finalScale - focusY;
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollLeft = Math.min(Math.max(0, targetLeft), maxLeft);
      scroller.scrollTop = Math.min(Math.max(0, targetTop), maxTop);

      this.#renderVisiblePages();
      this.annotationManager?.refresh();
    });
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

  async scrollToPoint(pageIndex, left, top, center = false) {
    const page = this.document.getPage(pageIndex + 1);
    if (!page) return;

    const originScrollTop = this.scroller.scrollTop;
    const originPage = this.getCurrentPage();

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
      behavior: "instant",
    });

    const landedPage = this.getCurrentPage();
    if (landedPage !== originPage) {
      this.#showScrollBackButton(originScrollTop, originPage);
    }
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

  // ==================
  // Scroll-back button
  // ==================

  #showScrollBackButton(scrollTop, page) {
    this.#dismissScrollBackButton(true);

    this._scrollBack.scrollTop = scrollTop;
    this._scrollBack.page = page;

    const btn = document.createElement("button");
    btn.className = "scroll-back-btn";
    btn.title = `Back to page ${page}`;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M11 7H3M3 7L6.5 3.5M3 7L6.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span> Back to page ${page}</span>
    `;

    btn.addEventListener("click", () => {
      this.scroller.scrollTo({
        top: this._scrollBack.scrollTop,
        behavior: "instant",
      });
      this.#dismissScrollBackButton();
    });

    this.paneEl.appendChild(btn);
    this._scrollBack.el = btn;

    requestAnimationFrame(() => btn.classList.add("visible"));

    this._scrollBack.timer = setTimeout(() => {
      this.#dismissScrollBackButton();
    }, 5000);
  }

  #dismissScrollBackButton(immediate = false) {
    const { el, timer } = this._scrollBack;
    if (timer) {
      clearTimeout(timer);
      this._scrollBack.timer = null;
    }
    if (!el) return;

    if (immediate) {
      el.remove();
      this._scrollBack.el = null;
      return;
    }

    el.classList.add("fading");
    el.addEventListener(
      "transitionend",
      () => {
        el.remove();
        if (this._scrollBack.el === el) this._scrollBack.el = null;
      },
      { once: true },
    );
  }

  async resizeAllCanvases(scale) {
    const outputScale = window.devicePixelRatio || 1;
    const MAX_RENDER_SCALE = 7.0;
    const effectiveScale = Math.min(scale, MAX_RENDER_SCALE);
    const isSwapped = this.rotation === 90 || this.rotation === 270;

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const dims = this.document.pageDimensions[i];

      if (this.visiblePages.has(page)) {
        page.canvas.dataset.rendered = "false";
      } else {
        page.release();
      }

      // Original (unrotated) visual dimensions
      const origWidth = Math.round(dims.width * effectiveScale);
      const aspectRatio = dims.height / dims.width;
      const origHeight = Math.round(origWidth * aspectRatio);

      const canvasWidth = origWidth * outputScale;
      const canvasHeight = origHeight * outputScale;

      page.canvas.width = canvasWidth;
      page.canvas.height = canvasHeight;

      Object.assign(page.canvas.style, {
        width: `${origWidth}px`,
        height: `${origHeight}px`,
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

  async refreshAllPages() {
    await this.resizeAllCanvases(this.scale);
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
      this.fit(1, 1);
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
    if (event === "index-ready") {
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

    this.resizeAllCanvases(this.scale);
    this.#renderVisiblePages();
    this.annotationManager?.refresh();
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

    this.scroller.addEventListener("pointerdown", this._onPanStart);
    document.addEventListener("pointermove", this._onPanMove);
    document.addEventListener("pointerup", this._onPanEnd);
  }

  #teardownPanHandler() {
    if (this._onPanStart) {
      this.scroller.removeEventListener("pointerdown", this._onPanStart);
      document.removeEventListener("pointermove", this._onPanMove);
      document.removeEventListener("pointerup", this._onPanEnd);
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
    this.#dismissScrollBackButton(true);

    // Clean up spread layout
    this.#clearSpreadLayout();

    for (const page of this.pages) {
      page.release();
    }
  }
}
