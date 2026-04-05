/**
 * @typedef {{ id: string, name: string, icon: string, activate: Function, deactivate?: Function }} ToolDescriptor
 */

export class ActionButton {
  static DEFAULT_TOOL_KEY = "hover_action_button_default_tool";

  /** @type {ToolDescriptor[]} */
  #tools;
  /** @type {number} */
  #currentIndex;
  /** @type {HTMLElement} */
  #container;
  /** @type {HTMLButtonElement} */
  #mainBtn;
  /** @type {HTMLSpanElement} */
  #iconSlot;
  /** @type {HTMLButtonElement} */
  #upArrow;
  /** @type {HTMLButtonElement} */
  #downArrow;
  /** @type {boolean} */
  #isAnimating = false;

  /**
   * @param {ToolDescriptor[]} tools
   */
  constructor(tools) {
    this.#tools = tools;

    const defaultId = ActionButton.getDefaultTool();
    const idx = tools.findIndex((t) => t.id === defaultId);
    this.#currentIndex = idx >= 0 ? idx : 0;

    this.#createDOM();
    this.#setupEvents();
  }

  // ╍╍╍ Static Settings ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  static getDefaultTool() {
    try {
      return localStorage.getItem(ActionButton.DEFAULT_TOOL_KEY) || "search";
    } catch {
      return "search";
    }
  }

  static setDefaultTool(toolId) {
    try {
      localStorage.setItem(ActionButton.DEFAULT_TOOL_KEY, toolId);
    } catch (err) {
      console.warn("[ActionButton] Failed to save default tool:", err);
    }

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [ActionButton.DEFAULT_TOOL_KEY]: toolId });
    }
  }

  // ╍╍╍ DOM ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  #createDOM() {
    this.#container = document.createElement("div");
    this.#container.className = "action-btn-container";

    // Up arrow
    this.#upArrow = document.createElement("button");
    this.#upArrow.className = "action-btn-arrow action-btn-arrow-up";
    this.#upArrow.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
        <path fill-rule="evenodd" d="M7.646 4.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1-.708.708L8 5.707l-5.646 5.647a.5.5 0 0 1-.708-.708z"/>
      </svg>
    `;

    // Main button
    this.#mainBtn = document.createElement("button");
    this.#mainBtn.className = "action-btn";

    this.#iconSlot = document.createElement("span");
    this.#iconSlot.className = "action-btn-icon";
    this.#iconSlot.innerHTML = this.#tools[this.#currentIndex].icon;
    this.#mainBtn.appendChild(this.#iconSlot);

    // Down arrow
    this.#downArrow = document.createElement("button");
    this.#downArrow.className = "action-btn-arrow action-btn-arrow-down";
    this.#downArrow.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
        <path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"/>
      </svg>
    `;

    this.#container.appendChild(this.#upArrow);
    this.#container.appendChild(this.#mainBtn);
    this.#container.appendChild(this.#downArrow);
    document.body.appendChild(this.#container);
  }

  #setupEvents() {
    this.#mainBtn.addEventListener("click", () => {
      this.#activateCurrentTool();
    });

    this.#upArrow.addEventListener("click", () => {
      this.#cycleUp();
    });

    this.#downArrow.addEventListener("click", () => {
      this.#cycleDown();
    });
  }

  // ╍╍╍ Cycling ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  #cycleUp() {
    if (this.#isAnimating) return;
    this.#deactivateCurrentTool();
    const prevIndex = this.#currentIndex;
    this.#currentIndex =
      (this.#currentIndex - 1 + this.#tools.length) % this.#tools.length;
    this.#animateTransition(prevIndex, "up");
  }

  #cycleDown() {
    if (this.#isAnimating) return;
    this.#deactivateCurrentTool();
    const prevIndex = this.#currentIndex;
    this.#currentIndex = (this.#currentIndex + 1) % this.#tools.length;
    this.#animateTransition(prevIndex, "down");
  }

  /**
   * @param {number} _prevIndex
   * @param {'up' | 'down'} direction
   */
  #animateTransition(_prevIndex, direction) {
    this.#isAnimating = true;

    const oldIcon = this.#iconSlot;
    const slideOutClass =
      direction === "down" ? "slide-out-up" : "slide-out-down";

    // Create incoming icon
    const newIcon = document.createElement("span");
    newIcon.className = "action-btn-icon";
    newIcon.innerHTML = this.#tools[this.#currentIndex].icon;

    const slideInClass =
      direction === "down" ? "slide-in-from-below" : "slide-in-from-above";
    newIcon.classList.add(slideInClass);

    this.#mainBtn.appendChild(newIcon);

    // Trigger slide-out on old, slide-in on new
    requestAnimationFrame(() => {
      oldIcon.classList.add(slideOutClass);

      requestAnimationFrame(() => {
        newIcon.classList.remove(slideInClass);
      });
    });

    const onEnd = () => {
      oldIcon.remove();
      this.#iconSlot = newIcon;
      this.#isAnimating = false;
    };

    newIcon.addEventListener("transitionend", onEnd, { once: true });

    // Safety fallback in case transitionend doesn't fire
    setTimeout(onEnd, 400);
  }

  // ╍╍╍ Activation ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  #activateCurrentTool() {
    this.#tools[this.#currentIndex].activate();
  }

  #deactivateCurrentTool() {
    const tool = this.#tools[this.#currentIndex];
    if (tool.deactivate) tool.deactivate();
  }

  /**
   * Programmatically activate a tool by ID.
   * Cycles to it (with animation) if not already selected, then activates.
   * @param {string} id
   */
  activateToolById(id) {
    const idx = this.#tools.findIndex((t) => t.id === id);
    if (idx < 0) return;

    if (idx === this.#currentIndex) {
      this.#activateCurrentTool();
      return;
    }

    if (this.#isAnimating) {
      // Skip animation, just switch immediately
      this.#deactivateCurrentTool();
      this.#iconSlot.innerHTML = this.#tools[idx].icon;
      this.#currentIndex = idx;
      this.#activateCurrentTool();
      return;
    }

    this.#deactivateCurrentTool();

    const direction = idx > this.#currentIndex ? "down" : "up";
    const prevIndex = this.#currentIndex;
    this.#currentIndex = idx;
    this.#animateTransition(prevIndex, direction);

    // Activate after animation completes
    const waitForAnimation = () => {
      if (!this.#isAnimating) {
        this.#activateCurrentTool();
      } else {
        requestAnimationFrame(waitForAnimation);
      }
    };
    requestAnimationFrame(waitForAnimation);
  }

  // ╍╍╍ Cleanup ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  destroy() {
    this.#container.remove();
  }
}
