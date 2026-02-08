/**
 * PageView - Renders individual PDF pages using PDFium.
 *
 * Overlay rendering order:
 *   1. URL links (from doc.urlsByPage)
 *   2. Citations (from doc.citationsByPage)
 *   3. Cross-references (from doc.crossRefsByPage)
 *   4. Text layer
 */

import { CitationPopup } from "./controls/citation_popup.js";
import { CitationFlags } from "./data/lexicon.js";

let sharedPopup = null;
function getSharedPopup() {
  if (!sharedPopup) {
    sharedPopup = new CitationPopup();
  }
  return sharedPopup;
}

export class PageView {
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
    this.renderTask = null;
    this.scale = 1;

    this._showTimer = null;
    this._delegatedListenersAttached = false;
  }

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
        this.textSlices = this.doc.textIndex?.getPageLines(this.pageNumber);

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
      this.annotationLayer.innerHTML = "";

      this.#renderUrlLinks(page, textScale, cssWidth, cssHeight);
      this.#renderCitationOverlays(page, textScale, cssWidth, cssHeight);
      this.#renderCrossRefOverlays(page, textScale, cssWidth, cssHeight);
      this.#renderTextLayer(page, textScale, pageHeight);

      this.textLayer.style.setProperty("--total-scale-factor", `${this.scale}`);
      this.#ensureEndOfContent();
      this.textLayer.style.width = `${cssWidth}px`;
      this.textLayer.style.height = `${cssHeight}px`;

      this.#setupAnnotationLayerEvents();

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

  #isValidTextContent(text) {
    if (!text || text.length === 0) return false;
    if (/^\s*$/.test(text)) return false;
    return true;
  }

  #renderTextLayer(page, scale, pageHeight) {
    if (!this.textSlices || this.textSlices.length === 0) return;

    const fragment = document.createDocumentFragment();
    const spansToMeasure = [];

    for (const line of this.textSlices) {
      const content = line.text || "";
      if (!content || !this.#isValidTextContent(content)) continue;

      const rectX = line.x;
      const rectY = line.originalY;
      const rectWidth = line.lineWidth;
      const rectHeight = line.lineHeight;

      const x = rectX * scale;
      const y = rectY * scale;
      const visualWidth = rectWidth * scale;
      const visualHeight = rectHeight * scale;
      let fontSize = visualHeight * 0.9;

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
        line.font?.family || line.font?.famliy || "sans-serif";
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

  // ============================================
  // URL Links
  // ============================================

  #renderUrlLinks(page, scale, cssWidth, cssHeight) {
    const urls = this.doc.urlsByPage?.get(this.pageNumber);
    if (!urls || urls.length === 0) return;

    const fragment = document.createDocumentFragment();

    for (const urlEntry of urls) {
      const rect = urlEntry.rect;
      if (!rect) continue;

      const left = (rect.origin?.x || 0) * scale;
      const top = (rect.origin?.y || 0) * scale;
      const width = (rect.size?.width || 0) * scale;
      const height = (rect.size?.height || 0) * scale;

      const anchor = document.createElement("a");
      anchor.className = "url-link";
      anchor.href = urlEntry.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.dataset.linkType = "external";
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

  // ============================================
  // Citation Overlays
  // ============================================

  #renderCitationOverlays(page, scale, cssWidth, cssHeight) {
    const citations = this.doc.citationsByPage?.get(this.pageNumber);
    if (!citations || citations.length === 0) return;

    const fragment = document.createDocumentFragment();

    for (const citation of citations) {
      if (!citation.rects || citation.rects.length === 0) continue;

      for (const rect of citation.rects) {
        if (rect.height < 3 || rect.width < 3) continue;
        const el = document.createElement("span");
        el.className = "citation-rect";
        el.style.cssText = `
          position: absolute;
          left: ${(rect.x * scale).toFixed(2)}px;
          top: ${(rect.y * scale).toFixed(2)}px;
          width: ${(rect.width * scale).toFixed(2)}px;
          height: ${(rect.height * scale).toFixed(2)}px;
          pointer-events: auto;
          cursor: pointer;
        `;
        el._citationData = citation;
        fragment.appendChild(el);
      }
    }

    this.annotationLayer.appendChild(fragment);
  }

  // ============================================
  // Cross-Reference Overlays
  // ============================================

  #renderCrossRefOverlays(page, scale, cssWidth, cssHeight) {
    const crossRefs = this.doc.crossRefsByPage?.get(this.pageNumber);
    if (!crossRefs || crossRefs.length === 0) return;

    const fragment = document.createDocumentFragment();

    for (const crossRef of crossRefs) {
      if (!crossRef.rects || crossRef.rects.length === 0) continue;

      for (const rect of crossRef.rects) {
        const el = document.createElement("span");
        el.className = "crossref-rect";
        el.style.cssText = `
          position: absolute;
          left: ${(rect.x * scale).toFixed(2)}px;
          top: ${(rect.y * scale).toFixed(2)}px;
          width: ${(rect.width * scale).toFixed(2)}px;
          height: ${(rect.height * scale).toFixed(2)}px;
          pointer-events: auto;
          cursor: pointer;
        `;
        el._crossRefData = crossRef;
        fragment.appendChild(el);
      }
    }

    this.annotationLayer.appendChild(fragment);
  }

  // ============================================
  // Lifecycle
  // ============================================

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

  // ============================================
  // Event Handling
  // ============================================

  #setupAnnotationLayerEvents() {
    if (this._delegatedListenersAttached) return;
    const citationPopup = getSharedPopup();

    this.annotationLayer.addEventListener(
      "mouseenter",
      (e) => {
        const citRect = e.target.closest(".citation-rect");
        if (citRect) {
          this.#handleCitationEnter(citRect, citationPopup);
          return;
        }
      },
      true,
    );

    this.annotationLayer.addEventListener(
      "mouseleave",
      (e) => {
        const citRect = e.target.closest(".citation-rect");
        if (citRect) {
          this.#handleLeave(citRect, citationPopup);
          return;
        }
      },
      true,
    );

    this.annotationLayer.addEventListener("click", (e) => {
      const citRect = e.target.closest(".citation-rect");
      if (citRect) {
        e.preventDefault();
        this.#handleCitationClick(citRect);
        return;
      }

      const refRect = e.target.closest(".crossref-rect");
      if (refRect) {
        e.preventDefault();
        this.#handleCrossRefClick(refRect);
      }
    });

    this._delegatedListenersAttached = true;
  }

  // ============================================
  // Citation Handlers
  // ============================================

  async #handleCitationEnter(el, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;

    if (this._showTimer) clearTimeout(this._showTimer);
    citationPopup.onAnchorEnter();

    const citation = el._citationData;
    if (!citation) return;

    this._showTimer = setTimeout(async () => {
      const findTextForTarget = async (target) => {
        if (target?.location) {
          const { x, pageIndex, y } = target.location;
          const text = await this.#findCiteText(x, pageIndex, y);
          if (text) return text;
        }

        // Fallback: try to find reference by index
        if (target?.refIndex != null) {
          const refAnchor = this.doc.getReferenceByIndex(target.refIndex);
          if (refAnchor?.cachedText) return refAnchor.cachedText;
        }

        // Fallback: try to match by author-year key
        if (target?.refKey) {
          const matched = this.doc.matchCitationToReference(
            target.refKey.author,
            target.refKey.year,
          );
          if (matched?.cachedText) return matched.cachedText;
        }
        return null;
      };
      await citationPopup.show(el, citation, findTextForTarget);
    }, 200);
  }

  async #handleCitationClick(el) {
    const citation = el._citationData;
    console.log(citation);
    if (!citation) return;

    if (citation.targetLocation) {
      console.log(citation.targetLocation);
      await this.pane.scrollToPoint(
        citation.targetLocation.pageIndex,
        citation.targetLocation.x,
        citation.targetLocation.y,
      );
      return;
    }

    if (citation.refIndices?.length) {
      const refAnchor = this.doc.getReferenceByIndex(citation.refIndices[0]);
      console.log(console.log(refAnchor));
      if (refAnchor) {
        await this.pane.scrollToPoint(
          refAnchor.pageNumber - 1,
          refAnchor.startCoord.x,
          refAnchor.startCoord.y,
        );
      }
    }
  }

  // ============================================
  // Cross-Reference Handlers
  // ============================================

  async #handleCrossRefEnter(el, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;

    if (this._showTimer) clearTimeout(this._showTimer);
    citationPopup.onAnchorEnter();

    const crossRef = el._crossRefData;
    if (!crossRef?.targetLocation) return;

    this._showTimer = setTimeout(async () => {
      const target = this.doc.crossRefTargets?.get(
        `${crossRef.type}-${crossRef.targetId}`,
      );
      const callback = async () => target?.text || null;

      await citationPopup.show(
        el,
        callback,
        crossRef.targetLocation.x,
        crossRef.targetLocation.pageIndex,
        crossRef.targetLocation.y,
      );
    }, 200);
  }

  async #handleCrossRefClick(el) {
    const crossRef = el._crossRefData;
    console.log(crossRef);
    if (!crossRef?.targetLocation) return;
    const scrollFlag = crossRef.flags === 3 ? false : true;

    await this.pane.scrollToPoint(
      crossRef.targetLocation.pageIndex,
      crossRef.targetLocation.x,
      crossRef.targetLocation.y,
      scrollFlag,
    );
  }

  // ============================================
  // Shared Leave Handler
  // ============================================

  #handleLeave(el, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;

    if (this._showTimer) {
      clearTimeout(this._showTimer);
      this._showTimer = null;
    }

    if (citationPopup.currentAnchor === el) {
      citationPopup.onAnchorLeave();
    }
  }

  // ============================================
  // Citation Text Finding
  // ============================================

  async #findCiteText(left, pageIndex, top) {
    const pageNumber = pageIndex + 1;

    if (this.doc.hasReferenceIndex()) {
      const bounds = this.doc.findBoundingReferenceAnchors(
        pageNumber,
        left,
        top,
      );

      if (bounds.current?.cachedText) {
        return bounds.current.cachedText;
      }
    }

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
