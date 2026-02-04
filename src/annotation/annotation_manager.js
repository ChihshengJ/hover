import { AnnotationToolbar } from "./annotation_toolbar.js";
import { CommentInput } from "./comment_input.js";
import { CommentDisplay } from "./comment_display.js";
import { AnnotationSVGLayer } from "./annotation_svg_layer.js";

/**
 * AnnotationManager - Coordinates annotation UI for a ViewerPane
 *
 * Handles:
 * - Showing toolbar when text is selected
 * - Creating/updating/deleting annotations
 * - Managing comment input
 * - Coordinating with CommentDisplay
 * - SVG-based annotation rendering
 */
export class AnnotationManager {
  /** @type {ViewerPane} */
  #pane = null;

  /** @type {AnnotationToolbar} */
  #toolbar = null;

  /** @type {CommentInput} */
  #commentInput = null;

  /** @type {CommentDisplay} */
  #commentDisplay = null;

  /** @type {AnnotationSVGLayer} */
  #svgLayer = null;

  /** @type {string|null} */
  #selectedAnnotationId = null;

  /** @type {Object|null} */
  #pendingSelection = null;

  /** @type {AbortController|null} */
  #abortController = null;

  /** @type {boolean} */
  #isCreatingAnnotation = false;

  /**
   * @param {ViewerPane} pane
   */
  constructor(pane) {
    this.#pane = pane;
    this.#toolbar = AnnotationToolbar.getInstance();
    this.#commentInput = CommentInput.getInstance();
    this.#commentDisplay = new CommentDisplay(pane);
    this.#svgLayer = new AnnotationSVGLayer(pane);

    this.#setupEventListeners();
    this.#setupPaneCallbacks();

    requestAnimationFrame(() => {
      this.#refreshAllAnnotations();
    });
  }

  #setupEventListeners() {
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    // Hide toolbar when clicking outside
    document.addEventListener(
      "mousedown",
      (e) => {
        if (
          e.target.closest(".annotation-toolbar-container") ||
          e.target.closest(".comment-input-container")
        ) {
          return;
        }

        // Don't hide if clicking on an annotation mark (will be handled by onAnnotationClick)
        if (e.target.closest(".annotation-mark")) {
          return;
        }

        // Hide toolbar if visible
        if (this.#toolbar.isVisible) {
          // Small delay to allow selection to complete
          setTimeout(() => {
            if (!this.#hasActiveSelection()) {
              this.#toolbar.hide();
              this.#selectAnnotation(null);
            }
          }, 100);
        }
      },
      { signal },
    );

