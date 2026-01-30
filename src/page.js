import { pdfjsLib } from "./pdfjs-init.js";
import { CitationPopup } from "./controls/citation_popup.js";

/**
 * @typedef {import('./controls/citation_popup.js').CitationPopup} CitationPopup;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
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
    if (!dest || dest.startsWith("http")) return; // External link

    this._showTimer = setTimeout(async () => {
      const result = await this.#resolveDestToPosition(dest);
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
    const pageNumber = pageIndex + 1;

    console.log(`try to find ${pageIndex + 1}, left ${left}, top ${top}`);

    // Step 1: Try reference index first (if available)
    if (this.doc.hasReferenceIndex()) {
      const bounds = this.doc.findBoundingReferenceAnchors(
        pageNumber,
        left,
        top,
      );
      console.log(bounds);

      // If we have a high-confidence match with cached text, use it directly
      if (bounds.current?.confidence > 0.85 && bounds.current.cachedText) {
        console.log(
          `[Citation] Using cached reference text (confidence: ${bounds.current.confidence.toFixed(2)})`,
        );
        return bounds.current.cachedText;
      }

      // Otherwise, use hybrid approach with guardrails
      const heuristicText = await this.#heuristicFindCiteText(
        left,
        pageIndex,
        top,
        bounds,
      );

      // Cross-validate if we have index data
      if (bounds.current?.cachedText && heuristicText) {
        const similarity = this.#textSimilarity(
          heuristicText,
          bounds.current.cachedText,
        );
        if (similarity < 0.7) {
          console.log(
            `[Citation] Heuristic diverged (similarity: ${similarity.toFixed(2)}), using index version`,
          );
          return bounds.current.cachedText;
        }
      }

      if (heuristicText) {
        return heuristicText;
      }

      // Fallback to cached text if heuristic failed
      if (bounds.current?.cachedText) {
        return bounds.current.cachedText;
      }
    }

    // Fallback to pure heuristic (no reference index available)
    return await this.#heuristicFindCiteText(left, pageIndex, top, null);
  }

  /**
   * Calculate text similarity (simple Jaccard-like comparison)
   * @param {string} text1
   * @param {string} text2
   * @returns {number} Similarity score 0-1
   */
  #textSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;

    const normalize = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const n1 = normalize(text1);
    const n2 = normalize(text2);

    if (n1 === n2) return 1;

    // Word-based Jaccard similarity
    const words1 = new Set(n1.split(" ").filter((w) => w.length > 2));
    const words2 = new Set(n2.split(" ").filter((w) => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const word of words1) {
      if (words2.has(word)) intersection++;
    }

    const union = words1.size + words2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Heuristic citation text extraction with optional guardrails
   * @param {number} left - X position in PDF coordinates
   * @param {number} pageIndex - 0-based page index
   * @param {number} top - Y position in PDF coordinates
   * @param {Object|null} bounds - Bounding anchors from reference index
   * @returns {Promise<string|null>}
   */
  async #heuristicFindCiteText(left, pageIndex, top, bounds) {
    const page = await this.pdfDoc.getPage(pageIndex + 1);

    // Use scale=1 viewport for PDF coordinate space (scale-independent)
    const baseViewport = page.getViewport({ scale: 1, dontFlip: true });
    const texts = await page.getTextContent();

    const { width: pageWidth, height: pageHeight } = baseViewport;
    const transform = [1, 0, 0, -1, 0, pageHeight];

    // Work entirely in PDF coordinates (scale=1)
    // Target coordinates are already in PDF space
    const targetX = left;
    const targetY = top;

    let startIndex = -1;
    let minDistance = pageWidth; // Use page width as max reasonable distance

    try {
      // Find the closest span to the target position (in PDF coordinates)
      for (let i = 0; i < texts.items.length; i++) {
        const geom = texts.items[i];
        const tx = pdfjsLib.Util.transform(transform, geom.transform);
        const angle = Math.atan2(tx[1], tx[0]);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const fontAscent = fontHeight * 0.8;

        let spanX, spanY;
        if (angle === 0) {
          spanX = tx[4];
          spanY = tx[5] - fontAscent;
        } else {
          spanX = tx[4] + fontAscent * Math.sin(angle);
          spanY = tx[5] - fontAscent * Math.cos(angle);
        }

        // Distance calculation in PDF coordinate space (scale-independent)
        const dist = Math.hypot(spanX - targetX, spanY - targetY);

        if (dist < minDistance) {
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
      const refNumberPattern = /^\s*[\[\(]?\d{1,3}[\]\)\.\,]?\s+\S/;

      // Get guardrails from reference index bounds
      const stopBeforeY = bounds?.next?.startCoord?.y;
      const formatHint = bounds?.current?.formatHint;

      // Helper to get span position in PDF coords
      const getSpanPosition = (span) => {
        const tx = pdfjsLib.Util.transform(transform, span.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        return {
          x: tx[4],
          y: tx[5] - fontHeight * 0.8,
          fontHeight,
        };
      };

      // Track line structure for boundary detection
      const firstPos = getSpanPosition(items[startIndex]);
      let currentLineY = firstPos.y;
      let firstLineX = firstPos.x;
      let baselineLineHeight = null;
      let currCiteX = null;
      let lineCount = 0;

      for (let i = startIndex; i < items.length; i++) {
        const span = items[i];
        const pos = getSpanPosition(span);
        const text = span.str;

        // Guardrail: Don't cross into next reference
        if (stopBeforeY !== undefined && pos.y < stopBeforeY) {
          console.log(
            `[Citation] Stopped at guardrail: next reference boundary`,
          );
          break;
        }

        // Check line break via vertical movement
        const verticalGap = Math.abs(pos.y - currentLineY);
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
            const nextPos = getSpanPosition(items[i + 1]);
            // If next span is on same line, include it for pattern matching
            if (Math.abs(nextPos.y - pos.y) < 3) {
              lineStartText = text + items[i + 1].str;
            }
          }

          // Use format hint for smarter boundary detection
          if (
            formatHint === "numbered-bracket" &&
            /^\s*\[\d+\]/.test(lineStartText)
          ) {
            break;
          } else if (
            formatHint === "numbered-dot" &&
            /^\s*\d+\./.test(lineStartText)
          ) {
            break;
          } else if (refNumberPattern.test(lineStartText)) {
            break;
          }

          // Check indentation
          if (lineCount === 1) {
            currCiteX = pos.x;
          } else if (currCiteX !== null) {
            const hasHangingIndent = currCiteX > firstLineX + 6;
            if (hasHangingIndent) {
              if (pos.x < currCiteX - 8) {
                break;
              }
            } else {
              const minX = Math.min(firstLineX, currCiteX);
              if (pos.x < minX - 8) {
                break;
              }
            }
          }
          currentLineY = pos.y;
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
      const [x1, y1, x2, y2] =
        viewportForRects.convertToViewportRectangle(rect);
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
