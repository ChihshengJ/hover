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

    // Calculate render scale to fit canvas
    const scaleX = canvasWidth / pageWidth;
    const scaleY = canvasHeight / pageHeight;
    const renderScale = Math.min(scaleX, scaleY);

    try {
      // Load text slices and annotations in parallel if not cached
      if (!this.annotations) {
        this.annotations = await native
          .getPageAnnotations(pdfDoc, page)
          .toPromise();
      }
      if (!this.textSlices) {
        if (this.doc.lowLevelHandle) {
          try {
            this.textSlices = this.doc.extractPageText(page.index)?.textSlices;
          } catch (err) {
            console.warn(
              `[PageRender] Low-level extraction failed for page ${page.index}, falling back:`,
              err.message,
            );
            this.textSlices = null;
          }
        }
        if (!this.textSlices) {
          this.textSlices = await native
            .getPageTextRects(pdfDoc, page)
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

      // Draw to canvas
      const ctx = this.canvas.getContext("2d", { alpha: false });
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      // Center the rendered image if it doesn't fill the canvas exactly
      const offsetX = Math.floor((canvasWidth - imageData.width) / 2);
      const offsetY = Math.floor((canvasHeight - imageData.height) / 2);

      ctx.putImageData(imageData, offsetX, offsetY);

      // Get CSS dimensions for text layer
      const cssWidth = parseFloat(this.canvas.style.width);
      const cssHeight = parseFloat(this.canvas.style.height);

      // Calculate text layer scale
      const textScale = cssWidth / pageWidth;

      // Clear and rebuild text layer
      if (this.pane.textSelectionManager) {
        this.pane.textSelectionManager.unregister(this.textLayer);
      }

      this.textLayer.innerHTML = "";

      // Render annotations first (below text)
      this.#renderAnnotations(page, textScale, cssWidth, cssHeight);

      // Render text layer
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
   * Key insight: font.size from PDFium is in PDF user space units (points).
   * However, the rect represents the actual bounding box of the rendered text.
   * Using rect.size.height * scale gives us the correct visual height in CSS pixels.
   *
   * @param {import('@embedpdf/engines').PdfPageObject} page
   * @param {number} scale - CSS pixels per PDF unit
   * @param {number} cssWidth
   * @param {number} cssHeight
   */
  #renderTextLayer(page, scale, cssWidth, cssHeight) {
    if (!this.textSlices || this.textSlices.length === 0) return;

    const pageHeight = page.size.height;

    for (const slice of this.textSlices) {
      const content = slice.content || "";

      // Skip empty or invalid content
      if (!content || !this.#isValidTextContent(content)) {
        continue;
      }

      const span = document.createElement("span");
      span.textContent = content;

      // Get rect info (already in page coordinates, origin at top-left from getPageTextRects)
      const rectX = slice.rect.origin.x;
      const rectY = slice.rect.origin.y;
      const rectWidth = slice.rect.size.width;
      const rectHeight = slice.rect.size.height;

      // Convert to CSS coordinates
      const x = rectX * scale;
      const y = rectY * scale;

      // Calculate visual dimensions in CSS pixels
      const visualWidth = rectWidth * scale;
      const visualHeight = rectHeight * scale;

      let fontSize = visualHeight * 0.9;

      // Sanity check: skip if dimensions are unreasonable
      // (catches figure text with wrong transformation matrices)
      if (
        fontSize > 50 ||
        fontSize < 3 ||
        visualWidth <= 0 ||
        visualHeight <= 0
      ) {
        continue;
      }

      const fontFamily =
        slice.font?.family || slice.font?.famliy || "sans-serif";
      const cleanFontFamily =
        fontFamily.replace(/['"]/g, "").trim() || "sans-serif";

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

      // Add to DOM first so we can measure
      this.textLayer.appendChild(span);

      // Calculate horizontal scaling to fit text in its box
      // This compensates for font metric differences between PDF fonts and system fonts
      const measuredWidth = span.offsetWidth;
      if (measuredWidth > 0 && visualWidth > 0) {
        const scaleX = visualWidth / measuredWidth;
        // Only apply if within reasonable range (0.5x to 2x)
        if (scaleX >= 0.5 && scaleX <= 2.0) {
          span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
        } else if (scaleX > 0.1 && scaleX < 0.5) {
          // Text might be condensed - still apply but log
          span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
        } else if (scaleX > 2.0 && scaleX < 5.0) {
          // Text might be expanded - still apply
          span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
        }
        // If scaleX is very extreme (< 0.1 or > 5), the text might be garbage
      }
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

    for (const annot of this.annotations) {
      // Only render Link annotations in the annotation layer
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

      // Handle different link types
      if (annot.target.type === "action" && annot.target.action?.uri) {
        // External URL
        anchor.href = annot.target.action.uri;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (annot.target.type === "destination") {
        const dest = annot.target.destination;
        // Internal destination
        anchor.href = typeof dest === "string" ? dest : "#";
        anchor.dataset.dest = "";

        if (dest && typeof dest === "object") {
          anchor.dataset.destPageIndex = dest.pageIndex?.toString() || "";
          // dest.view contains [left, top, zoom] or similar
          if (Array.isArray(dest.view)) {
            anchor.dataset.destLeft = dest.view[0]?.toString() || "0";
            anchor.dataset.destTop = dest.view[1]?.toString() || "0";
          }
        }
      } else {
        continue;
      }

      this.annotationLayer.appendChild(anchor);
    }
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
    this.textSlices = null;
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

    this.annotationLayer.addEventListener(
      "mouseenter",
      (e) => {
        const anchor = e.target.closest("a[data-dest]");
        if (anchor) this.#handleAnchorEnter(anchor, citationPopup);
      },
      true,
    );

    this.annotationLayer.addEventListener(
      "mouseleave",
      (e) => {
        const anchor = e.target.closest("a[data-dest]");
        if (anchor) this.#handleAnchorLeave(anchor, citationPopup);
      },
      true,
    );

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

  async #resolveDestToPosition(anchor, dest) {
    if (anchor.dataset.destPageIndex) {
      const pageIndex = parseInt(anchor.dataset.destPageIndex, 10);
      if (!isNaN(pageIndex)) {
        return {
          pageIndex,
          left: parseFloat(anchor.dataset.destLeft) || 0,
          top: parseFloat(anchor.dataset.destTop) || 0,
        };
      }
    }

    const resolved = this.doc.resolveDestination(dest);
    if (resolved) {
      return resolved;
    }

    return null;
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
      const textSlices = await native
        .getPageTextRects(pdfDoc, page)
        .toPromise();
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
