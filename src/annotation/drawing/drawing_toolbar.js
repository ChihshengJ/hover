/**
 * DrawingToolbar - Color and stroke width picker for drawing mode.
 * Appears to the left of the action button with the same height.
 * Styled as a smaller version of the annotation toolbar.
 */
export class DrawingToolbar {
  /** @type {HTMLElement|null} */
  #container = null;

  /** @type {string} */
  #activeColor = "black";

  /** @type {string} */
  #activeWidth = "medium";

  /** @type {Function} */
  #onColorChange;

  /** @type {Function} */
  #onWidthChange;

  static COLORS = ["black", "yellow", "red", "blue", "green"];

  static WIDTHS = [
    { name: "thin", label: "Thin", thickness: 1 },
    { name: "medium", label: "Medium", thickness: 2.5 },
    { name: "thick", label: "Thick", thickness: 5 },
  ];

  /**
   * @param {Object} callbacks
   * @param {Function} callbacks.onColorChange
   * @param {Function} callbacks.onWidthChange
   */
  constructor({ onColorChange, onWidthChange }) {
    this.#onColorChange = onColorChange;
    this.#onWidthChange = onWidthChange;
    this.#createDOM();
  }

  #createDOM() {
    this.#container = document.createElement("div");
    this.#container.className = "drawing-toolbar";

    // Color buttons
    const colorsDiv = document.createElement("div");
    colorsDiv.className = "drawing-toolbar-colors";

    for (const color of DrawingToolbar.COLORS) {
      const btn = document.createElement("button");
      btn.className = "drawing-color-btn";
      btn.dataset.color = color;
      btn.title = color.charAt(0).toUpperCase() + color.slice(1);

      const circle = document.createElement("span");
      circle.className = `drawing-color-circle ${color}`;
      btn.appendChild(circle);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setColor(color);
        this.#onColorChange(color);
      });

      colorsDiv.appendChild(btn);
    }

    // Divider
    const divider = document.createElement("div");
    divider.className = "drawing-toolbar-divider";

    // Width buttons
    const widthsDiv = document.createElement("div");
    widthsDiv.className = "drawing-toolbar-widths";

    for (const w of DrawingToolbar.WIDTHS) {
      const btn = document.createElement("button");
      btn.className = "drawing-width-btn";
      btn.dataset.width = w.name;
      btn.title = w.label;

      // Squiggle/stroke icon showing the thickness
      btn.innerHTML = `<svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 11 C 5 3, 8 3, 10 7 C 12 11, 15 11, 18 4" stroke-width="${w.thickness}"/>
      </svg>`;

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setWidth(w.name);
        this.#onWidthChange(w.name);
      });

      widthsDiv.appendChild(btn);
    }

    this.#container.appendChild(colorsDiv);
    this.#container.appendChild(divider);
    this.#container.appendChild(widthsDiv);

    // Prevent pointer events from propagating to scroller
    this.#container.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.#updateActiveStates();
  }

  /**
   * Show the toolbar positioned to the left of the given anchor element.
   * @param {HTMLElement} anchorEl - The action button container
   */
  show(anchorEl) {
    if (!this.#container) return;
    document.body.appendChild(this.#container);

    // Align with the main button, not the full container (which includes arrows)
    const mainBtn = anchorEl.querySelector(".action-btn") || anchorEl;
    const btnRect = mainBtn.getBoundingClientRect();
    const toolbarWidth = this.#container.offsetWidth || 260;
    const toolbarHeight = this.#container.offsetHeight || 34;

    // Vertically center the toolbar with the main button
    this.#container.style.top = `${btnRect.top + (btnRect.height - toolbarHeight) / 2}px`;
    this.#container.style.left = `${btnRect.left - toolbarWidth - 8}px`;

    // Trigger animation
    requestAnimationFrame(() => {
      this.#container.classList.add("visible");
    });
  }

  hide() {
    if (!this.#container) return;
    this.#container.classList.remove("visible");
  }

  /**
   * @param {string} colorName
   */
  setColor(colorName) {
    this.#activeColor = colorName;
    this.#updateActiveStates();
  }

  /**
   * @param {string} widthName
   */
  setWidth(widthName) {
    this.#activeWidth = widthName;
    this.#updateActiveStates();
  }

  #updateActiveStates() {
    if (!this.#container) return;

    this.#container.querySelectorAll(".drawing-color-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color === this.#activeColor);
    });

    this.#container.querySelectorAll(".drawing-width-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.width === this.#activeWidth);
    });
  }

  destroy() {
    if (this.#container) {
      this.#container.remove();
      this.#container = null;
    }
  }
}
