/**
 * CommentDisplay - Manages comment cards displayed on the right side of pages
 *
 * Comments can be in two states:
 * - Expanded: Full card shown when there's space on the right
 * - Collapsed: Small strip when canvas takes full width
 */
export class CommentDisplay {
  /** @type {ViewerPane} */
  #pane = null;

  /** @type {HTMLElement} */
  #container = null;

  /** @type {Map<string, HTMLElement>} */
  #commentElements = new Map();

  /** @type {ResizeObserver} */
  #resizeObserver = null;

  /** @type {boolean} */
  #isCollapsedMode = false;

  /** @type {string|null} */
  #expandedCommentId = null;

  /**
   * @param {ViewerPane} pane
   */
  constructor(pane) {
    this.#pane = pane;
    this.#createContainer();
    this.#setupResizeObserver();
  }

  #createContainer() {
    this.#container = document.createElement("div");
    this.#container.className = "comments-container";
    // Append to stage so comments scroll with document content
    this.#pane.stage.appendChild(this.#container);
  }

  #setupResizeObserver() {
    this.#resizeObserver = new ResizeObserver(() => {
      this.#checkCollapsedMode();
      this.#updateAllPositions();
    });

    this.#resizeObserver.observe(this.#pane.scroller);
  }

  #checkCollapsedMode() {
    const scrollerWidth = this.#pane.scroller.clientWidth;
    const stageWidth = this.#pane.stage.scrollWidth;

    // If stage is wider than scroller (or nearly so), collapse comments
    const shouldCollapse = stageWidth >= scrollerWidth - 50;

    if (shouldCollapse !== this.#isCollapsedMode) {
      this.#isCollapsedMode = shouldCollapse;
      this.#container.classList.toggle("collapsed-mode", shouldCollapse);

      // Reset expanded state when switching modes
      if (shouldCollapse) {
        this.#expandedCommentId = null;
        this.#commentElements.forEach((el) =>
          el.classList.remove("force-expanded"),
        );
      }
    }
  }

  /**
   * Add or update a comment display
   * @param {Object} annotation - The annotation with comment
   */
  addComment(annotation) {
    if (!annotation.comment) return;

    let element = this.#commentElements.get(annotation.id);

    if (!element) {
      element = this.#createCommentElement(annotation);
      this.#commentElements.set(annotation.id, element);
      this.#container.appendChild(element);
    } else {
      this.#updateCommentElement(element, annotation);
    }

    this.#positionComment(annotation.id);
  }

  #createCommentElement(annotation) {
    const element = document.createElement("div");
    element.className = "comment-card";
    element.dataset.annotationId = annotation.id;
    element.dataset.color = annotation.color;

    element.innerHTML = `
      <div class="comment-collapsed-indicator">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="comment-expanded-content">
        <div class="comment-text"></div>
        <div class="comment-actions">
          <button class="comment-edit-btn" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="comment-delete-btn" title="Delete Comment">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    this.#updateCommentElement(element, annotation);
    this.#attachCommentListeners(element, annotation);

    return element;
  }

  #updateCommentElement(element, annotation) {
    element.dataset.color = annotation.color;
    element.querySelector(".comment-text").textContent = annotation.comment;
  }

  #attachCommentListeners(element, annotation) {
    // Click on collapsed indicator to expand
    element
      .querySelector(".comment-collapsed-indicator")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.#toggleExpanded(annotation.id);
      });

    // Edit button
    element
      .querySelector(".comment-edit-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.#pane.editAnnotationComment?.(annotation.id);
      });

    // Delete comment button (only deletes comment, not annotation)
    element
      .querySelector(".comment-delete-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.#pane.deleteAnnotationComment?.(annotation.id);
      });

    // Click on card to select annotation
    element.addEventListener("click", () => {
      this.#pane.selectAnnotation?.(annotation.id);
    });
  }

  #toggleExpanded(annotationId) {
    const element = this.#commentElements.get(annotationId);
    if (!element) return;

    if (this.#expandedCommentId === annotationId) {
      // Collapse
      this.#expandedCommentId = null;
      element.classList.remove("force-expanded");
    } else {
      // Collapse previous
      if (this.#expandedCommentId) {
        const prevElement = this.#commentElements.get(this.#expandedCommentId);
        prevElement?.classList.remove("force-expanded");
      }
      // Expand this one
      this.#expandedCommentId = annotationId;
      element.classList.add("force-expanded");
    }
  }

  /**
   * Position a comment card relative to its annotation
   * @param {string} annotationId
   */
  #positionComment(annotationId) {
    const element = this.#commentElements.get(annotationId);
    if (!element) return;

    const annotation = this.#pane.document.getAnnotation(annotationId);
    if (!annotation) return;

    // Find the top of the annotation
    const firstPageRange = annotation.pageRanges[0];
    if (!firstPageRange) return;

    const pageView = this.#pane.pages[firstPageRange.pageNumber - 1];
    if (!pageView) return;

    const layerHeight =
      parseFloat(pageView.textLayer.style.height) ||
      pageView.wrapper.clientHeight;

    // Get the top rect of the annotation (using topRatio now)
    const topRect = firstPageRange.rects.reduce(
      (min, rect) => (rect.topRatio < min.topRatio ? rect : min),
      firstPageRange.rects[0],
    );

    // Calculate position relative to stage:
    // - pageView.wrapper.offsetTop is the page's top position within the stage
    // - topRect.topRatio * layerHeight converts the ratio to pixels within the page
    const topOffset = pageView.wrapper.offsetTop + topRect.topRatio * layerHeight;

    element.style.top = `${topOffset}px`;
  }

  /**
   * Update positions of all comments
   */
  #updateAllPositions() {
    for (const annotationId of this.#commentElements.keys()) {
      this.#positionComment(annotationId);
    }
  }

  /**
   * Remove a comment display
   * @param {string} annotationId
   */
  removeComment(annotationId) {
    const element = this.#commentElements.get(annotationId);
    if (element) {
      element.remove();
      this.#commentElements.delete(annotationId);
    }

    if (this.#expandedCommentId === annotationId) {
      this.#expandedCommentId = null;
    }
  }

  /**
   * Highlight a comment card
   * @param {string} annotationId
   */
  highlightComment(annotationId) {
    // Remove highlight from all
    this.#commentElements.forEach((el) => el.classList.remove("highlighted"));

    // Add to target
    const element = this.#commentElements.get(annotationId);
    if (element) {
      element.classList.add("highlighted");
    }
  }

  /**
   * Clear all comment displays
   */
  clear() {
    this.#commentElements.forEach((el) => el.remove());
    this.#commentElements.clear();
    this.#expandedCommentId = null;
  }

  /**
   * Refresh all comments from document model
   */
  refresh() {
    this.clear();

    const annotations = this.#pane.document.getAllAnnotations();
    for (const annotation of annotations) {
      if (annotation.comment) {
        this.addComment(annotation);
      }
    }
  }

  destroy() {
    this.#resizeObserver?.disconnect();
    this.clear();
    this.#container?.remove();
  }
}
