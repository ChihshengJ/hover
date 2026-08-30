import type { ViewerPane } from "../../viewer/viewpane.js";
import type { AnnotationHost } from "./host.js";
import type { Annotation } from "../../model/annotation_data.js";

/** What the manager that owns this display wants to hear about. */
export interface CommentDisplayHandlers {
  onEditComment(annotationId: string): void;
  onDeleteComment(annotationId: string): void;
  onSelect(annotationId: string): void;
}

export class CommentDisplay {
  #host: AnnotationHost = null;

  #handlers: {
    onEditComment: Function;
    onDeleteComment: Function;
    onSelect: Function;
  } = null;

  #container: HTMLElement = null;

  #commentElements: Map<string, HTMLElement> = new Map();

  #isCollapsedMode: boolean = false;

  #expandedCommentId: string | null = null;

  constructor(host: AnnotationHost, handlers: CommentDisplayHandlers) {
    this.#host = host;
    this.#handlers = handlers;
    this.#createContainer();
  }

  #createContainer() {
    this.#container = document.createElement("div");
    this.#container.className = "comments-container";
    this.#host.getStage().appendChild(this.#container);
  }

  #checkCollapsedMode() {
    const scrollerWidth = this.#host.getScroller().clientWidth;

    const firstPage = this.#host.getPages()[0];
    if (!firstPage) return;
    const pageWidth = firstPage.wrapper.offsetWidth;
    const shouldCollapse = pageWidth >= scrollerWidth - 150;
    if (shouldCollapse !== this.#isCollapsedMode) {
      this.#isCollapsedMode = shouldCollapse;
      this.#container.classList.toggle("collapsed-mode", shouldCollapse);

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
   * @param annotation The annotation with comment
   */
  addComment(annotation: Annotation) {
    if (!annotation.comment) return;

    this.#checkCollapsedMode();

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

  #createCommentElement(annotation: Annotation): HTMLDivElement {
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

  #updateCommentElement(element: HTMLElement, annotation: Annotation) {
    element.dataset.color = annotation.color;
    element.querySelector(".comment-text")!.textContent = annotation.comment;
  }

  #attachCommentListeners(element: HTMLElement, annotation: Annotation) {
    // Click on collapsed indicator to expand
    element
      .querySelector(".comment-collapsed-indicator")!
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.#toggleExpanded(annotation.id);
      });

    // Edit button
    element
      .querySelector(".comment-edit-btn")!
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.#handlers.onEditComment(annotation.id);
      });

    // Delete comment button (only deletes comment, not annotation)
    element
      .querySelector(".comment-delete-btn")!
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.#handlers.onDeleteComment(annotation.id);
      });

    // Click on card to select annotation
    element.addEventListener("click", () => {
      this.#handlers.onSelect(annotation.id);
    });
  }

  #toggleExpanded(annotationId: string) {
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
   */
  #positionComment(annotationId: string) {
    const element = this.#commentElements.get(annotationId);
    if (!element) return;

    const annotation = this.#host.doc.getAnnotation(annotationId);
    if (!annotation) return;

    // Find the top of the annotation
    const firstPageRange = annotation.pageRanges[0];
    if (!firstPageRange) return;

    const pageView = this.#host.getPages()[firstPageRange.pageNumber - 1];
    if (!pageView) return;

    const layerHeight =
      parseFloat(pageView.textLayer.style.height) ||
      pageView.wrapper.clientHeight;

    const topRect = firstPageRange.rects.reduce(
      (min, rect) => (rect.topRatio < min.topRatio ? rect : min),
      firstPageRange.rects[0],
    );

    // Calculate position relative to stage:
    // - pageView.wrapper.offsetTop is the page's top position within the stage
    // - topRect.topRatio * layerHeight converts the ratio to pixels within the page
    const topOffset =
      pageView.wrapper.offsetTop + topRect.topRatio * layerHeight;

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
   */
  removeComment(annotationId: string) {
    const element = this.#commentElements.get(annotationId);
    if (element) {
      element.remove();
      this.#commentElements.delete(annotationId);
    }

    if (this.#expandedCommentId === annotationId) {
      this.#expandedCommentId = null;
    }
  }

  highlightComment(annotationId: string) {
    this.#commentElements.forEach((el) => el.classList.remove("highlighted"));
    const element = this.#commentElements.get(annotationId);
    if (element) {
      element.classList.add("highlighted");
    }
  }

  clear() {
    this.#commentElements.forEach((el) => el.remove());
    this.#commentElements.clear();
    this.#expandedCommentId = null;
  }

  refresh() {
    this.#checkCollapsedMode();
    this.clear();
    const annotations = this.#host.doc.getAllAnnotations();
    for (const annotation of annotations) {
      if (annotation.comment) {
        this.addComment(annotation);
      }
    }
  }

  destroy() {
    this.clear();
    this.#container?.remove();
  }
}