    // Handle mouseup to show toolbar for new selection
    this.#pane.scroller.addEventListener(
      "mouseup",
      (e) => {
        // Delay to let selection finalize
        setTimeout(() => {
          this.#checkForNewSelection();
        }, 50);
      },
      { signal },
    );
  }

  #setupPaneCallbacks() {
    // These callbacks are called by AnnotationRenderer
    this.#pane.onAnnotationHover = (annotationId, isEntering) => {
      this.#onAnnotationHover(annotationId, isEntering);
    };

    this.#pane.onAnnotationClick = (annotationId) => {
      this.#onAnnotationClick(annotationId);
    };

    // These callbacks are called by CommentDisplay
    this.#pane.editAnnotationComment = (annotationId) => {
      this.#editAnnotationComment(annotationId);
    };

    this.#pane.deleteAnnotationComment = (annotationId) => {
      this.#deleteAnnotationComment(annotationId);
    };

    this.#pane.selectAnnotation = (annotationId) => {
      this.#selectAnnotation(annotationId);
    };
  }

  #hasActiveSelection() {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 && !selection.isCollapsed;
  }

  #checkForNewSelection() {
    if (this.#pane.handMode) return;
    if (!this.#hasActiveSelection()) return;

    const selectionData = this.#pane.textSelectionManager.getSelection();
    if (selectionData.length === 0) return;

    // Store the selection data
    this.#pendingSelection = selectionData;

    // Get selection bounding rect - use a visible rect for cross-page selections
    const selection = document.getSelection();
    const range = selection.getRangeAt(0);
    const rect = this.#getVisibleSelectionRect(range);

    if (!rect) return;

    // Show toolbar
    this.#toolbar.showForSelection(rect, {
      onAnnotate: (options) => this.#createAnnotation(options),
      onComment: () => this.#showCommentInputForNewAnnotation(rect),
    });
  }

  /**
   * Get a selection rect that's visible in the viewport.
   * For cross-page selections, getBoundingClientRect() returns a huge rect
   * spanning all pages, which positions the toolbar off-screen.
   * Instead, find the last client rect that's visible in the viewport.
   */
  #getVisibleSelectionRect(range) {
    const clientRects = Array.from(range.getClientRects());
    if (clientRects.length === 0) {
      return range.getBoundingClientRect();
    }

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Filter to rects that are at least partially visible in the viewport
    const visibleRects = clientRects.filter((rect) => {
      // Skip suspiciously large rects (likely container elements)
      if (
        rect.width > viewportWidth * 0.95 &&
        rect.height > viewportHeight * 0.3
      ) {
        return false;
      }
      // Check if rect is in viewport
      return (
        rect.bottom > 0 &&
        rect.top < viewportHeight &&
        rect.right > 0 &&
        rect.left < viewportWidth &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    if (visibleRects.length === 0) {
      return range.getBoundingClientRect();
    }
    const lastRect = visibleRects[visibleRects.length - 1];
    return lastRect;
  }

  /**
   * Create a new annotation from the pending selection
   * @param {Object} options
   * @param {string} options.color - Color name
   * @param {string} options.type - 'highlight' or 'underline'
   * @returns {Promise<Object|null>} The created annotation
   */
  async #createAnnotation(options) {
    if (!this.#pendingSelection) return null;
    if (this.#isCreatingAnnotation) return null;

    this.#isCreatingAnnotation = true;

    try {
      const { color, type } = options;

      const pageRanges = this.#pendingSelection.map((sel) => {
        const pageView = this.#pane.pages[sel.pageNumber - 1];
        const layerWidth =
          parseFloat(pageView.textLayer.style.width) ||
          pageView.wrapper.clientWidth;
        const layerHeight =
          parseFloat(pageView.textLayer.style.height) ||
          pageView.wrapper.clientHeight;

        const normalizedRects = sel.rects.map((rect) => ({
          leftRatio: rect.left / layerWidth,
          topRatio: rect.top / layerHeight,
          widthRatio: rect.width / layerWidth,
          heightRatio: rect.height / layerHeight,
        }));

        return {
          pageNumber: sel.pageNumber,
          rects: normalizedRects,
          text: sel.text,
        };
      });

      const annotation = await this.#pane.document.addAnnotation({
        type,
        color,
        pageRanges,
      });

      document.getSelection()?.removeAllRanges();
      this.#pendingSelection = null;

      this.#toolbar.hide();

      return annotation;
    } finally {
      this.#isCreatingAnnotation = false;
    }
  }

  async #showCommentInputForNewAnnotation(rect) {
    const annotation = await this.#createAnnotation({
      color: AnnotationToolbar.lastColor,
      type: AnnotationToolbar.lastType,
    });

    if (!annotation) return;

    this.#commentInput.show(rect, annotation.color, "", {
      onSave: async (text) => {
        await this.#pane.document.updateAnnotation(annotation.id, {
          comment: text,
        });
      },
      onCancel: () => { },
    });
  }

  #onAnnotationHover(annotationId, isEntering) {
    if (isEntering) {
      // Highlight comment card if exists
      this.#commentDisplay.highlightComment(annotationId);
    } else {
      // Remove highlight if not selected
      if (this.#selectedAnnotationId !== annotationId) {
        this.#commentDisplay.highlightComment(null);
      }
    }
  }

  #onAnnotationClick(annotationId) {
    this.#selectAnnotation(annotationId);

    // Show toolbar for editing
    const annotation = this.#pane.document.getAnnotation(annotationId);
    if (!annotation) return;

    const rect = this.#getAnnotationRect(annotationId);
    if (!rect) return;

    this.#toolbar.showForAnnotation(rect, annotation, {
      onAnnotate: async (options) => {
        await this.#pane.document.updateAnnotation(annotationId, options);
        this.#toolbar.hide();
        this.#selectAnnotation(null);
      },
      onComment: () => {
        this.#commentInput.show(
          rect,
          annotation.color,
          annotation.comment || "",
          {
            onSave: async (text) => {
              await this.#pane.document.updateAnnotation(annotationId, {
                comment: text,
              });
            },
            onCancel: () => { },
          },
        );
        this.#toolbar.hide();
      },
      onDelete: async () => {
        await this.#pane.document.deleteAnnotation(annotationId);
        this.#selectAnnotation(null);
      },
    });
  }

  #selectAnnotation(annotationId) {
    // Deselect previous
    if (this.#selectedAnnotationId) {
      this.#setAnnotationSelected(this.#selectedAnnotationId, false);
    }

    this.#selectedAnnotationId = annotationId;

    if (annotationId) {
      this.#setAnnotationSelected(annotationId, true);
      this.#commentDisplay.highlightComment(annotationId);
    } else {
      // Clear comment highlight when deselecting
      this.#commentDisplay.highlightComment(null);
    }
  }

  #setAnnotationSelected(annotationId, selected) {
    this.#svgLayer.selectAnnotation(selected ? annotationId : null);
  }

  #getAnnotationRect(annotationId) {
    return this.#svgLayer.getAnnotationRect(annotationId);
  }

  #editAnnotationComment(annotationId) {
    const annotation = this.#pane.document.getAnnotation(annotationId);
    if (!annotation) return;

    const rect = this.#getAnnotationRect(annotationId);
    if (!rect) return;

    this.#commentInput.show(rect, annotation.color, annotation.comment || "", {
      onSave: async (text) => {
        await this.#pane.document.updateAnnotation(annotationId, {
          comment: text,
        });
      },
      onCancel: () => { },
    });
  }

  async #deleteAnnotationComment(annotationId) {
    await this.#pane.document.deleteAnnotationComment(annotationId);
  }

  onDocumentChange(event, data) {
    switch (event) {
      case "annotation-added":
        this.#svgLayer.addAnnotation(data.annotation);
        if (data.annotation.comment) {
          this.#commentDisplay.addComment(data.annotation);
        }
        break;

      case "annotation-updated":
        this.#svgLayer.updateAnnotation(data.annotation);
        if (data.annotation.comment) {
          this.#commentDisplay.addComment(data.annotation);
        } else {
          this.#commentDisplay.removeComment(data.annotation.id);
        }
        break;

      case "annotation-deleted":
        this.#svgLayer.removeAnnotation(data.annotationId);
        this.#commentDisplay.removeComment(data.annotationId);
        break;

      case "annotations-imported":
        this.#refreshAllAnnotations();
        break;
    }
  }

  #refreshAllAnnotations() {
    this.#svgLayer.refresh();
    this.#commentDisplay.refresh();
  }

  /**
   * Public refresh method for external calls (e.g., after zoom/resize)
   */
  refresh() {
    this.#svgLayer.refresh();
    this.#commentDisplay.refresh();
  }

  destroy() {
    this.#abortController?.abort();
    this.#svgLayer?.destroy();
    this.#commentDisplay?.destroy();
    this.#toolbar?.hide();
    this.#commentInput?.hide();
  }
}
