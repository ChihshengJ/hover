/**
 * AnnotationToolbar - Floating toolbar for creating annotations
 *
 * Appears when text is selected, allows user to:
 * - Choose highlight or underline
 * - Pick a color (yellow, red, blue, green)
 * - Add a comment
 * - Delete annotation (when editing existing)
 */

import type {
  Annotation,
  AnnotationColorName,
  AnnotationType,
} from "../../model/annotation_data.js";
import type { AnnotationChoice } from "./annotation_manager.js";

/** The callbacks a caller supplies when showing the toolbar. */
export interface ToolbarCallbacks {
  onAnnotate(choice: AnnotationChoice): void;
  onComment(): void;
  onCopy(): void;
  onDelete?(): void;
}

export class AnnotationToolbar {
  static #instance: AnnotationToolbar | null = null;

  // Remember user preferences
  static #lastColor: AnnotationColorName = "yellow";
  static #lastType = "highlight";

  #container: HTMLElement = null;

  #toolbar: HTMLElement = null;

  #isVisible: boolean = false;

  #isExpanded: boolean = false;

  #onAnnotate: Function | null = null;

  #onComment: Function | null = null;

  #onDelete: Function | null = null;

  #onCopy: Function | null = null;

  #currentAnnotation: Record<string, any> | null = null;

  #selectionRect: DOMRect | null = null;

  constructor() {
    if (AnnotationToolbar.#instance) {
      return AnnotationToolbar.#instance;
    }
    AnnotationToolbar.#instance = this;
    this.#createDOM();
    this.#attachEventListeners();
  }

  static getInstance() {
    if (!AnnotationToolbar.#instance) {
      new AnnotationToolbar();
    }
    return AnnotationToolbar.#instance;
  }

  static get lastColor() {
    return AnnotationToolbar.#lastColor;
  }

  static get lastType() {
    return AnnotationToolbar.#lastType;
  }

  #createDOM() {
    // Main container
    this.#container = document.createElement("div");
    this.#container.className = "annotation-toolbar-container";

    // The ball/toolbar element
    this.#toolbar = document.createElement("div");
    this.#toolbar.className = "annotation-toolbar collapsed";
    this.#toolbar.innerHTML = `
      <div class="toolbar-ball"></div>
      <div class="toolbar-content">
        <div class="toolbar-colors">
          <button class="color-btn" data-color="yellow" title="Yellow">
            <span class="color-circle yellow"></span>
          </button>
          <button class="color-btn" data-color="red" title="Red">
            <span class="color-circle red"></span>
          </button>
          <button class="color-btn" data-color="blue" title="Blue">
            <span class="color-circle blue"></span>
          </button>
          <button class="color-btn" data-color="green" title="Green">
            <span class="color-circle green"></span>
          </button>
        </div>
        <div class="toolbar-divider"></div>
        <div class="toolbar-actions">
          <button class="action-btn" data-action="highlight" title="Highlight">
            <img src='assets/highlight.png' width='24'></img>
          </button>
          <button class="action-btn" data-action="underline" title="Underline">
            <img src='assets/underline.png' width='24'></img>
          </button>
          <button class="action-btn" data-action="comment" title="Add Comment">
            <!-- <img src='assets/comment.png' width='24'></img> -->
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="currentColor" viewBox="0 0 16 16">
              <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1zM2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z"/>
              <path d="M3 3.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5M3 6a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9A.5.5 0 0 1 3 6m0 2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5"/>
            </svg>
          </button>
          <button class="action-btn" data-action="copy" title="Copy Seleted Text">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="currentColor" viewBox="0 0 16 16">
              <path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z"/>
            </svg>
          </button>
          <button class="action-btn delete-btn hidden" data-action="delete" title="Delete">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash3" viewBox="0 0 16 16">
              <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-.998.06L5 5.03a.5.5 0 0 1 .47-.53Zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-.998-.06l.5-8.5a.5.5 0 0 1 .528-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    this.#container.appendChild(this.#toolbar);
    document.body.appendChild(this.#container);

    // Set initial color on toolbar
    this.#toolbar.dataset.color = AnnotationToolbar.#lastColor;

    // Update active states based on remembered preferences
    this.#updateActiveStates();
  }

