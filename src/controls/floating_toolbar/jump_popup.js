/**
 * Jump-to-page popup (double-click on the ball opens it) plus the
 * companion "jump to top" circular button that sits to its left.
 *
 * Owns its own DOM and its own outside-click handler.
 */
export class JumpPopup {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.ball   The floating ball element (used for positioning + outside-click exclusion).
   * @param {() => {pages:any[], goToPage:(n:number)=>void, scrollToTop:()=>void, scrollToBottom:()=>void}} opts.getPane
   *    Lazily resolves the currently active pane — the popup may outlive any single pane instance.
   * @param {() => void} [opts.onOpen]  Called right after the popup opens (used to cancel auto-hide timers).
   */
  constructor({ ball, getPane, onOpen }) {
    this.ball = ball;
    this.getPane = getPane;
    this.onOpen = onOpen || (() => {});
    this.isOpen = false;
    this._outsideHandler = null;

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
    this.topBtn.textContent = "↑";
    document.body.appendChild(this.topBtn);

    this.input = this.popup.querySelector(".jump-to-page-input");
  }

  #bindEvents() {
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    this.input.addEventListener("blur", (e) => {
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
      this.getPane().scrollToTop();
      this.close();
    });
  }

  reposition() {
    const rect = this.ball.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    this.popup.style.top = `${centerY}px`;
    this.popup.style.left = `${rect.left - 16}px`;
    this.topBtn.style.top = `${centerY}px`;
    this.topBtn.style.left = `${rect.left - 16}px`;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.input.value = "";
    this.input.max = String(this.getPane().pages.length);
    this.reposition();
    this.popup.classList.add("visible");
    this.topBtn.classList.add("visible");
    requestAnimationFrame(() => this.input.focus());
    this.onOpen();

    // Dismiss on any click outside the popup, the to-top button, or the ball.
    // Defer binding to the next tick so the opening click doesn't close it.
    this._outsideHandler = (e) => {
      if (
        this.popup.contains(e.target) ||
        this.topBtn.contains(e.target) ||
        this.ball.contains(e.target)
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
}
