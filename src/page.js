import { pdfjsLib } from "./pdfjs-init.js";
import { CitationPopup } from "./controls/citation_popup.js";

/**
 * @typedef {import('./controls/citation_popup.js').CitationPopup} CitationPopup;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
 */

// Cache Safari detection - only need to check once
let isSafariBrowser = null;
function isSafari() {
  if (isSafariBrowser === null) {
    isSafariBrowser = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }
  return isSafariBrowser;
}

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

    // Don't create endOfContent until first render
    this.endOfContent = null;

    this.page = null;
    this.textContent = null;
    this.annotations = null;
    this.renderTask = null;
    this.scale = 1;

    this._showTimer = null;
    this._delegatedListenersAttached = false;
  }

  async #ensurePageLoaded() {
    if (!this.page) this.page = await this.pdfDoc.getPage(this.pageNumber);
    return this.page;
  }

  #ensureEndOfContent() {
    if (this.endOfContent && this.textLayer.contains(this.endOfContent)) {
      return this.endOfContent;
    }
    const endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    this.textLayer.appendChild(endOfContent);
    if (this.pane.textSelectionManager) {
      this.pane.textSelectionManager.register(
        this,
        this.textLayer,
        endOfContent,
      );
    }
    this.endOfContent = endOfContent;
    return endOfContent;
  }

  async render(requestedScale) {
    this.cancel();
    this.scale = requestedScale || this.pendingRenderScale;
    const page = await this.#ensurePageLoaded();

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    const baseViewport = page.getViewport({ scale: 1 });
    const scaleX = canvasWidth / baseViewport.width;
    const scaleY = canvasHeight / baseViewport.height;

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
      // Disable native annotation rendering for customized rendering
      annotationMode: pdfjsLib.AnnotationMode?.DISABLE ?? 0,
    };

    this.renderTask = page.render(renderContext);

    try {
      await this.renderTask.promise;

      const cssWidth = parseFloat(this.canvas.style.width);
      const cssHeight = parseFloat(this.canvas.style.height);
      const textViewport = page.getViewport({
        scale: cssWidth / baseViewport.width,
      });

      if (this.pane.textSelectionManager) {
        this.pane.textSelectionManager.unregister(this.textLayer);
      }

      this.textLayer.innerHTML = "";
      this.#renderAnnotations(page, textViewport);
      this.textLayer.style.setProperty("--total-scale-factor", `${this.scale}`);

      const textLayerInstance = new pdfjsLib.TextLayer({
        textContentSource: this.textContent,
        container: this.textLayer,
        viewport: textViewport,
      });
      await textLayerInstance.render();

      if (isSafari()) {
        this.#fixSafariTextLayer(textViewport);
      }

      this.#ensureEndOfContent();

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
    this.canvas.dataset.rendered = "true";
  }

  #fixSafariTextLayer(viewport) {
    const spans = this.textLayer.querySelectorAll("span");
    const items = this.textContent.items;
    // const cssWidth = parseFloat(this.canvas.style.width);
    // const baseViewport = this.page.getViewport({ scale: 1 });
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

        span.style.setProperty(
          "--font-height",
          `${calculatedHeight.toFixed(2)}px`,
        );
        span.style.setProperty(
          "font-size",
          `calc(var(--total-scale-factor) * var(--font-height))`,
        );
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
    if (this.pane.textSelectionManager) {
      this.pane.textSelectionManager.unregister(this.textLayer);
    }
    this.textLayer.innerHTML = "";
    this.annotationLayer.innerHTML = "";
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.page) {
      this.page.cleanup();
      this.page = null;
    }
    this.textContent = null;
    this.annotations = null;
    this.endOfContent = null;
    this.canvas.dataset.rendered = "false";
    if (this._showTimer) {
      clearTimeout(this._showTimer);
      this._showTimer = null;
    }
  }

  async resize(scale) {
    this.scale = scale;
    this.pendingRenderScale = scale;
  }

  async renderIfNeed() {
    if (this.canvas.dataset.rendered === "true") return;
    await this.render();
  }

  #setupAnnotationLayerEvents() {
    if (this._delegatedListenersAttached) return;
    
    const citationPopup = getSharedPopup();
    
    // Use capture phase (true) for mouseenter/mouseleave to work with delegation
    this.annotationLayer.addEventListener("mouseenter", (e) => {
      const anchor = e.target.closest("a[data-dest]");
      if (anchor) this.#handleAnchorEnter(anchor, citationPopup);
    }, true);
    
    this.annotationLayer.addEventListener("mouseleave", (e) => {
      const anchor = e.target.closest("a[data-dest]");
      if (anchor) this.#handleAnchorLeave(anchor, citationPopup);
    }, true);
    
    this.annotationLayer.addEventListener("click", (e) => {
      const anchor = e.target.closest("a[data-dest]");
      if (anchor && anchor.dataset.dest !== undefined) {
        e.preventDefault();
        this.#handleAnchorClick(anchor);
      }
    });
    
    this._delegatedListenersAttached = true;
  }

  async #handleAnchorEnter(anchor, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;
    
    if (this._showTimer) clearTimeout(this._showTimer);
    citationPopup.onAnchorEnter();
    
    const dest = anchor.getAttribute("href");
    if (!dest || dest.startsWith("http")) return; // External link
    
    this._showTimer = setTimeout(async () => {
      const result = await this.#resolveDestToPosition(dest);
      if (!result) return;
      
      anchor.dataset.dest = `${result.left},${result.pageIndex},${result.top}`;
      
      if (dest.split(".")[0] === "cite") {
        await citationPopup.show(
          anchor,
          this.#findCiteText.bind(this),
          result.left,
          result.pageIndex,
          result.top,
        );
      }
    }, 200);
  }

  #handleAnchorLeave(anchor, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;
    
    if (this._showTimer) {
      clearTimeout(this._showTimer);
      this._showTimer = null;
    }
    
    if (citationPopup.currentAnchor === anchor) {
      citationPopup.onAnchorLeave();
    }
  }

  async #handleAnchorClick(anchor) {
    const destStr = anchor.dataset.dest;
    if (!destStr) return;
    
    const [left, page, top] = destStr.split(",").map(parseFloat);
    const pageIndex = Math.floor(page);
    await this.pane.scrollToPoint(pageIndex, left, top);
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
    const [targetX, targetY] = viewport.convertToViewportPoint(left, top);
    const targetLeft = targetX + 10;
    const targetTop = canvas.offsetTop + Math.max(0, viewport.height - targetY);
    const getPosition = (span) => {
      const pos = pdfjsLib.Util.transform(viewport.transform, span.transform);
      return { left: pos[4], top: pos[5] };
    };

    let startIndex = -1;
    // 500 is only an estimate for the largest scale of the system
    let minDistance = 500;

    try {
      // Find the closest span to the target position
      for (let i = 0; i < texts.items.length; i++) {
        const geom = texts.items[i];
        const tx = pdfjsLib.Util.transform(transform, geom.transform);
        const angle = Math.atan2(tx[1], tx[0]);
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

        const [x, y] = viewport.convertToViewportPoint(l, t);
        const spanLeft = x;
        const spanTop = canvas.offsetTop + Math.max(0, y);

        const dist = Math.max(
          Math.abs(spanLeft - targetLeft),
          Math.abs(spanTop - targetTop),
        );

        if (dist <= minDistance) {
          startIndex = i;
          minDistance = dist;
        }
      }

      if (startIndex === -1) {
        throw new Error("Failed to locate the coordinates of the reference.");
      }

      // Collect reference text with smart boundary detection
      const items = texts.items;
      const reference = [];

      // Reference number patterns: [1], (1), 1., 1), [12], etc.
      // at start of text, with leading whitespace
      const refNumberPattern = /^\s*[\[\(]?\d{1,3}[\]\)\.\,]?\s+\S/;

      // Track line structure for boundary detection
      const firstPos = getPosition(items[startIndex]);
      let currentLineTop = firstPos.top;
      let firstLineLeft = firstPos.left;
      let baselineLineHeight = null;
      let continuationLineLeft = null;
      let lineCount = 0;

      for (let i = startIndex; i < items.length; i++) {
        const span = items[i];
        const pos = getPosition(span);
        const text = span.str;

        // Check line break via vertical movement
        const verticalGap = Math.abs(pos.top - currentLineTop);
        const isNewLine = verticalGap > 3;

        if (isNewLine) {
          lineCount++;
          if (baselineLineHeight === null) {
            baselineLineHeight = verticalGap;
          }
          // Check large vertical gap indicates new block/paragraph
          if (baselineLineHeight && verticalGap > baselineLineHeight * 1.8) {
            break;
          }
          // Check reference number at start of new line
          let lineStartText = text;
          if (i + 1 < items.length) {
            const nextPos = getPosition(items[i + 1]);
            // If next span is on same line, include it for pattern matching
            if (Math.abs(nextPos.top - pos.top) < 3) {
              lineStartText = text + items[i + 1].str;
            }
          }
          if (refNumberPattern.test(lineStartText)) {
            break;
          }
          // Check indentation
          if (lineCount === 1) {
            continuationLineLeft = pos.left;
          } else if (continuationLineLeft !== null) {
            const hasHangingIndent = continuationLineLeft > firstLineLeft + 6;
            if (hasHangingIndent) {
              if (pos.left < continuationLineLeft - 10) {
                break;
              }
            } else {
              const minLeft = Math.min(firstLineLeft, continuationLineLeft);
              if (pos.left < minLeft - 10) {
                break;
              }
            }
          }
          currentLineTop = pos.top;
        }
        reference.push(text);
        // Check standalone period often ends a reference
        if (text.trim() === ".") {
          break;
        }
      }

      return reference.join("");
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
    
    this.#setupAnnotationLayerEvents();

    for (const a of this.annotations) {
      if (a.subtype !== "Link") continue;

      const rect = pdfjsLib.Util.normalizeRect(a.rect);
      const viewportForRects = page.getViewport({
        scale: this.scale,
        dontFlip: true,
      });
      const [x1, y1, x2, y2] = viewportForRects.convertToViewportRectangle(rect);
      const left = Math.min(x1, x2);
      const bottom = Math.min(y1, y2);
      const width = Math.abs(x1 - x2);
      const height = Math.abs(y1 - y2);
      const top = viewport.height - bottom - height;

      const anchor = document.createElement("a");
      anchor.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        width: ${width}px;
        height: ${height}px;
        pointer-events: auto;
        background-color: transparent;
      `;

      if (a.url) {
        anchor.href = a.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (a.dest) {
        anchor.href = a.dest;
        anchor.dataset.dest = "";
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