  #attachEventListeners() {
    // Color buttons
    this.#toolbar
      .querySelectorAll<HTMLElement>(".color-btn")
      .forEach((btn: HTMLElement) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          AnnotationToolbar.#lastColor = btn.dataset
            .color as AnnotationColorName;
          this.#updateActiveStates();
          this.#triggerAnnotation();
        });
      });

    // Action buttons
    this.#toolbar
      .querySelectorAll<HTMLElement>(".action-btn")
      .forEach((btn: HTMLElement) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;

          if (action === "highlight" || action === "underline") {
            AnnotationToolbar.#lastType = action;
            this.#updateActiveStates();
            this.#triggerAnnotation();
          } else if (action === "comment") {
            this.#onComment?.();
          } else if (action === "copy") {
            this.#onCopy?.();
          } else if (action === "delete") {
            this.#onDelete?.();
            this.hide();
          }
        });
      });

    // Toolbar itself
    this.#toolbar.addEventListener("click", (e) => {
      if (!this.#isExpanded) {
        e.stopPropagation();
        this.#expand();
      }
    });

    // Expand on hover when collapsed
    this.#toolbar.addEventListener("mouseenter", () => {
      if (!this.#isExpanded) {
        this.#expand();
      }
    });

    // Prevent clicks inside toolbar from closing it
    this.#toolbar.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
  }

  #updateActiveStates() {
    // Update toolbar data-color for collapsed ball
    this.#toolbar.dataset.color = AnnotationToolbar.#lastColor;

    // Update color buttons
    this.#toolbar
      .querySelectorAll<HTMLElement>(".color-btn")
      .forEach((btn: HTMLElement) => {
        btn.classList.toggle(
          "active",
          btn.dataset.color === AnnotationToolbar.#lastColor,
        );
      });

    // Update action buttons
    this.#toolbar
      .querySelectorAll<HTMLElement>(
        '.action-btn[data-action="highlight"], .action-btn[data-action="underline"]',
      )
      .forEach((btn: HTMLElement) => {
        btn.classList.toggle(
          "active",
          btn.dataset.action === AnnotationToolbar.#lastType,
        );
      });
  }

  #triggerAnnotation() {
    this.#onAnnotate?.({
      color: AnnotationToolbar.#lastColor,
      type: AnnotationToolbar.#lastType,
    });
  }

  #expand() {
    this.#isExpanded = true;
    this.#toolbar.classList.remove("collapsed");
    this.#toolbar.classList.add("expanded");
  }

  #collapse() {
    this.#isExpanded = false;
    this.#toolbar.classList.remove("expanded");
    this.#toolbar.classList.add("collapsed");
  }

  /**
   * Show the toolbar for a new selection
   * @param selectionRect Bounding rect of the selection
   */
  showForSelection(
    selectionRect: DOMRect,
    { onAnnotate, onComment, onCopy }: ToolbarCallbacks,
  ) {
    this.#selectionRect = selectionRect;
    this.#currentAnnotation = null;
    this.#onAnnotate = onAnnotate;
    this.#onComment = onComment;
    this.#onCopy = onCopy;
    this.#onDelete = null;

    // Hide delete button for new selections
    this.#toolbar.querySelector(".delete-btn").classList.add("hidden");

    this.#positionToolbar(selectionRect);
    this.#collapse();
    this.#show();
  }

  /**
   * Show the toolbar for an existing annotation
   * @param annotationRect Bounding rect of the annotation
   * @param annotation The annotation data
   * @param callbacks Event callbacks
   */
  showForAnnotation(
    annotationRect: DOMRect,
    annotation: Annotation,
    { onAnnotate, onComment, onDelete, onCopy }: ToolbarCallbacks,
  ) {
    this.#selectionRect = annotationRect;
    this.#currentAnnotation = annotation;
    this.#onAnnotate = onAnnotate;
    this.#onComment = onComment;
    this.#onDelete = onDelete;
    this.#onCopy = onCopy;

    // Set toolbar state to match annotation
    AnnotationToolbar.#lastColor = annotation.color;
    AnnotationToolbar.#lastType = annotation.type;
    this.#updateActiveStates();

    // Show delete button for existing annotations
    this.#toolbar.querySelector(".delete-btn").classList.remove("hidden");

    this.#positionToolbar(annotationRect);
    this.#expand();
    this.#show();
  }

  #positionToolbar(rect: DOMRect) {
    const toolbarWidth = 200;
    const toolbarHeight = 44;
    const margin = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x, y;

    // Default: top-left of selection
    x = rect.left;
    y = rect.top - toolbarHeight - margin;

    // Not enough space above → fall to bottom
    if (y < margin) {
      y = rect.bottom + margin;

      // Not enough below either → clamp to top margin
      if (y + toolbarHeight > viewportHeight - margin) {
        y = margin;
      }
    }

    // Clamp horizontal
    if (x + toolbarWidth > viewportWidth - margin) {
      x = viewportWidth - toolbarWidth - margin;
    }
    x = Math.max(margin, x);

    this.#container.style.left = `${x}px`;
    this.#container.style.top = `${y}px`;
  }

  #show() {
    this.#isVisible = true;
    this.#container.classList.add("visible");
  }

  hide() {
    this.#isVisible = false;
    this.#isExpanded = false;
    this.#container.classList.remove("visible");
    this.#toolbar.classList.remove("expanded");
    this.#toolbar.classList.add("collapsed");
    this.#currentAnnotation = null;
    this.#onAnnotate = null;
    this.#onComment = null;
    this.#onDelete = null;
  }

  get isVisible() {
    return this.#isVisible;
  }

  get currentAnnotation() {
    return this.#currentAnnotation;
  }
}
