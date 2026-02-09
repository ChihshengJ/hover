export class AnnotationSVGLayer {
  /** @type {ViewerPane} */
  #pane = null;

  /** @type {SVGSVGElement} */
  #svg = null;

  /** @type {Map<string, SVGGElement>} */
  #annotationGroups = new Map();

  /** @type {string|null} */
  #hoveredId = null;

  /** @type {string|null} */
  #selectedId = null;

  /** @type {ResizeObserver} */
  #resizeObserver = null;

  constructor(pane) {
    this.#pane = pane;
    this.#createSVG();
    this.#setupResizeObserver();
  }

  #createSVG() {
    const ns = "http://www.w3.org/2000/svg";
    this.#svg = document.createElementNS(ns, "svg");
    this.#svg.classList.add("annotation-svg-layer");

    // Position to cover entire stage
    this.#svg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      pointer-events: none;
      z-index: 50;
      overflow: visible;
    `;

    this.#pane.stage.insertBefore(this.#svg, this.#pane.stage.firstChild);

    this.#updateSVGSize();
  }

  #setupResizeObserver() {
    this.#resizeObserver = new ResizeObserver(() => {
      this.refresh();
    });
    this.#resizeObserver.observe(this.#pane.stage);
  }

  #updateSVGSize() {
    // Match SVG size to stage scroll dimensions
    const stageRect = this.#pane.stage.getBoundingClientRect();
    this.#svg.setAttribute("width", stageRect.width);
    this.#svg.setAttribute("height", stageRect.height);
    this.#svg.setAttribute(
      "viewBox",
      `0 0 ${stageRect.width} ${stageRect.height}`,
    );
  }

  /**
   * @param {Array} annotations
   */
  render(annotations) {
    for (const [id, group] of this.#annotationGroups) {
      group.remove();
    }
    this.#annotationGroups.clear();
    this.#svg.innerHTML = "";

    for (const annotation of annotations) {
      this.#renderAnnotation(annotation);
    }
  }

  /**
   * @param {Object} annotation
   */
  #renderAnnotation(annotation) {
    const ns = "http://www.w3.org/2000/svg";

    const group = document.createElementNS(ns, "g");
    group.classList.add("annotation-group");
    group.dataset.annotationId = annotation.id;
    group.dataset.color = annotation.color;
    group.dataset.type = annotation.type;

    const rectsPerPage = new Map();

    for (const pageRange of annotation.pageRanges) {
      const pageView = this.#pane.pages[pageRange.pageNumber - 1];
      if (!pageView) continue;

      const pageTop = pageView.wrapper.offsetTop;
      const pageLeft = pageView.wrapper.offsetLeft;
      const layerWidth =
        parseFloat(pageView.textLayer.style.width) ||
        pageView.wrapper.clientWidth;
      const layerHeight =
        parseFloat(pageView.textLayer.style.height) ||
        pageView.wrapper.clientHeight;

      const mergedRects = this.#mergeLineRects(pageRange.rects);

      const pagePixelRects = [];

      for (const rect of mergedRects) {
        const pixelRect = {
          x: pageLeft + rect.leftRatio * layerWidth,
          y: pageTop + rect.topRatio * layerHeight,
          width: rect.widthRatio * layerWidth,
          height: rect.heightRatio * layerHeight,
        };

        pagePixelRects.push(pixelRect);

        // Create mark element
        const mark = this.#createMark(annotation, pixelRect);
        group.appendChild(mark);
      }

      if (pagePixelRects.length > 0) {
        rectsPerPage.set(pageRange.pageNumber, pagePixelRects);
      }
    }

    for (const [pageNumber, pageRects] of rectsPerPage) {
      const outline = this.#createOutline(annotation, pageRects);
      group.insertBefore(outline, group.firstChild);
    }

    // Attach event listeners
    this.#attachEvents(group, annotation.id);

    this.#svg.appendChild(group);
    this.#annotationGroups.set(annotation.id, group);
  }

  /**
   * Create an SVG rect for a highlight or underline mark
   */
  #createMark(annotation, rect) {
    const ns = "http://www.w3.org/2000/svg";
    const element = document.createElementNS(ns, "rect");
    element.classList.add("annotation-mark", annotation.type);
    element.dataset.color = annotation.color;

    if (annotation.type === "highlight") {
      element.setAttribute("x", rect.x);
      element.setAttribute("y", rect.y);
      element.setAttribute("width", rect.width);
      element.setAttribute("height", rect.height);
      element.setAttribute("rx", 3);
      element.setAttribute("ry", 3);
    } else {
      const underlineHeight = 2;
      element.setAttribute("x", rect.x);
      element.setAttribute("y", rect.y + rect.height - underlineHeight);
      element.setAttribute("width", rect.width);
      element.setAttribute("height", underlineHeight);
      element.setAttribute("rx", 1);
      element.setAttribute("ry", 1);
    }

    element.style.pointerEvents = "auto";
    return element;
  }

  /**
   * Create outline rect spanning all marks
   */
  #createOutline(annotation, pixelRects) {
    const ns = "http://www.w3.org/2000/svg";

    // Calculate bounding box
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of pixelRects) {
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    }

    const padding = 4;
    const element = document.createElementNS(ns, "rect");
    element.classList.add("annotation-outline");
    element.dataset.color = annotation.color;

    element.setAttribute("x", minX - padding);
    element.setAttribute("y", minY - padding);
    element.setAttribute("width", maxX - minX + padding * 2);
    element.setAttribute("height", maxY - minY + padding * 2);
    element.setAttribute("rx", 4);
    element.setAttribute("ry", 4);
    element.setAttribute("fill", "none");
    element.setAttribute("stroke-width", 2);
    element.setAttribute("stroke-dasharray", "6 3");

    return element;
  }

  #mergeLineRects(rects) {
    if (rects.length === 0) return [];
    if (rects.length === 1) return rects;

    const lineThreshold = 0.01; // 1% of height - tolerance for same line
    const gapThreshold = 0.05; // 5% of width - max gap to fill

    // Sort by top, then left
    const sorted = [...rects].sort((a, b) => {
      const topDiff = a.topRatio - b.topRatio;
      if (Math.abs(topDiff) > lineThreshold) return topDiff;
      return a.leftRatio - b.leftRatio;
    });

    const lines = [];
    let currentLine = [sorted[0]];
    let lineTop = sorted[0].topRatio;

    for (let i = 1; i < sorted.length; i++) {
      const rect = sorted[i];
      if (Math.abs(rect.topRatio - lineTop) <= lineThreshold) {
        currentLine.push(rect);
      } else {
        lines.push(currentLine);
        currentLine = [rect];
        lineTop = rect.topRatio;
      }
    }
    lines.push(currentLine);

    const merged = [];
    for (const line of lines) {
      merged.push(...this.#mergeRectsOnLine(line, gapThreshold));
    }

    return merged;
  }

  /**
   * Merge adjacent rects on the same line
   */
  #mergeRectsOnLine(rects, gapThreshold) {
    if (rects.length === 0) return [];
    if (rects.length === 1) return rects;

    // Sort by left position
    rects.sort((a, b) => a.leftRatio - b.leftRatio);

    const merged = [];
    let current = { ...rects[0] };

    for (let i = 1; i < rects.length; i++) {
      const next = rects[i];
      const currentRight = current.leftRatio + current.widthRatio;
      const gap = next.leftRatio - currentRight;

      if (gap <= gapThreshold) {
        // Merge: extend current to include next
        const newRight = Math.max(
          currentRight,
          next.leftRatio + next.widthRatio,
        );
        current.widthRatio = newRight - current.leftRatio;

        const currentBottom = current.topRatio + current.heightRatio;
        const nextBottom = next.topRatio + next.heightRatio;
        const minTop = Math.min(current.topRatio, next.topRatio);
        const maxBottom = Math.max(currentBottom, nextBottom);
        current.topRatio = minTop;
        current.heightRatio = Math.abs(maxBottom - minTop);
      } else {
        // Gap too large, start new rect
        merged.push(current);
        current = { ...next };
      }
    }

    merged.push(current);
    return merged;
  }

  /**
   * Attach hover and click events to annotation group
   */
  #attachEvents(group, annotationId) {
    group.addEventListener("mouseenter", () => {
      this.#onHover(annotationId, true);
    });

    group.addEventListener("mouseleave", () => {
      this.#onHover(annotationId, false);
    });

    group.addEventListener("click", (e) => {
      this.#onClick(annotationId);
      e.stopPropagation();
    });
  }

  #onHover(annotationId, isEntering) {
    if (isEntering) {
      if (this.#hoveredId === annotationId) return;

      // Clear previous hover
      if (this.#hoveredId) {
        this.#setGroupState(this.#hoveredId, "hovered", false);
        this.#pane.onAnnotationHover?.(this.#hoveredId, false);
      }

      this.#hoveredId = annotationId;
      this.#setGroupState(annotationId, "hovered", true);
      this.#pane.onAnnotationHover?.(annotationId, true);
    } else {
      if (this.#hoveredId !== annotationId) return;

      this.#hoveredId = null;
      this.#setGroupState(annotationId, "hovered", false);
      this.#pane.onAnnotationHover?.(annotationId, false);
    }
  }

  #onClick(annotationId) {
    this.#pane.onAnnotationClick?.(annotationId);
  }

  #setGroupState(annotationId, state, value) {
    const group = this.#annotationGroups.get(annotationId);
    if (!group) return;
    group.classList.toggle(state, value);
  }

  selectAnnotation(annotationId) {
    if (this.#selectedId) {
      this.#setGroupState(this.#selectedId, "selected", false);
    }

    this.#selectedId = annotationId;

    if (annotationId) {
      this.#setGroupState(annotationId, "selected", true);
    }
  }

  getAnnotationRect(annotationId) {
    const group = this.#annotationGroups.get(annotationId);
    if (!group) return null;

    const marks = group.querySelectorAll(".annotation-mark");
    if (marks.length === 0) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const mark of marks) {
      const rect = mark.getBoundingClientRect();
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.right);
      maxY = Math.max(maxY, rect.bottom);
    }

    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  addAnnotation(annotation) {
    this.removeAnnotation(annotation.id);
    this.#renderAnnotation(annotation);
  }

  updateAnnotation(annotation) {
    this.removeAnnotation(annotation.id);
    this.#renderAnnotation(annotation);

    if (this.#selectedId === annotation.id) {
      this.#setGroupState(annotation.id, "selected", true);
    }
  }

  removeAnnotation(annotationId) {
    const group = this.#annotationGroups.get(annotationId);
    if (group) {
      group.remove();
      this.#annotationGroups.delete(annotationId);
    }

    if (this.#selectedId === annotationId) {
      this.#selectedId = null;
    }
    if (this.#hoveredId === annotationId) {
      this.#hoveredId = null;
    }
  }

  refresh() {
    this.#updateSVGSize();
    const annotations = this.#pane.document.getAllAnnotations();
    this.render(annotations);

    if (this.#selectedId) {
      this.#setGroupState(this.#selectedId, "selected", true);
    }
  }

  clear() {
    this.#svg.innerHTML = "";
    this.#annotationGroups.clear();
    this.#hoveredId = null;
    this.#selectedId = null;
  }

  destroy() {
    if (this.#resizeObserver) {
      this.#resizeObserver.unobserve(this.#pane.stage);
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
    this.clear();
    this.#svg?.remove();
  }
}
