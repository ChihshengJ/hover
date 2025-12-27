import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { PDFDocumentModel } from "./doc.js";
import { CitationPopup } from "./controls/citation_popup.js";

/**
 * @typedef {import('./controls/citation_popup.js').CitationPopup} CitationPopup;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

let sharedPopup = null;
function getSharedPopup() {
  if (!sharedPopup) {
    sharedPopup = new CitationPopup();
  }
  return sharedPopup;
}

export class PageView {
  /**
   * @param {ViewerPane} pane;
   * @param {number} pageNumber;
   * @param {HTMLElement} wrapper;
   */
  constructor(pane, pageNumber, canvas) {
    this.pane = pane;
    this.doc = this.pane.document;
    this.pdfDoc = this.doc.pdfDoc;
    this.allNamedDests = this.doc.allNamedDests;
    this.pageNumber = pageNumber;

    this.canvas = canvas;
    this.wrapper = canvas.parentElement;
    this.textLayer = this.#initLayer("text");
    this.annotationLayer = this.#initLayer("annotation");

    this.endOfContent = this.#createEndOfContent();

    this.page = null;
    this.textContent = null;
    this.annotations = null;
    this.renderTask = null;
    this.scale = 1;
  }

  async #ensurePageLoaded() {
    if (!this.page) this.page = await this.pdfDoc.getPage(this.pageNumber);
    return this.page;
  }

  #createEndOfContent() {
    const endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    this.textLayer.appendChild(endOfContent);
    if (this.pane.textSelectionManager) {
      this.pane.textSelectionManager.register(this, this.textLayer, endOfContent);
    }

    return endOfContent;
  }

  async render(requestedScale) {
    this.cancel();
    this.scale = requestedScale || this.pendingRenderScale;
    const page = await this.#ensurePageLoaded();

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // Create a viewport that EXACTLY matches our canvas dimensions
    const baseViewport = page.getViewport({ scale: 1 });
    const scaleX = canvasWidth / baseViewport.width;
    const scaleY = canvasHeight / baseViewport.height;

    // Use the smaller scale to ensure content fits, or use scaleX if they're very close
    const renderScale = Math.min(scaleX, scaleY);
    const viewport = page.getViewport({ scale: renderScale });

    if (!this.textContent) {
      [this.textContent, this.annotations] = await Promise.all([
        page.getTextContent(),
        page.getAnnotations({ intent: "display" }),
      ]);
    }

    const ctx = this.canvas.getContext("2d", { alpha: false });
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport,
    };

    this.renderTask = page.render(renderContext);

    try {
      await this.renderTask.promise;

      const cssWidth = parseFloat(this.canvas.style.width);
      const cssHeight = parseFloat(this.canvas.style.height);
      const textViewport = page.getViewport({
        scale: cssWidth / baseViewport.width,
      });

      this.textLayer.innerHTML = "";
      this.#renderAnnotations(page, textViewport);
      this.textLayer.style.setProperty("--total-scale-factor", `${this.scale}`);

      const textLayerInstance = new pdfjsLib.TextLayer({
        textContentSource: this.textContent,
        container: this.textLayer,
        viewport: textViewport,
      });
      await textLayerInstance.render();
      if (this.#isSafari()) {
        this.#fixSafariTextLayer(textViewport);
      }

      if (!this.textLayer.contains(this.endOfContent)) {
        this.textLayer.appendChild(this.endOfContent);
      }

      this.textLayer.style.width = `${cssWidth}px`;
      this.textLayer.style.height = `${cssHeight}px`;
      this.canvas.dataset.rendered = "true";

    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.error("Render error:", err);
      }
    } finally {
      this.renderTask = null;
    }
  }

  #isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }

  #fixSafariTextLayer(viewport) {
    const spans = this.textLayer.querySelectorAll("span");
    const items = this.textContent.items;
    console.log('=== VIEWPORT DEBUG ===');
    console.log('viewport passed to fixSafari:', viewport);
    console.log('viewport.scale:', viewport.scale);
    console.log('this.scale (PageView):', this.scale);
    
    // What was actually passed to TextLayer?
    const cssWidth = parseFloat(this.canvas.style.width);
    const cssHeight = parseFloat(this.canvas.style.height);
    console.log('canvas cssWidth:', cssWidth);
    console.log('canvas cssHeight:', cssHeight);
    
    // Get the base viewport to understand the ratio
    const baseViewport = this.page.getViewport({ scale: 1 });
    console.log('baseViewport.width:', baseViewport.width);
    console.log('baseViewport.height:', baseViewport.height);
    
    const textLayerScale = cssWidth / baseViewport.width;
    console.log('textLayerScale (cssWidth / baseViewport.width):', textLayerScale);
    console.log('textLayerScale * devicePixelRatio:', textLayerScale * (window.devicePixelRatio || 1));
    
    // Check a span's actual style after TextLayer render
    if (spans.length > 0) {
      const firstSpan = spans[0];
      console.log('=== FIRST SPAN STYLES ===');
      console.log('--scale-x:', firstSpan.style.getPropertyValue('--scale-x'));
      console.log('--font-height:', firstSpan.style.getPropertyValue('--font-height'));
      console.log('--rotate:', firstSpan.style.getPropertyValue('--rotate'));
      console.log('transform:', getComputedStyle(firstSpan).transform);
      console.log('left:', firstSpan.style.left);
      console.log('top:', firstSpan.style.top);
    }

    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    const transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];

    let itemIndex = 0;
    for (const span of spans) {
      if (!span.textContent) continue;
      while (itemIndex < items.length && items[itemIndex].str === "") {
        itemIndex++;
      }
      if (itemIndex < items.length) {
        const item = items[itemIndex];
        const tx = pdfjsLib.Util.transform(transform, item.transform);
        const calculatedHeight = Math.hypot(tx[2], tx[3]);

        span.style.setProperty("--font-height", `${calculatedHeight.toFixed(2)}px`);
        span.style.setProperty("font-size", `calc(var(--total-scale-factor) * var(--font-height))`);
      }
      itemIndex++;
    }
  }

  cancel() {
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
  }

  release() {
    this.cancel();
    this.textLayer.innerHTML = "";
    this.annotationLayer.innerHTML = "";

    if (this.pane.textSelectionManager) {
      this.pane.textSelectionManager.unregister(this.textLayer);
    }

    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.page) {
      this.page.cleanup();
      this.page = null;
    }
    this.textContent = null;
    this.annotations = null;
    this.canvas.dataset.rendered = "false";
    this.endOfContent = this.#createEndOfContent();
  }

  async resize(scale) {
    this.scale = scale;
    this.pendingRenderScale = scale;
  }

  async renderIfNeed() {
    if (this.canvas.dataset.rendered === "true") return;
    await this.render();
  }

  async #findCiteText(left, pageIndex, top) {
    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: this.scale, dontFlip: true });
    const texts = await page.getTextContent();
    const canvas = document.querySelector(
      `[data-page-number="${pageIndex + 1}"]`,
    );
    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    const transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];

    // Convert target PDF coordinates to viewport coordinates at current scale
    // 20 and 2 are heuristically determined...
    const [targetX, targetY] = viewport.convertToViewportPoint(
      left + 20,
      top + 2,
    );
    const targetLeft = targetX;
    const targetTop = canvas.offsetTop + Math.max(0, viewport.height - targetY);

    let closestSpan = null;
    let minDistance = 50;
    let startIndex = 0;

    try {
      for (let i = 0; i < texts.items.length; i++) {
        const geom = texts.items[i];
        const tx = pdfjsLib.Util.transform(transform, geom.transform);
        let angle = Math.atan2(tx[1], tx[0]);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const fontAscent = fontHeight * 0.8;
        let l, t;
        if (angle === 0) {
          l = tx[4];
          t = tx[5] - fontAscent;
        } else {
          l = tx[4] + fontAscent * Math.sin(angle);
          t = tx[5] - fontAscent * Math.cos(angle);
        }

        // Converting text span PDF coordinates to viewport coordinates
        const [x, y] = viewport.convertToViewportPoint(l, t);
        const spanLeft = x;
        const spanTop = canvas.offsetTop + Math.max(0, y);

        const isClose =
          Math.abs(spanLeft - targetLeft) <= minDistance &&
          Math.abs(spanTop - targetTop) <= minDistance;

        if (isClose) {
          closestSpan = {
            text: geom.str,
            left: spanLeft,
            top: spanTop,
            width: geom.width,
            height: geom.height,
            hasEOL: geom.hasEOL,
          };
          startIndex = i;
          minDistance = Math.max(
            Math.abs(spanLeft - targetLeft),
            Math.abs(spanTop - targetTop),
          );
        }
      }

      if (closestSpan) {
        let reference = [];
        for (let i = startIndex; i < texts.items.length; i++) {
          const span = texts.items[i];
          reference.push(span.str);
          if (
            span.str.match(/\d{4}\.$/) &&
            !texts.items[i + 1].str.match(/\s+$/)
          ) {
            break;
          }
          if (span.str === ".") {
            break;
          }
        }
        return reference.join("");
      }
      return null;
    } catch (err) {
      console.error("Failed to find closest span", err);
      return null;
    }
  }

  #initLayer(layerType) {
    this.wrapper.style.position = "relative";
    let layer = this.wrapper.querySelector(`.${layerType}Layer`);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = `${layerType}Layer`;
      layer.style.position = "absolute";
      layer.style.top = "0";
      layer.style.left = "0";
      this.wrapper.style.position = "relative";
      this.wrapper.appendChild(layer);
    }
    layer.innerHTML = "";
    return layer;
  }

  #renderAnnotations(page, viewport) {
    this.annotationLayer.innerHTML = "";
    const citationPopup = getSharedPopup();

    for (const a of this.annotations) {
      if (a.subtype != "Link") continue;

      const rect = pdfjsLib.Util.normalizeRect(a.rect);
      const viewportForRects = page.getViewport({
        scale: this.scale,
        dontFlip: true,
      });
      const [x1, y1, x2, y2] =
        viewportForRects.convertToViewportRectangle(rect);
      const left = Math.min(x1, x2);
      const bottom = Math.min(y1, y2);
      const width = Math.abs(x1 - x2);
      const height = Math.abs(y1 - y2);
      const top = viewport.height - bottom - height;

      const anchor = document.createElement("a");
      anchor.style.position = "absolute";
      anchor.style.left = `${left}px`;
      anchor.style.top = `${top}px`;
      anchor.style.width = `${width}px`;
      anchor.style.height = `${height}px`;
      anchor.style.pointerEvents = "auto";
      anchor.style.backgroundColor = "transparent";
      anchor.setAttribute("data-dest", "");

      if (a.url) {
        anchor.href = a.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (a.dest) {
        anchor.href = "javascript:void(0)";
        let showTimer = null;

        anchor.addEventListener("mouseenter", async (e) => {
          if (this.wrapper.classList.contains("text-selecting")) {
            return;
          }
          if (showTimer) clearTimeout(showTimer);

          citationPopup.onAnchorEnter();

          showTimer = setTimeout(async () => {
            const result = await this.#resolveDestToPosition(a.dest);
            if (!result) return;

            anchor.dataset.dest = `${result.left},${result.pageIndex},${result.top}`;
            await citationPopup.show(
              anchor,
              this.#findCiteText.bind(this),
              result.left,
              result.pageIndex,
              result.top,
            );
          }, 200);
        });

        anchor.addEventListener("mouseleave", (e) => {
          if (this.wrapper.classList.contains("text-selecting")) {
            return;
          }
          if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
          }

          if (citationPopup.currentAnchor === anchor) {
            citationPopup.onAnchorLeave();
          }
        });

        anchor.addEventListener("click", async (e) => {
          e.preventDefault();
          const [left, page, top] = anchor.dataset.dest
            .split(",")
            .map((item) => parseFloat(item));
          const pageIndex = Math.floor(page);
          const targetCanvas = document.querySelector(
            `[data-page-number="${pageIndex + 1}"]`,
          );
          await this.pane.scrollToPoint(pageIndex, left, top);
        });
      } else {
        continue;
      }

      this.annotationLayer.appendChild(anchor);
    }
  }

  async #resolveDestToPosition(dest) {
    const explicitDest = this.allNamedDests[dest];
    if (Array.isArray(explicitDest)) {
      const [ref, kind, left, top, zoom] = explicitDest;
      const pageIndex = await this.pdfDoc.getPageIndex(ref);

      return { pageIndex, left: left ?? 0, top: top ?? 0, zoom };
    }
    return null;
  }
}
