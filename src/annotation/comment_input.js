/**
 * CommentInput - Popup for entering comments on annotations
 *
 * Replaces the annotation toolbar when comment button is clicked.
 * Themed based on the annotation color.
 */
export class CommentInput {
  static #instance = null;

  /** @type {HTMLElement} */
  #container = null;

  /** @type {HTMLTextAreaElement} */
  #textarea = null;

  /** @type {boolean} */
  #isVisible = false;

  /** @type {Function|null} */
  #onSave = null;

  /** @type {Function|null} */
  #onCancel = null;

  /** @type {string} */
  #currentColor = "yellow";

  constructor() {
    if (CommentInput.#instance) {
      return CommentInput.#instance;
    }
    CommentInput.#instance = this;
    this.#createDOM();
    this.#attachEventListeners();
  }

  static getInstance() {
    if (!CommentInput.#instance) {
      new CommentInput();
    }
    return CommentInput.#instance;
  }

  #createDOM() {
    this.#container = document.createElement("div");
    this.#container.className = "comment-input-container";
    this.#container.innerHTML = `
      <div class="comment-input-popup">
        <div class="comment-input-header">
          <span class="comment-input-title">Add Comment</span>
          <button class="comment-close-btn" title="Cancel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <textarea class="comment-textarea" placeholder="Enter your comment..." rows="3"></textarea>
        <div class="comment-input-actions">
          <button class="comment-cancel-btn">Cancel</button>
          <button class="comment-save-btn">Save</button>
        </div>
      </div>
    `;

    this.#textarea = this.#container.querySelector(".comment-textarea");
    document.body.appendChild(this.#container);
  }

  #attachEventListeners() {
    // Save button
    this.#container
      .querySelector(".comment-save-btn")
      .addEventListener("click", () => {
        this.#save();
      });

    // Cancel buttons
    this.#container
      .querySelector(".comment-cancel-btn")
      .addEventListener("click", () => {
        this.#cancel();
      });

    this.#container
      .querySelector(".comment-close-btn")
      .addEventListener("click", () => {
        this.#cancel();
      });

    // Save on Ctrl+Enter
    this.#textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.#save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.#cancel();
      }
    });

    // Prevent clicks from bubbling
    this.#container.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
  }

  #save() {
    const text = this.#textarea.value.trim();
    if (text) {
      this.#onSave?.(text);
    }
    this.hide();
  }

  #cancel() {
    this.#onCancel?.();
    this.hide();
  }

  /**
   * Show the comment input popup
   * @param {DOMRect} anchorRect - Position to anchor the popup
   * @param {string} color - Annotation color for theming
   * @param {string} existingComment - Existing comment text (for editing)
   * @param {Object} callbacks
   */
  show(anchorRect, color, existingComment = "", { onSave, onCancel }) {
    this.#currentColor = color;
    this.#onSave = onSave;
    this.#onCancel = onCancel;

    // Set color theme
    this.#container.dataset.color = color;

    // Set existing text
    this.#textarea.value = existingComment;

    // Update title
    const title = this.#container.querySelector(".comment-input-title");
    title.textContent = existingComment ? "Edit Comment" : "Add Comment";

    // Position popup
    this.#positionPopup(anchorRect);

    // Show and focus
    this.#isVisible = true;
    this.#container.classList.add("visible");

    // Focus textarea after animation
    setTimeout(() => {
      this.#textarea.focus();
      this.#textarea.setSelectionRange(
        this.#textarea.value.length,
        this.#textarea.value.length,
      );
    }, 100);
  }

  #positionPopup(rect) {
    const popupWidth = 280;
    const popupHeight = 160;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Try to position below the selection
    let x = rect.left + rect.width / 2 - popupWidth / 2;
    let y = rect.bottom + margin;

    // Adjust if off-screen
    if (y + popupHeight > viewportHeight - margin) {
      y = rect.top - popupHeight - margin;
    }

    x = Math.max(margin, Math.min(x, viewportWidth - popupWidth - margin));
    y = Math.max(margin, y);

    this.#container.style.left = `${x}px`;
    this.#container.style.top = `${y}px`;
  }

  hide() {
    this.#isVisible = false;
    this.#container.classList.remove("visible");
    this.#textarea.value = "";
    this.#onSave = null;
    this.#onCancel = null;
  }

  get isVisible() {
    return this.#isVisible;
  }
}
