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

import { AnnotationToolbar } from "./annotation_toolbar.js";
import { CommentInput } from "./comment_input.js";
import { CommentDisplay } from "./comment_display.js";
import { AnnotationSVGLayer } from "./annotation_svg_layer.js";
import { DrawingSelectionManager } from "./drawing/drawing_selection.js";

import type { AnnotationHost } from "./host.js";
import type { DocEventName } from "../../model/doc_events.js";
import type {
  AnnotationColorName,
  AnnotationType,
} from "../../model/annotation_data.js";
import type {
  SelectionRect,
  TextSelectionRecord,
} from "../../viewer/text_manager.js";

/** What the toolbar reports the user picked. */
export interface AnnotationChoice {
  color: AnnotationColorName;
  type: AnnotationType;
}

export class AnnotationManager {
  #host: AnnotationHost = null;

  #toolbar: AnnotationToolbar = null;

  #commentInput: CommentInput = null;

  #commentDisplay: CommentDisplay = null;

  #svgLayer: AnnotationSVGLayer = null;

  #drawingSelection: DrawingSelectionManager = null;

  #selectedAnnotationId: string | null = null;

  #pendingSelection: Record<string, any> | null = null;

  #abortController: AbortController | null = null;

  #isCreatingAnnotation: boolean = false;

