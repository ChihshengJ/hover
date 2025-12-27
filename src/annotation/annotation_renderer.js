/**
 * AnnotationRenderer - Renders annotations (highlights and underscores) on text layers
 * 
 * Each annotation is wrapped in a container element for event handling.
 */
export class AnnotationRenderer {
  /** @type {PageView} */
  #pageView = null;
  
  /** @type {HTMLElement} */
  highlightLayer = null;
  
  /** @type {Map<string, HTMLElement>} */
  #annotationWrappers = new Map();  // annotation id -> wrapper element
  
  /** @type {string|null} */
  #hoveredAnnotationId = null;
  
  /** @type {string|null} */
  #selectedAnnotationId = null;

  constructor(pageView) {
    this.#pageView = pageView;
    this.#createHighlightLayer();
  }

  #createHighlightLayer() {
    this.highlightLayer = document.createElement('div');
    this.highlightLayer.className = 'highlight-layer';
    
    const textLayerStyle = this.#pageView.textLayer.style;
    
    // IMPORTANT: z-index: 3 puts this ABOVE text layer (z-index: 2)
    // pointer-events: none allows clicks to pass through to text layer for selection
    this.highlightLayer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: ${textLayerStyle.width || '100%'};
      height: ${textLayerStyle.height || '100%'};
      pointer-events: none;
      z-index: 3;
    `;
    
    // Insert after text layer (will be visually on top due to z-index)
    this.#pageView.wrapper.appendChild(this.highlightLayer);
  }

  render(annotations) {
    this.clear();
    
    for (const annotation of annotations) {
      this.#renderAnnotation(annotation);
    }
  }

  #renderAnnotation(annotation) {
    const pageRange = annotation.pageRanges.find(
      pr => pr.pageNumber === this.#pageView.pageNumber
    );
    
    if (!pageRange || pageRange.rects.length === 0) return;

    const layerWidth = parseFloat(this.#pageView.textLayer.style.width) || this.#pageView.wrapper.clientWidth;
    const layerHeight = parseFloat(this.#pageView.textLayer.style.height) || this.#pageView.wrapper.clientHeight;
    
    // Create wrapper for this annotation
    const wrapper = document.createElement('div');
    wrapper.className = `annotation-wrapper ${annotation.type}`;
    wrapper.dataset.annotationId = annotation.id;
    wrapper.dataset.color = annotation.color;
    
    wrapper.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    `;
    
    // Track bounding box for outline
    let minLeft = Infinity, minTop = Infinity;
    let maxRight = -Infinity, maxBottom = -Infinity;
    
    // Create marks inside wrapper
    for (let i = 0; i < pageRange.rects.length; i++) {
      const rect = pageRange.rects[i];
      
      const pixelRect = {
        left: rect.leftRatio * layerWidth,
        top: rect.topRatio * layerHeight,
        width: rect.widthRatio * layerWidth,
        height: rect.heightRatio * layerHeight,
      };
      
      // Update bounding box
      minLeft = Math.min(minLeft, pixelRect.left);
      minTop = Math.min(minTop, pixelRect.top);
      maxRight = Math.max(maxRight, pixelRect.left + pixelRect.width);
      maxBottom = Math.max(maxBottom, pixelRect.top + pixelRect.height);
      
      const mark = this.#createAnnotationMark(annotation, pixelRect, i, pageRange.rects.length);
      wrapper.appendChild(mark);
    }
    
