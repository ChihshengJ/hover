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

    this._cachedSpans = null;
    this._lastTextScale = null;
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

      this.annotationLayer.innerHTML = "";
      this.#renderUrlLinks(page, textScale, cssWidth, cssHeight);
      this.#renderCitationOverlays(page, textScale, cssWidth, cssHeight);
      this.#renderCrossRefOverlays(page, textScale, cssWidth, cssHeight);
      if (this.textSlices) {
        if (this._cachedSpans) {
          this.#rescaleTextLayer(textScale);
        } else {
          if (this.pane.textSelectionManager) {
            this.pane.textSelectionManager.unregister(this.textLayer);
          }
          this.textLayer.innerHTML = "";
          this.#buildTextLayer(page, textScale, pageHeight);
         }
      }
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

  #buildTextLayer(page, scale, pageHeight) {
    if (!this.textSlices || this.textSlices.length === 0) return;

    const fragment = document.createDocumentFragment();
    const pending = [];

    for (const line of this.textSlices) {
      const content = line.text || "";
      if (!content || !this.#isValidTextContent(content)) continue;

      const rectX = line.x;
      const rectY = line.originalY;
      const rectWidth = line.lineWidth;
      const rectHeight = line.lineHeight;

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

      const fontFamily = line.font?.family || line.font?.famliy || "sans-serif";
      const cleanFontFamily =
        fontFamily.replace(/['"]/g, "").trim() || "sans-serif";

      const span = document.createElement("span");
      span.textContent = content;
      span.style.cssText = `
        left: ${(rectX * scale).toFixed(2)}px;
        top: ${(rectY * scale).toFixed(2)}px;
        font-size: ${fontSize.toFixed(2)}px;
        font-family: "${cleanFontFamily}", sans-serif;
      `;

      fragment.appendChild(span);
      pending.push({
        span,
        pdfX: rectX,
        pdfY: rectY,
        pdfW: rectWidth,
        pdfH: rectHeight,
        fontFamily: cleanFontFamily,
        visualWidth,
      });
    }

    this.textLayer.appendChild(fragment);

    const measured = [];
    for (const entry of pending) {
      measured.push(entry.span.offsetWidth);
    }

    const cached = [];
    for (let i = 0; i < pending.length; i++) {
      const { span, pdfX, pdfY, pdfH, fontFamily, visualWidth } = pending[i];
      const measuredWidth = measured[i];

      let computedScaleX = 1;
      if (measuredWidth > 0 && visualWidth > 0) {
        computedScaleX = visualWidth / measuredWidth;
        if (computedScaleX < 0.1 || computedScaleX > 5.0) {
          computedScaleX = 1;
        }
      }

      if (computedScaleX !== 1) {
        span.style.transform = `scaleX(${computedScaleX.toFixed(4)})`;
      }

      cached.push({
        span,
        pdfX,
        pdfY,
        pdfH,
        fontFamily,
        scaleX: computedScaleX,
      });
    }

    this._cachedSpans = cached;
    this._lastTextScale = scale;
  }

  #rescaleTextLayer(newScale) {
    for (const entry of this._cachedSpans) {
      const { span, pdfX, pdfY, pdfH, scaleX } = entry;

      span.style.left = `${(pdfX * newScale).toFixed(2)}px`;
      span.style.top = `${(pdfY * newScale).toFixed(2)}px`;
      span.style.fontSize = `${(pdfH * newScale * 0.9).toFixed(2)}px`;
      // scaleX is constant across zoom levels — no re-measurement needed
      if (scaleX !== 1) {
        span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
      }
    }
    this._lastTextScale = newScale;
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

    for (const citRef of citations) {
      if (!citRef.rects || citRef.rects.length === 0) continue;

      // Check if this multi-ref citation has per-number sub-rects
      const details = this.doc.getCitationDetails(citRef.citationId);
      const hasSubRects =
        details?.allTargets?.length > 1 &&
        details.allTargets.some((t) => t.rects?.length > 0);

      if (hasSubRects) {
        // Render individual overlays for each target with its own rects
        for (
          let ti = 0;
          ti < details.allTargets.length;
          ti++
        ) {
          const target = details.allTargets[ti];
          const targetRects = target.rects;
          if (!targetRects?.length) continue;

          for (const rect of targetRects) {
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
            el.dataset.citationId = citRef.citationId;
            el.dataset.targetIndex = ti;
            fragment.appendChild(el);
          }
        }
      } else {
        // Original: single overlay for the whole citation
        for (const rect of citRef.rects) {
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
          el.dataset.citationId = citRef.citationId;
          fragment.appendChild(el);
        }
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
      if (crossRef.isDefinition) continue;

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
    this._delegatedListenersAttached = false;
    this._cachedSpans = null;
    this._lastTextScale = null;

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

  /**
   * Re-render only the annotation overlay layer (citations, cross-refs, URLs)
   * for pages that are already rendered. Called when background indexing completes.
   */
  refreshOverlays() {
    if (this.canvas.dataset.rendered !== "true") return;

    const page = this.#getPage();
    if (!page) return;

    const cssWidth = parseFloat(this.canvas.style.width);
    const cssHeight = parseFloat(this.canvas.style.height);
    const textScale = cssWidth / page.size.width;

    this.annotationLayer.innerHTML = "";
    this.#renderUrlLinks(page, textScale, cssWidth, cssHeight);
    this.#renderCitationOverlays(page, textScale, cssWidth, cssHeight);
    this.#renderCrossRefOverlays(page, textScale, cssWidth, cssHeight);

    if (!this._cachedSpans && this.doc.textIndex) {
      this.textSlices = this.doc.textIndex.getPageLines(this.pageNumber);
      if (this.textSlices) {
        const pageHeight = page.size.height;
        if (this.pane.textSelectionManager) {
          this.pane.textSelectionManager.unregister(this.textLayer);
        }
        this.textLayer.innerHTML = "";
        this.#buildTextLayer(page, textScale, pageHeight);
        this.textLayer.style.setProperty("--total-scale-factor", `${this.scale}`);
        this.#ensureEndOfContent();
        this.textLayer.style.width = `${cssWidth}px`;
        this.textLayer.style.height = `${cssHeight}px`;
      }
    }
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

  #getCitationFromElement(el) {
    const id = Number(el.dataset.citationId);
    return this.doc.getCitationDetails(id);
  }

  async #handleCitationEnter(el, citationPopup) {
    if (this.wrapper.classList.contains("text-selecting")) return;

    if (this._showTimer) clearTimeout(this._showTimer);
    citationPopup.onAnchorEnter();

    const citation = this.#getCitationFromElement(el);
    if (!citation) return;
    // console.log(citation);

    // Check if a specific target index is specified (per-number overlays)
    const targetIndex =
      el.dataset.targetIndex !== undefined
        ? Number(el.dataset.targetIndex)
        : null;

    this._showTimer = setTimeout(async () => {
      const findTextForTarget = async (target) => {
        if (target?.refIndex != null) {
          const refAnchor = this.doc.getReferenceByIndex(target.refIndex);
          if (refAnchor?.cachedText) return refAnchor.cachedText;
        }

        if (target?.refKey) {
          const matched = this.doc.matchCitationToReference(
            target.refKey.author,
            target.refKey.year,
          );
          if (matched?.cachedText) return matched.cachedText;
        }

        // Heuristic fallback: extract text at the destination coordinate
        if (target?.location) {
          return await this.#heuristicFindCiteText(
            target.location.x,
            target.location.pageIndex,
            target.location.y,
          );
        }

        return null;
      };
      await citationPopup.show(
        el,
        citation,
        findTextForTarget,
        targetIndex,
      );
    }, 200);
  }

  async #handleCitationClick(el) {
    const citation = this.#getCitationFromElement(el);
    if (!citation) return;

    // If a specific target index is set (per-number overlay), navigate to that target
    const targetIndex =
      el.dataset.targetIndex !== undefined
        ? Number(el.dataset.targetIndex)
        : null;

    if (
      targetIndex !== null &&
      citation.allTargets?.[targetIndex]?.location
    ) {
      const loc = citation.allTargets[targetIndex].location;
      await this.pane.scrollToPoint(loc.pageIndex, loc.x, loc.y);
      return;
    }

    if (citation.targetLocation) {
      await this.pane.scrollToPoint(
        citation.targetLocation.pageIndex,
        citation.targetLocation.x,
        citation.targetLocation.y,
      );
      return;
    }

    if (citation.refIndices?.length) {
      const refAnchor = this.doc.getReferenceByIndex(citation.refIndices[0]);
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
  // Cross-Reference Handlers (for future add-ons?)
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
  /**
   * @param {number} left - X position in PDF coordinates
   * @param {number} pageIndex - 0-based page index
   * @param {number} top - Y position in PDF coordinates
   * @returns {Promise<string|null>}
   */
  async #heuristicFindCiteText(left, pageIndex, top) {
    const pageNumber = pageIndex + 1;
    const lines = this.doc.textIndex?.getPageLines(pageNumber);
    if (!lines?.length) return null;

    // Find the closest line to the target position
    let startLineIdx = -1;
    let minDist = Infinity;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const dist = Math.abs(line.y - top) + Math.abs(line.x - left) * 0.5;
      if (dist < minDist) {
        minDist = dist;
        startLineIdx = i;
      }
    }

    if (startLineIdx === -1) return null;

    const refNumberPattern = /^\s*[\[\(]?\d{1,3}[\]\)\.\,]?\s+\S/;

    const reference = [];
    const firstLine = lines[startLineIdx];
    const firstLineX = firstLine.x;
    let baselineLineGap = null;
    let continuationLineX = null;
    let lineCount = 0;
    let prevLineY = firstLine.y;

    for (let i = startLineIdx; i < lines.length; i++) {
      const line = lines[i];
      const text = line.text;
      if (!text || text.trim().length === 0) continue;

      if (i > startLineIdx) {
        // Check vertical gap between consecutive lines
        const gap = Math.abs(line.y - prevLineY);

        if (gap > 3) {
          lineCount++;

          if (baselineLineGap === null) {
            baselineLineGap = gap;
          } else if (gap > baselineLineGap * 1.5) {
            break;
          }

          // Check reference number at start of new line
          // Peek ahead to include next span if on same line
          let lineStartText = text;
          if (i + 1 < lines.length) {
            const nextGap = Math.abs(lines[i + 1].y - line.y);
            if (nextGap < 3) {
              lineStartText = text + (lines[i + 1].text || "");
            }
          }

          if (refNumberPattern.test(lineStartText)) {
            break;
          }

          // Check indentation
          if (lineCount === 1) {
            continuationLineX = line.x;
          } else if (continuationLineX !== null) {
            const hasHangingIndent = continuationLineX > firstLineX + 6;
            if (hasHangingIndent) {
              if (line.x < continuationLineX - 10) {
                break;
              }
            } else {
              const minX = Math.min(firstLineX, continuationLineX);
              if (line.x < minX - 10) {
                break;
              }
            }
          }
        }
      }

      reference.push(text);
      prevLineY = line.y;

      if (reference.length > 35) break;
    }

    const result = reference.join("").trim();
    return result.length > 0 ? result : null;
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
