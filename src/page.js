/**
 * PageView - Refactored for @embedpdf/engines (PDFium)
 *
 * Handles rendering of individual PDF pages using PDFium's native rendering.
 */

import { CitationPopup } from "./controls/citation_popup.js";

/**
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane
 */

let sharedPopup = null;
function getSharedPopup() {
  if (!sharedPopup) {
    sharedPopup = new CitationPopup();
  }
  return sharedPopup;
}

export class PageView {
  /**
   * @param {ViewerPane} pane
   * @param {number} pageNumber
   * @param {HTMLCanvasElement} canvas
   */
  constructor(pane, pageNumber, canvas) {
    this.pane = pane;
    this.doc = this.pane.document;
    this.pageNumber = pageNumber;

    this.canvas = canvas;
    this.wrapper = canvas.parentElement;
    this.textLayer = this.#initLayer("text");
    this.annotationLayer = this.#initLayer("annotation");

    this.endOfContent = null;
    this.page = null;
    this.textSlices = null;
    this.annotations = null;
    this.renderTask = null;
    this.scale = 1;

    this._showTimer = null;
    this._delegatedListenersAttached = false;
  }

  /**
   * Get the page object from the document
   * @returns {import('@embedpdf/engines').PdfPageObject|null}
   */
  #getPage() {
    if (!this.page) {
      this.page = this.doc.getPage(this.pageNumber);
    }
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
    this.scale = requestedScale || this.pendingRenderScale || 1;

    const page = this.#getPage();
    if (!page) {
      console.error(`[PageView] Page ${this.pageNumber} not found`);
      return;
    }

    const { native, pdfDoc } = this.doc;
    if (!native || !pdfDoc) {
      console.error(`[PageView] Engine not initialized`);
      return;
    }

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    const pageWidth = page.size.width;
    const pageHeight = page.size.height;

    const scaleX = canvasWidth / pageWidth;
    const scaleY = canvasHeight / pageHeight;
    const renderScale = Math.min(scaleX, scaleY);