  constructor(host: AnnotationHost) {
    this.#host = host;
    this.#toolbar = AnnotationToolbar.getInstance();
    this.#commentInput = CommentInput.getInstance();
    this.#commentDisplay = new CommentDisplay(host, {
      onEditComment: (id) => this.#editAnnotationComment(id),
      onDeleteComment: (id) => this.#deleteAnnotationComment(id),
      onSelect: (id) => this.selectAnnotation(id),
    });
    this.#svgLayer = new AnnotationSVGLayer(host, {
      onHover: (id, isEntering) => this.#onAnnotationHover(id, isEntering),
      onClick: (id) => this.#onAnnotationClick(id),
    });
    this.#drawingSelection = new DrawingSelectionManager(host);

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
      "pointerdown",
      (e) => {
        if (
          (e.target as Element).closest(".annotation-toolbar-container") ||
          (e.target as Element).closest(".comment-input-container")
        ) {
          return;
        }

        // Don't hide if clicking on an annotation mark (will be handled by onAnnotationClick)
        if ((e.target as Element).closest(".annotation-mark")) {
          return;
        }

        // Hide toolbar if visible
        if (this.#toolbar.isVisible) {
          setTimeout(() => {
            if (!this.#hasActiveSelection()) {
              this.#toolbar.hide();
              this.selectAnnotation(null);
            }
          }, 100);
        }
      },
      { signal },
    );

    // Handle mouseup to show toolbar for new selection
    this.#host.getScroller().addEventListener(
      "pointerup",
      (e) => {
        // Delay to let selection finalize
        setTimeout(() => {
          this.#checkForNewSelection();
        }, 50);
      },
      { signal },
    );
  }

  /**
   * Publish the annotation entry points on the pane, for the code that only
   * has a pane to reach: the drawing controller's click hand-off and the
   * navigation tree's "reveal this annotation".
   *
   * This layer's own children no longer read them back off the pane — they get
   * the same handlers passed to their constructors.
   */
  #setupPaneCallbacks() {
    this.#host.publishCallbacks({
      onAnnotationHover: (id, isEntering) =>
        this.#onAnnotationHover(id, isEntering),
      onAnnotationClick: (id) => this.#onAnnotationClick(id),
      editAnnotationComment: (id) => this.#editAnnotationComment(id),
      deleteAnnotationComment: (id) => this.#deleteAnnotationComment(id),
      selectAnnotation: (id) => this.selectAnnotation(id),
    });
  }

  #hasActiveSelection() {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 && !selection.isCollapsed;
  }

  #checkForNewSelection() {
    if (this.#host.getHandMode()) return;
    if (this.#host.getScroller()?.classList.contains("drawing-mode-active"))
      return;
    if (!this.#hasActiveSelection()) return;

    const selectionData = this.#host.getSelection();
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
      onAnnotate: (options: AnnotationChoice) =>
        this.#createAnnotation(options),
      onComment: () => this.#showCommentInputForNewAnnotation(rect),
      onCopy: () => this.#copySelectionText(),
    });
  }

  /**
   * Get a selection rect that's visible in the viewport.
   * For cross-page selections, getBoundingClientRect() returns a huge rect
   * spanning all pages, which positions the toolbar off-screen.
   * Instead, find the first client rect that's visible in the viewport for annotation toolbar's position
   */
  #getVisibleSelectionRect(range: Range): DOMRect {
    const clientRects = Array.from(range.getClientRects());
    if (clientRects.length === 0) {
      return range.getBoundingClientRect();
    }

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const visibleRects = clientRects.filter((rect) => {
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
    return visibleRects[0];
  }

  /**
   * Create a new annotation from the pending selection
   * @returns The created annotation
   * @param options.color Color name
   * @param options.type 'highlight' or 'underline'
   */
  async #createAnnotation(
    options: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    if (!this.#pendingSelection) return null;
    if (this.#isCreatingAnnotation) return null;

    this.#isCreatingAnnotation = true;

    try {
      const { color, type } = options;

      const pageRanges = this.#pendingSelection.map(
        (sel: TextSelectionRecord) => {
          const pageView = this.#host.getPages()[sel.pageNumber - 1];
          const layerWidth =
            parseFloat(pageView.textLayer.style.width) ||
            pageView.wrapper.clientWidth;
          const layerHeight =
            parseFloat(pageView.textLayer.style.height) ||
            pageView.wrapper.clientHeight;

          const normalizedRects = sel.rects.map((rect: SelectionRect) => ({
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
        },
      );

      const annotation = await this.#host.doc.addAnnotation({
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

  async #showCommentInputForNewAnnotation(rect: DOMRect) {
    const annotation = await this.#createAnnotation({
      color: AnnotationToolbar.lastColor,
      type: AnnotationToolbar.lastType,
    });

    if (!annotation) return;

    this.#commentInput.show(rect, annotation.color, "", {
      onSave: async (text: string) => {
        await this.#host.doc.updateAnnotation(annotation.id, {
          comment: text,
        });
      },
      onCancel: () => {},
    });
  }

  async #copySelectionText() {
    const text = this.#pendingSelection
      ?.map((sel: TextSelectionRecord) => sel.text)
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) return;
    await this.#writeClipboardText(text);
    this.#toolbar.hide();
  }

  async #copyAnnotationText(annotationId: string) {
    const annotation = this.#host.doc.getAnnotation(annotationId);
    if (!annotation) return;
    const text = (annotation.pageRanges || [])
      .map((r) => r.text)
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) return;
    await this.#writeClipboardText(text);
    this.#toolbar.hide();
    this.selectAnnotation(null);
  }

  async #writeClipboardText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("copy failed", err);
    }
  }

  #onAnnotationHover(annotationId: string, isEntering: boolean) {
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

  #onAnnotationClick(annotationId: string) {
    // Show toolbar for editing
    const annotation = this.#host.doc.getAnnotation(annotationId);
    if (!annotation) return;

    // Drawings use their own selection manager (skip SVG outline selection)
    if (annotation.type === "drawing") {
      this.#drawingSelection.select(annotationId, annotation);
      return;
    }

    this.selectAnnotation(annotationId);

    const rect = this.#getAnnotationRect(annotationId);
    if (!rect) return;

    this.#toolbar.showForAnnotation(rect, annotation, {
      onAnnotate: async (options: AnnotationChoice) => {
        await this.#host.doc.updateAnnotation(annotationId, options);
        this.#toolbar.hide();
        this.selectAnnotation(null);
      },
      onComment: () => {
        this.#commentInput.show(
          rect,
          annotation.color,
          annotation.comment || "",
          {
            onSave: async (text: string) => {
              await this.#host.doc.updateAnnotation(annotationId, {
                comment: text,
              });
            },
            onCancel: () => {},
          },
        );
        this.#toolbar.hide();
      },
      onDelete: async () => {
        await this.#host.doc.deleteAnnotation(annotationId);
        this.selectAnnotation(null);
      },
      onCopy: () => this.#copyAnnotationText(annotationId),
    });
  }

  selectAnnotation(annotationId: string | null) {
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

  #setAnnotationSelected(annotationId: string, selected: boolean) {
    this.#svgLayer.selectAnnotation(selected ? annotationId : null);
  }

  #getAnnotationRect(annotationId: string): DOMRect | null {
    return this.#svgLayer.getAnnotationRect(annotationId);
  }

  #editAnnotationComment(annotationId: string) {
    const annotation = this.#host.doc.getAnnotation(annotationId);
    if (!annotation) return;

    const rect = this.#getAnnotationRect(annotationId);
    if (!rect) return;

    this.#commentInput.show(rect, annotation.color, annotation.comment || "", {
      onSave: async (text: string) => {
        await this.#host.doc.updateAnnotation(annotationId, {
          comment: text,
        });
      },
      onCancel: () => {},
    });
  }

  async #deleteAnnotationComment(annotationId: string) {
    await this.#host.doc.deleteAnnotationComment(annotationId);
  }

  onDocumentChange(event: DocEventName, data?: Record<string, any>) {
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
    this.#drawingSelection.refresh();
  }

  /**
   * Public refresh method for external calls (e.g., after zoom/resize)
   */
  refresh() {
    this.#refreshAllAnnotations();
  }

  destroy() {
    this.#abortController?.abort();
    this.#svgLayer?.destroy();
    this.#commentDisplay?.destroy();
    this.#drawingSelection?.destroy();
    this.#toolbar?.hide();
    this.#commentInput?.hide();
  }
}
