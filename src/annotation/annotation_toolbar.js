/**
 * AnnotationToolbar - Floating toolbar for creating annotations
 *
 * Appears when text is selected, allows user to:
 * - Choose highlight or underline
 * - Pick a color (yellow, red, blue, green)
 * - Add a comment
 * - Delete annotation (when editing existing)
 */
export class AnnotationToolbar {
  static #instance = null;

  // Remember user preferences
  static #lastColor = "yellow";
  static #lastType = "highlight";

  /** @type {HTMLElement} */
  #container = null;

  /** @type {HTMLElement} */
  #toolbar = null;

  /** @type {boolean} */
  #isVisible = false;

  /** @type {boolean} */
  #isExpanded = false;

  /** @type {Function|null} */
  #onAnnotate = null;

  /** @type {Function|null} */
  #onComment = null;

  /** @type {Function|null} */
  #onDelete = null;

  /** @type {Object|null} */
  #currentAnnotation = null;

  /** @type {DOMRect|null} */
  #selectionRect = null;

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
            <img src='/assets/highlight.png' width='25'></img>
          </button>
          <button class="action-btn" data-action="underline" title="Underline">
            <img src='/assets/underline.png' width='25'></img>
          </button>
          <button class="action-btn" data-action="comment" title="Add Comment">
            <img src='/assets/comment.png' width='25'></img>
          </button>
          <button class="action-btn delete-btn hidden" data-action="delete" title="Delete">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <!-- Placeholder: delete icon -->
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
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
    this.#toolbar.querySelectorAll(".color-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const color = btn.dataset.color;
        AnnotationToolbar.#lastColor = color;
        this.#updateActiveStates();
        this.#triggerAnnotation();
      });
    });

    // Action buttons
    this.#toolbar.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;

        if (action === "highlight" || action === "underline") {
          AnnotationToolbar.#lastType = action;
          this.#updateActiveStates();
          this.#triggerAnnotation();
        } else if (action === "comment") {
          this.#onComment?.();
        } else if (action === "delete") {
          this.#onDelete?.();
          this.hide();
        }
      });
    });

    // Expand on hover when collapsed
    this.#toolbar.addEventListener("mouseenter", () => {
      if (!this.#isExpanded) {
        this.#expand();
      }
    });

    // Prevent clicks inside toolbar from closing it
    this.#toolbar.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
  }

  #updateActiveStates() {
    // Update toolbar data-color for collapsed ball
    this.#toolbar.dataset.color = AnnotationToolbar.#lastColor;

    // Update color buttons
    this.#toolbar.querySelectorAll(".color-btn").forEach((btn) => {
      btn.classList.toggle(
        "active",
        btn.dataset.color === AnnotationToolbar.#lastColor,
      );
    });

    // Update action buttons
    this.#toolbar
      .querySelectorAll(
        '.action-btn[data-action="highlight"], .action-btn[data-action="underline"]',
      )
      .forEach((btn) => {
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
   * @param {DOMRect} selectionRect - Bounding rect of the selection
   * @param {Object} callbacks - Event callbacks
   * @param {Function} callbacks.onAnnotate - Called when annotation is created
   * @param {Function} callbacks.onComment - Called when comment button clicked
   */
  showForSelection(selectionRect, { onAnnotate, onComment }) {
    this.#selectionRect = selectionRect;
    this.#currentAnnotation = null;
    this.#onAnnotate = onAnnotate;
    this.#onComment = onComment;
    this.#onDelete = null;

    // Hide delete button for new selections
    this.#toolbar.querySelector(".delete-btn").classList.add("hidden");

    this.#positionToolbar(selectionRect);
    this.#collapse();
    this.#show();
  }

  /**
   * Show the toolbar for an existing annotation
   * @param {DOMRect} annotationRect - Bounding rect of the annotation
   * @param {Object} annotation - The annotation data
   * @param {Object} callbacks - Event callbacks
   */
  showForAnnotation(
    annotationRect,
    annotation,
    { onAnnotate, onComment, onDelete },
  ) {
    this.#selectionRect = annotationRect;
    this.#currentAnnotation = annotation;
    this.#onAnnotate = onAnnotate;
    this.#onComment = onComment;
    this.#onDelete = onDelete;

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

  #positionToolbar(rect) {
    const toolbarWidth = 200; // Approximate expanded width
    const toolbarHeight = 44;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x, y;
    let position = "bottom"; // 'bottom', 'right', 'left', 'top'

    x = rect.left + rect.width / 2 - toolbarWidth / 2;
    y = rect.bottom + margin;

    if (y + toolbarHeight > viewportHeight - margin) {
      y = rect.top - toolbarHeight - margin;
      position = "top";

      if (y < margin) {
        x = rect.right + margin;
        y = rect.top + rect.height / 2 - toolbarHeight / 2;
        position = "right";

        if (x + toolbarWidth > viewportWidth - margin) {
          x = rect.left - toolbarWidth - margin;
          position = "left";

          if (x < margin) {
            x = rect.left + rect.width / 2 - toolbarWidth / 2;
            y = rect.bottom + margin;
            position = "bottom";
          }
        }
      }
    }

    x = Math.max(margin, Math.min(x, viewportWidth - toolbarWidth - margin));

    this.#container.style.left = `${x}px`;
    this.#container.style.top = `${y}px`;
    this.#container.dataset.position = position;
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