    try {
      if (!this.textSlices) {
        this.textSlices = this.doc.textIndex?.getRawSlices(this.pageNumber);

        if (!this.textSlices) {
          if (this.doc.lowLevelHandle) {
            try {
              this.textSlices = this.doc.extractPageText(
                page.index,
              )?.textSlices;
            } catch (err) {
              console.warn(
                `[PageRender] Low-level extraction failed for page ${page.index}:`,
                err.message,
              );
            }
          }
          if (!this.textSlices) {
            this.textSlices = await native
              .getPageTextRects(pdfDoc, page)
              .toPromise();
          }
        }
      }

      if (!this.annotations) {
        this.annotations = this.doc.getNativeAnnotations(this.pageNumber);
        if (!this.annotations || this.annotations.length === 0) {
          this.annotations = await native
            .getPageAnnotations(pdfDoc, page)
            .toPromise();
        }
      }

      const pageData = await native
        .renderPageRaw(pdfDoc, page, {
          scaleFactor: renderScale,
          withAnnotations: false,
        })
        .toPromise();

      const imageData = new ImageData(
        pageData.data,
        pageData.width,
        pageData.height,
      );

      const ctx = this.canvas.getContext("2d", { alpha: false });
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      const offsetX = Math.floor((canvasWidth - imageData.width) / 2);
      const offsetY = Math.floor((canvasHeight - imageData.height) / 2);

      ctx.putImageData(imageData, offsetX, offsetY);

      const cssWidth = parseFloat(this.canvas.style.width);
      const cssHeight = parseFloat(this.canvas.style.height);
      const textScale = cssWidth / pageWidth;

      if (this.pane.textSelectionManager) {
        this.pane.textSelectionManager.unregister(this.textLayer);
      }

      this.textLayer.innerHTML = "";
      this.#renderAnnotations(page, textScale, cssWidth, cssHeight);
      this.#renderCitationAnchors(page, textScale);
      this.#renderTextLayer(page, textScale, cssWidth, cssHeight);
      this.textLayer.style.setProperty("--total-scale-factor", `${this.scale}`);
      this.#ensureEndOfContent();
      this.textLayer.style.width = `${cssWidth}px`;
      this.textLayer.style.height = `${cssHeight}px`;
      this.canvas.dataset.rendered = "true";
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.error(
          `[PageView] Render error on page ${this.pageNumber}:`,
          err,
        );
      }
    } finally {
      this.renderTask = null;
    }
  }

  /**
   * Check if text content appears to be valid/meaningful
   * @param {string} text - Text to check
   * @returns {boolean}
   */
  #isValidTextContent(text) {
    if (!text || text.length === 0) return false;

    // Check if text is just whitespace
    if (/^\s*$/.test(text)) return false;

    return true;
  }

  /**
   * Render text layer from PDFium text rects
   *
   * @param {import('@embedpdf/engines').PdfPageObject} page
   * @param {number} scale - CSS pixels per PDF unit
   * @param {number} cssWidth
   * @param {number} cssHeight
   */
  #renderTextLayer(page, scale, cssWidth, cssHeight) {
    if (!this.textSlices || this.textSlices.length === 0) return;

    const pageHeight = page.size.height;
    const fragment = document.createDocumentFragment();
    const spansToMeasure = [];

    for (const slice of this.textSlices) {
      const content = slice.content || "";

      // Skip empty or invalid content
      if (!content || !this.#isValidTextContent(content)) {
        continue;
      }

      const rectX = slice.rect.origin.x;
      const rectY = slice.rect.origin.y;
      const rectWidth = slice.rect.size.width;
      const rectHeight = slice.rect.size.height;

      const x = rectX * scale;
      const y = rectY * scale;
      const visualWidth = rectWidth * scale;
      const visualHeight = rectHeight * scale;
      let fontSize = visualHeight * 0.9;

      // Sanity check: skip if dimensions are unreasonable
      // (catches figure text with wrong transformation matrices)
      if (
        fontSize > 50 ||
        fontSize < 3 ||
        rectHeight > 30 ||
        visualWidth <= 0 ||
        visualHeight <= 0
      ) {
        continue;
      }

      const fontFamily =
        slice.font?.family || slice.font?.famliy || "sans-serif";
      const cleanFontFamily =
        fontFamily.replace(/['"]/g, "").trim() || "sans-serif";

      const span = document.createElement("span");
      span.textContent = content;
      span.style.cssText = `
        position: absolute;
        left: ${x.toFixed(2)}px;
        top: ${y.toFixed(2)}px;
        font-size: ${fontSize.toFixed(2)}px;
        font-family: "${cleanFontFamily}", sans-serif;
        line-height: 1;
        transform-origin: 0% 0%;
        white-space: pre;
        pointer-events: all;
        color: transparent;
      `;

      span._visualWidth = visualWidth;
      fragment.appendChild(span);
      spansToMeasure.push(span);
    }

    this.textLayer.appendChild(fragment);
    const measurements = [];
    for (const span of spansToMeasure) {
      measurements.push({
        span,
        measuredWidth: span.offsetWidth,
        visualWidth: span._visualWidth,
      });
    }

    for (const { span, measuredWidth, visualWidth } of measurements) {
      if (measuredWidth > 0 && visualWidth > 0) {
        const scaleX = visualWidth / measuredWidth;
        if (scaleX >= 0.1 && scaleX <= 5.0) {
          span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
        }
      }
      delete span._visualWidth;
    }
  }

  /**
   * Render annotation layer (links)
   * @param {import('@embedpdf/engines').PdfPageObject} page
   * @param {number} scale
   * @param {number} cssWidth
   * @param {number} cssHeight
   */
  #renderAnnotations(page, scale, cssWidth, cssHeight) {
    this.annotationLayer.innerHTML = "";
    this.#setupAnnotationLayerEvents();

    if (!this.annotations || this.annotations.length === 0) return;

    const pageHeight = page.size.height;
    const fragment = document.createDocumentFragment();

    for (const annot of this.annotations) {
      if (!annot.target) continue;
      if (annot.target.type !== "destination" && annot.target.type !== "action")
        continue;

      const rect = annot.rect;
      if (!rect) continue;

      // Convert to CSS coordinates
      const left = rect.origin.x * scale;
      const top = rect.origin.y * scale;
      const width = rect.size.width * scale;
      const height = rect.size.height * scale;

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

      if (annot.target.type === "action" && annot.target.action?.uri) {
        anchor.href = annot.target.action.uri;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (annot.target.type === "destination") {
        const dest = annot.target.destination;
        anchor.href = typeof dest === "string" ? dest : "#";
        anchor.dataset.dest = "";

        if (dest && typeof dest === "object") {
          anchor.dataset.destPageIndex = dest.pageIndex?.toString() || "";
          if (Array.isArray(dest.view)) {
            anchor.dataset.destLeft = dest.view[0]?.toString() || "0";
            anchor.dataset.destTop = dest.view[1]?.toString() || "0";
          }
        }
      } else {
        continue;
      }

      fragment.appendChild(anchor);
    }

    // Single DOM append
    this.annotationLayer.appendChild(fragment);
  }

  #renderCitationAnchors(page, scale) {
    if (this.doc.isHyperrefed) return;

    const citations = this.doc.getCitationAnchorsForPage(this.pageNumber);
    if (!citations || citations.length === 0) return;

    const fragment = document.createDocumentFragment();

    for (const cite of citations) {
      if (!cite.rect || !cite.matchedRefs?.length) continue;

      const ref = cite.matchedRefs[0];
      const left = cite.rect.x * scale;
      const top = cite.rect.y * scale;
      const width = cite.rect.width * scale;
      const height = cite.rect.height * scale;

      const anchor = document.createElement("a");
      anchor.href = "#";
      anchor.dataset.citeRef = "";
      anchor.dataset.destPageIndex = (ref.pageNumber - 1).toString();
      anchor.dataset.destLeft = ref.startCoord.x.toString();
      anchor.dataset.destTop = ref.startCoord.y.toString();
      anchor.dataset.refText = ref.cachedText || "";
      anchor.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        width: ${width}px;
        height: ${height}px;
        pointer-events: auto;
        background-color: transparent;
      `;

      fragment.appendChild(anchor);
    }

    this.annotationLayer.appendChild(fragment);
  }

  cancel() {
    this.renderTask = null;
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

    this.page = null;
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

    this.annotationLayer.addEventListener(
      "mouseenter",
      (e) => {
        const citeAnchor = e.target.closest("a[data-cite-ref]");
        if (citeAnchor) {
          this.#handleCiteAnchorEnter(citeAnchor, citationPopup);
          return;
        }
        const anchor = e.target.closest("a[data-dest]");
        if (anchor) this.#handleAnchorEnter(anchor, citationPopup);
      },
      true,
    );

    this.annotationLayer.addEventListener(
      "mouseleave",
      (e) => {
        const citeAnchor = e.target.closest("a[data-cite-ref]");
        if (citeAnchor) {
          this.#handleCiteAnchorLeave(citeAnchor, citationPopup);
          return;
        }
        const anchor = e.target.closest("a[data-dest]");
        if (anchor) this.#handleAnchorLeave(anchor, citationPopup);
      },
      true,
    );

    this.annotationLayer.addEventListener("click", (e) => {
      const citeAnchor = e.target.closest("a[data-cite-ref]");
      if (citeAnchor) {
        e.preventDefault();
        this.#handleCiteAnchorClick(citeAnchor);
        return;
      }
      const anchor = e.target.closest("a[data-dest]");
      if (anchor && anchor.dataset.dest !== undefined) {
        e.preventDefault();
        this.#handleAnchorClick(anchor);
      }
    });

    this._delegatedListenersAttached = true;
  }

  #handleCiteAnchorEnter(anchor, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;
    if (this._showTimer) clearTimeout(this._showTimer);
    citationPopup.onAnchorEnter();

    const refText = anchor.dataset.refText;
    if (!refText) return;

    const pageIndex = parseInt(anchor.dataset.destPageIndex, 10);
    const left = parseFloat(anchor.dataset.destLeft) || 0;
    const top = parseFloat(anchor.dataset.destTop) || 0;

    this._showTimer = setTimeout(async () => {
      await citationPopup.show(
        anchor,
        () => Promise.resolve(refText),
        left,
        pageIndex,
        top,
      );
    }, 200);
  }

  #handleCiteAnchorLeave(anchor, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;
    if (this._showTimer) {
      clearTimeout(this._showTimer);
      this._showTimer = null;
    }
    if (citationPopup.currentAnchor === anchor) {
      citationPopup.onAnchorLeave();
    }
  }

  async #handleCiteAnchorClick(anchor) {
    const pageIndex = parseInt(anchor.dataset.destPageIndex, 10);
    const left = parseFloat(anchor.dataset.destLeft) || 0;
    const top = parseFloat(anchor.dataset.destTop) || 0;
    if (!isNaN(pageIndex)) {
      await this.pane.scrollToPoint(pageIndex, left, top);
    }
  }

  async #handleAnchorEnter(anchor, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;

    if (this._showTimer) clearTimeout(this._showTimer);
    citationPopup.onAnchorEnter();

    const dest = anchor.getAttribute("href");
    if (!dest || dest.startsWith("http")) return;

    const pageHeight = this.#getPage()?.size.height;

    if (anchor.dataset.destPageIndex) {
      this._showTimer = setTimeout(async () => {
        await citationPopup.show(
          anchor,
          this.#findCiteText.bind(this),
          parseFloat(anchor.dataset.destLeft) || 0,
          parseInt(anchor.dataset.destPageIndex, 10),
          pageHeight - parseFloat(anchor.dataset.destTop) || 0,
        );
      }, 200);
    }
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
    if (!destStr) {
      const pageIndex = parseInt(anchor.dataset.destPageIndex, 10);
      const left = parseFloat(anchor.dataset.destLeft) || 0;
      const top = parseFloat(anchor.dataset.destTop) || 0;

      if (!isNaN(pageIndex)) {
        await this.pane.scrollToPoint(pageIndex, left, top);
      }
      return;
    }

    const [left, page, top] = destStr.split(",").map(parseFloat);
    const pageIndex = Math.floor(page);
    await this.pane.scrollToPoint(pageIndex, left, top);
  }

  async #findCiteText(left, pageIndex, top) {
    const pageNumber = pageIndex + 1;
    console.log(
      `[PageView] Finding citation at page ${pageNumber}, (${left}, ${top})`,
    );

    if (this.doc.hasReferenceIndex()) {
      const bounds = this.doc.findBoundingReferenceAnchors(
        pageNumber,
        left,
        top,
      );
      console.log(`[PageView] Bounds:`, bounds.current?.id, bounds.next?.id);

      if (bounds.current?.cachedText) {
        console.log(`[PageView] Using indexed reference: ${bounds.current.id}`);
        return bounds.current.cachedText;
      }
    }

    console.log(`[PageView] Falling back to heuristic extraction`);
    return await this.#heuristicFindCiteText(left, pageIndex, top);
  }

  async #heuristicFindCiteText(left, pageIndex, top) {
    const { native, pdfDoc } = this.doc;
    if (!native || !pdfDoc) return null;

    const page = this.doc.getPage(pageIndex + 1);
    if (!page) return null;

    try {
      const textSlices = this.doc.pdfDoc.pages
        .map((p) => this.doc.textIndex?.getRawSlices(p.index + 1))
        .flat();
      if (!textSlices || textSlices.length === 0) return null;

      let startIndex = -1;
      let minDistance = Infinity;

      for (let i = 0; i < textSlices.length; i++) {
        const slice = textSlices[i];
        const dist = Math.hypot(
          slice.rect.origin.x - left,
          slice.rect.origin.y - top,
        );
        if (dist < minDistance) {
          startIndex = i;
          minDistance = dist;
        }
      }

      if (startIndex === -1) return null;

      const reference = [];
      const refNumberPattern = /^\s*[\[\(]?\d{1,3}[\]\)\.\,]?\s+\S/;

      const firstSlice = textSlices[startIndex];
      let currentLineY = firstSlice.rect.origin.y;
      let firstLineX = firstSlice.rect.origin.x;
      let baselineGap = null;
      let prevYDirection = null;
      let lineCount = 0;

      for (let i = startIndex; i < textSlices.length; i++) {
        const slice = textSlices[i];
        const text = slice.content || "";
        const sliceY = slice.rect.origin.y;
        const sliceX = slice.rect.origin.x;

        const yDelta = sliceY - currentLineY;
        const absYDelta = Math.abs(yDelta);
        const isNewLine = absYDelta > 3;

        if (isNewLine) {
          lineCount++;
          const yDirection = Math.sign(yDelta);

          if (baselineGap === null && absYDelta < 50) {
            baselineGap = absYDelta;
          }

          const isColumnBreak =
            prevYDirection !== null &&
            yDirection !== prevYDirection &&
            absYDelta > 20;
          if (isColumnBreak) {
            if (sliceX <= firstLineX + 5 && refNumberPattern.test(text)) break;
          } else {
            if (baselineGap && absYDelta > baselineGap * 1.8) break;
          }

          let lineStartText = text;
          if (i + 1 < textSlices.length) {
            const nextSlice = textSlices[i + 1];
            if (Math.abs(nextSlice.rect.origin.y - sliceY) < 3) {
              lineStartText = text + (nextSlice.content || "");
            }
          }

          if (refNumberPattern.test(lineStartText)) break;
          if (sliceX < firstLineX - 8 && lineCount > 1) break;

          currentLineY = sliceY;
          if (!isColumnBreak) prevYDirection = yDirection;
        }

        reference.push(text);
      }

      return reference.join("");
    } catch (err) {
      console.error("[PageView] Heuristic extraction failed:", err);
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
}
