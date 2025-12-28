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
  }

  #setupEventListeners() {
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    // Listen for text selection changes
    document.addEventListener(
      "selectionchange",
      () => {
        this.#onSelectionChange();
      },
      { signal },
    );

    // Hide toolbar when clicking outside
    document.addEventListener(
      "mousedown",
      (e) => {
        // Don't hide if clicking on toolbar or comment input
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

  #onSelectionChange() {
    // Track selection changes but don't show toolbar yet
    // (wait for mouseup to avoid flickering during selection)
  }

  #hasActiveSelection() {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 && !selection.isCollapsed;
  }

  #checkForNewSelection() {
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
      if (rect.width > viewportWidth * 0.9 && rect.height > viewportHeight * 0.3) {
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
      // No visible rects, fall back to bounding rect
      return range.getBoundingClientRect();
    }

    // Use the last visible rect (where the user likely ended their selection)
    // This provides better UX as the toolbar appears near the cursor
    const lastRect = visibleRects[visibleRects.length - 1];
    return lastRect;
  }

  #createAnnotation(options) {
    if (!this.#pendingSelection) return;

    const { color, type } = options;

    // Build page ranges from selection data, converting to normalized rects
    const pageRanges = this.#pendingSelection.map((sel) => {
      const pageView = this.#pane.pages[sel.pageNumber - 1];
      const layerWidth =
        parseFloat(pageView.textLayer.style.width) ||
        pageView.wrapper.clientWidth;
      const layerHeight =
        parseFloat(pageView.textLayer.style.height) ||
        pageView.wrapper.clientHeight;

      // Convert pixel rects to normalized ratios (0-1)
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

    // Create annotation in document model
    const annotation = this.#pane.document.addAnnotation({
      type,
      color,
      pageRanges,
    });

    // Clear selection
    document.getSelection()?.removeAllRanges();
    this.#pendingSelection = null;

    // Hide toolbar
    this.#toolbar.hide();

    return annotation;
  }

  #showCommentInputForNewAnnotation(rect) {
    // First create the annotation
    const annotation = this.#createAnnotation({
      color: AnnotationToolbar.lastColor,
      type: AnnotationToolbar.lastType,
    });

    if (!annotation) return;

    // Then show comment input
    this.#commentInput.show(rect, annotation.color, "", {
      onSave: (text) => {
        this.#pane.document.updateAnnotation(annotation.id, { comment: text });
      },
      onCancel: () => {
        // Annotation already created, just close
      },
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
      onAnnotate: (options) => {
        this.#pane.document.updateAnnotation(annotationId, options);
        this.#toolbar.hide();
        this.#selectAnnotation(null);
      },
      onComment: () => {
        this.#commentInput.show(
          rect,
          annotation.color,
          annotation.comment || "",
          {
            onSave: (text) => {
              this.#pane.document.updateAnnotation(annotationId, {
                comment: text,
              });
            },
            onCancel: () => { },
          },
        );
        this.#toolbar.hide();
      },
      onDelete: () => {
        this.#pane.document.deleteAnnotation(annotationId);
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
      onSave: (text) => {
        this.#pane.document.updateAnnotation(annotationId, { comment: text });
      },
      onCancel: () => { },
    });
  }

  #deleteAnnotationComment(annotationId) {
    this.#pane.document.deleteAnnotationComment(annotationId);
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

  /**
   * Render annotations for a specific page (called when page becomes visible)
   * With SVG layer, we just ensure the layer is up to date
   */
  renderPageAnnotations(pageNumber) {
    // SVG layer handles all pages, just refresh if needed
    // This is called after page render, so positions should be stable
  }

  destroy() {
    this.#abortController?.abort();
    this.#svgLayer?.destroy();
    this.#commentDisplay?.destroy();
    this.#toolbar?.hide();
    this.#commentInput?.hide();
  }
}
