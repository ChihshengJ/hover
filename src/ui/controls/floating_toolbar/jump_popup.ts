import type { ViewerPane } from "../../../viewer/viewpane.js";

/**
 * Jump-to-page popup (double-click on the ball opens it) plus the
 * companion "jump to top" circular button that sits to its left.
 *
 * Owns its own DOM and its own outside-click handler.
 */
const DIRECTION_DEBOUNCE_MS = 200;

export interface JumpPopupOptions {
  ball: HTMLElement;
  getPane: () => ViewerPane | null;
  /** Called when the popup opens, so the owner can stand its own timers down. */
  onOpen?: () => void;
}

export class JumpPopup {
  ball: JumpPopupOptions["ball"];
  getPane: JumpPopupOptions["getPane"];
  onOpen: JumpPopupOptions["onOpen"];
  isOpen: boolean;
  _outsideHandler: ((e: MouseEvent) => void) | null;
  _directionTimer: ReturnType<typeof setTimeout> | null;
  popup: HTMLDivElement;
  topBtn: HTMLButtonElement;
  input: HTMLInputElement;

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.ball   The floating ball element (used for positioning + outside-click exclusion).
   * @param {() => ViewerPane} opts.getPane
   *    Lazily resolves the currently active pane — the popup may outlive any single pane instance.
   * @param {() => void} [opts.onOpen]  Called right after the popup opens (used to cancel auto-hide timers).
   */
  constructor({ ball, getPane, onOpen }: JumpPopupOptions) {
    this.ball = ball;
    this.getPane = getPane;
    this.onOpen = onOpen || (() => {});
    this.isOpen = false;
    this._outsideHandler = null;
    this._directionTimer = null;

    this.#createDom();
    this.#bindEvents();
  }

  #createDom() {
    this.popup = document.createElement("div");
    this.popup.className = "jump-to-page-popup";
    this.popup.innerHTML = `
      <label class="jump-to-page-label">to Page:</label>
      <input type="number" class="jump-to-page-input" min="1" inputmode="numeric" />
    `;
    document.body.appendChild(this.popup);

    this.topBtn = document.createElement("button");
    this.topBtn.className = "jump-to-top-btn";
    this.topBtn.type = "button";
    this.topBtn.title = "Jump to top";
    this.topBtn.innerHTML = `<span class="jump-to-top-btn-icon">↑</span>`;
    document.body.appendChild(this.topBtn);

    this.input = this.popup.querySelector(
      ".jump-to-page-input",
    ) as HTMLInputElement;
  }

  /**
   * The two chrome elements that carry the popup's material. Both sit on
   * <body> rather than inside the toolbar wrapper, so GlassEffect has to
   * mirror data-glass onto them for liquid_glass.css to reach them.
   * @returns {HTMLElement[]}
   */
  get glassElements() {
    return [this.popup, this.topBtn];
  }

  #bindEvents() {
    this.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    this.input.addEventListener("blur", (e: FocusEvent) => {
      if (this.isOpen && e.relatedTarget !== this.topBtn) {
        this.close();
      }
    });

    this.topBtn.addEventListener("mousedown", (e) => {
      // Prevent input blur from closing popup before click fires
      e.preventDefault();
    });

    this.topBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (this.input.value.trim() === "") {
        this.getPane().scrollToTop();
        this.close();
      } else {
        this.#submit();
      }
    });

    this.input.addEventListener("input", () => {
      const hasInput = this.input.value.trim() !== "";
      this.topBtn.title = hasInput ? "Jump to page" : "Jump to top";
      // Reset the arrow while the user is actively typing; it settles
      // again after DIRECTION_DEBOUNCE_MS of quiet.
      this.topBtn.classList.remove("direction-down");
      if (this._directionTimer) {
        clearTimeout(this._directionTimer);
        this._directionTimer = null;
      }
      if (hasInput) {
        this._directionTimer = setTimeout(() => {
          this._directionTimer = null;
          this.#updateDirection();
        }, DIRECTION_DEBOUNCE_MS);
      }
    });
  }

  reposition() {
    const rect = this.ball.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const GAP_TO_BALL = 16;
    const GAP_POPUP_TO_BTN = 16;

    // topBtn sits immediately to the left of the ball
    const topBtnLeft = rect.left - GAP_TO_BALL - this.topBtn.offsetWidth;
    // popup sits to the left of the topBtn
    const popupLeft = topBtnLeft - GAP_POPUP_TO_BTN - this.popup.offsetWidth;

    this.topBtn.style.top = `${centerY}px`;
    this.topBtn.style.left = `${topBtnLeft}px`;
    this.popup.style.top = `${centerY}px`;
    this.popup.style.left = `${popupLeft}px`;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.input.value = "";
    this.topBtn.title = "Jump to top";
    this.topBtn.classList.remove("direction-down");
    this.input.max = String(this.getPane().pages.length);
    this.reposition();
    this.popup.classList.add("visible");
    this.topBtn.classList.add("visible");
    requestAnimationFrame(() => this.input.focus());
    this.onOpen();

    // Dismiss on any click outside the popup, the to-top button, or the ball.
    // Defer binding to the next tick so the opening click doesn't close it.
    this._outsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        this.popup.contains(target) ||
        this.topBtn.contains(target) ||
        this.ball.contains(target)
      ) {
        return;
      }
      this.close();
    };
    setTimeout(() => {
      if (this.isOpen) {
        document.addEventListener("pointerdown", this._outsideHandler, true);
      }
    }, 0);
  }

  close() {
    this.isOpen = false;
    this.popup.classList.remove("visible");
    this.topBtn.classList.remove("visible");
    this.topBtn.classList.remove("direction-down");
    if (this._directionTimer) {
      clearTimeout(this._directionTimer);
      this._directionTimer = null;
    }
    if (this._outsideHandler) {
      document.removeEventListener("pointerdown", this._outsideHandler, true);
      this._outsideHandler = null;
    }
  }

  #submit() {
    const pane = this.getPane();
    const total = pane.pages.length;
    const raw = parseInt(this.input.value, 10);
    if (Number.isNaN(raw)) {
      this.close();
      return;
    }
    if (raw < 1) {
      pane.goToPage(1);
    } else if (raw > total) {
      pane.scrollToBottom();
    } else {
      pane.goToPage(raw);
    }
    this.close();
  }

  #updateDirection() {
    const pane = this.getPane();
    const raw = parseInt(this.input.value, 10);
    if (Number.isNaN(raw)) return;

    const total = pane.pages.length;
    const target = Math.min(Math.max(raw, 1), total);
    const current = pane.getCurrentPage();

    this.topBtn.classList.toggle("direction-down", target > current);
  }
}