    // Create outline element positioned around all marks
    const outline = this.#createOutlineElement(annotation, {
      left: minLeft,
      top: minTop,
      width: maxRight - minLeft,
      height: maxBottom - minTop,
    });
    wrapper.appendChild(outline);
    
    // Attach event listeners to wrapper
    this.#attachWrapperListeners(wrapper, annotation.id);
    
    this.highlightLayer.appendChild(wrapper);
    this.#annotationWrappers.set(annotation.id, wrapper);
  }

  #createOutlineElement(annotation, boundingRect) {
    const outline = document.createElement('div');
    outline.className = 'annotation-outline';
    outline.dataset.color = annotation.color;
    
    const padding = 3; // Padding around the marks
    
    outline.style.cssText = `
      position: absolute;
      left: ${boundingRect.left - padding}px;
      top: ${boundingRect.top - padding}px;
      width: ${boundingRect.width + padding * 2}px;
      height: ${boundingRect.height + padding * 2}px;
      pointer-events: none;
    `;
    
    return outline;
  }

  #createAnnotationMark(annotation, rect, index, total) {
    const element = document.createElement('div');
    element.className = `annotation-mark ${annotation.type}`;
    element.dataset.color = annotation.color;
    
    // Determine position class for border-radius styling
    if (total === 1) {
      element.classList.add('single');
    } else if (index === 0) {
      element.classList.add('begin');
    } else if (index === total - 1) {
      element.classList.add('end');
    } else {
      element.classList.add('middle');
    }

    if (annotation.type === 'highlight') {
      element.style.cssText = `
        position: absolute;
        left: ${rect.left}px;
        top: ${rect.top}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        pointer-events: auto;
      `;
    } else {
      // Underscore - thin line at bottom
      element.style.cssText = `
        position: absolute;
        left: ${rect.left}px;
        top: ${rect.top + rect.height - 2}px;
        width: ${rect.width}px;
        height: 3px;
        pointer-events: auto;
      `;
    }

    return element;
  }

  #attachWrapperListeners(wrapper, annotationId) {
    // Mouse enter - any mark in this annotation
    wrapper.addEventListener('mouseenter', (e) => {
      if (!e.target.closest('.annotation-mark')) return;
      this.#onAnnotationHover(annotationId, true);
    }, true);

    // Mouse leave - leaving all marks of this annotation
    wrapper.addEventListener('mouseleave', (e) => {
      this.#onAnnotationHover(annotationId, false);
    });

    // Click on any mark
    wrapper.addEventListener('click', (e) => {
      if (!e.target.closest('.annotation-mark')) return;
      e.stopPropagation();
      this.#onAnnotationClick(annotationId);
    });
  }

  #onAnnotationHover(annotationId, isEntering) {
    if (isEntering) {
      if (this.#hoveredAnnotationId === annotationId) return;
      
      // Clear previous hover
      if (this.#hoveredAnnotationId) {
        this.#setAnnotationState(this.#hoveredAnnotationId, 'hovered', false);
        this.#pageView.pane.onAnnotationHover?.(this.#hoveredAnnotationId, false);
      }
      
      this.#hoveredAnnotationId = annotationId;
      this.#setAnnotationState(annotationId, 'hovered', true);
      this.#pageView.pane.onAnnotationHover?.(annotationId, true);
    } else {
      if (this.#hoveredAnnotationId !== annotationId) return;
      
      this.#hoveredAnnotationId = null;
      this.#setAnnotationState(annotationId, 'hovered', false);
      this.#pageView.pane.onAnnotationHover?.(annotationId, false);
    }
  }

  #onAnnotationClick(annotationId) {
    this.#pageView.pane.onAnnotationClick?.(annotationId);
  }

  #setAnnotationState(annotationId, state, value) {
    const wrapper = this.#annotationWrappers.get(annotationId);
    if (!wrapper) return;
    
    wrapper.classList.toggle(state, value);
  }

  selectAnnotation(annotationId) {
    if (this.#selectedAnnotationId) {
      this.#setAnnotationState(this.#selectedAnnotationId, 'selected', false);
    }
    
    this.#selectedAnnotationId = annotationId;
    
    if (annotationId) {
      this.#setAnnotationState(annotationId, 'selected', true);
    }
  }

  getAnnotationRect(annotationId) {
    const wrapper = this.#annotationWrappers.get(annotationId);
    if (!wrapper) return null;
    
    const marks = wrapper.querySelectorAll('.annotation-mark');
    if (marks.length === 0) return null;
    
    let minLeft = Infinity, minTop = Infinity;
    let maxRight = -Infinity, maxBottom = -Infinity;
    
    for (const mark of marks) {
      const rect = mark.getBoundingClientRect();
      minLeft = Math.min(minLeft, rect.left);
      minTop = Math.min(minTop, rect.top);
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);
    }
    
    return new DOMRect(minLeft, minTop, maxRight - minLeft, maxBottom - minTop);
  }

  updateAnnotation(annotation) {
    this.removeAnnotation(annotation.id);
    this.#renderAnnotation(annotation);
  }

  removeAnnotation(annotationId) {
    const wrapper = this.#annotationWrappers.get(annotationId);
    if (wrapper) {
      wrapper.remove();
      this.#annotationWrappers.delete(annotationId);
    }
    
    if (this.#selectedAnnotationId === annotationId) {
      this.#selectedAnnotationId = null;
    }
    if (this.#hoveredAnnotationId === annotationId) {
      this.#hoveredAnnotationId = null;
    }
  }

  clear() {
    this.#annotationWrappers.forEach(wrapper => wrapper.remove());
    this.#annotationWrappers.clear();
    this.#hoveredAnnotationId = null;
    this.#selectedAnnotationId = null;
  }

  destroy() {
    this.clear();
    this.highlightLayer?.remove();
  }
}
