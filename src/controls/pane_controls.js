export class PaneControls {
  constructor(pane) {
    this.pane = pane;
    this.element = null;
    this.isHidden = true;
    this.currentProgress = 0;
    this._scrollBound = false;
    this._scrollRAF = null;

    /** @type {Set<Function>} */
    this.scrollCallbacks = new Set();
  }

  attach() {
    this.element = document.createElement("div");
    this.element.className = "pane-controls hidden";
    this.element.style.setProperty("--progress", "0%");
    this.element.innerHTML = `
      <div class="pane-controls-inner">
        <span class="pane-page-info">
          <button class="pane-btn small" data-action="prev">‹</button>
          <span class="pane-current-page">1</span>
          <span class="pane-page-sep">/</span>
          <span class="pane-total-pages">${this.pane.document.numPages}</span>
          <button class="pane-btn small" data-action="next">›</button>
        </span>
        <span class="pane-zoom-controls">
          <button class="pane-btn small" data-action="zoom-out">−</button>
          <span class="pane-zoom-level">100%</span>
          <button class="pane-btn small" data-action="zoom-in">+</button>
        </span>
        <button class="pane-btn small" data-action="fit-width" title="Fit to width">↔</button>
        <span class="pane-mode-toggle">
          <button class="pane-btn small active" data-action="cursor" title="Selection mode"><img src="assets/cursor.svg" width="16" /></button>
          <button class="pane-btn small" data-action="hand-tool" title="Hand tool"><img src="assets/handtool.svg" width="16" /></button>
        </span>
      </div>
    `;

    this.element.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (btn) this.#handleAction(btn.dataset.action);
    });

    this.pane.paneEl.appendChild(this.element);
    this.isHidden = true;
  }

  bindScrollEvents() {
    if (this._scrollBound) return;
    // Coalesce bursts of scroll events into one update per animation frame.
    this.pane.scroller.addEventListener(
      "scroll",
      () => {
        if (this._scrollRAF !== null) return;
        this._scrollRAF = requestAnimationFrame(() => {
          this._scrollRAF = null;
          this.#onScroll();
        });
      },
      { passive: true },
    );
    this._scrollBound = true;
  }

  /**
   * Register a callback to be called on scroll
   * @param {Function} callback
   */
  onScroll(callback) {
    this.scrollCallbacks.add(callback);
  }

  /**
   * Unregister a scroll callback
   * @param {Function} callback
   */
  offScroll(callback) {
    this.scrollCallbacks.delete(callback);
  }

  /**
   * Internal scroll handler - updates own UI and notifies subscribers
   */
  #onScroll() {
    if (!this.isHidden) {
      this.#updatePageDisplay();
      this.#updateProgressFill();
    }

    // Notify all subscribers
    for (const callback of this.scrollCallbacks) {
      callback(this.pane);
    }
  }

  #updateProgressFill() {
    if (!this.element) return;

    const scroller = this.pane.scroller;
    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight - scroller.clientHeight;
    const progress =
      scrollHeight > 0 ? Math.min(1, scrollTop / scrollHeight) : 0;

    this.currentProgress = progress;

    this.element.style.setProperty("--progress", `${progress * 100}%`);

    const isComplete = progress >= 0.98;
    this.element.classList.toggle("progress-complete", isComplete);
  }

  #handleAction(action) {
    switch (action) {
      case "prev":
        this.pane.scrollToRelative(-1);
        break;
      case "next":
        this.pane.scrollToRelative(1);
        break;
      case "zoom-in":
        this.pane.zoom(0.25);
        this.updateZoomDisplay();
        break;
      case "zoom-out":
        this.pane.zoom(-0.25);
        this.updateZoomDisplay();
        break;
      case "fit-width":
        //Only fit width
        this.pane.fit(1, 1);
        this.updateZoomDisplay();
        break;
      case "hand-tool":
        if (!this.pane.handMode) {
          this.pane.toggleHandMode();
          this.#updateModeToggle(true);
        }
        break;
      case "cursor":
        if (this.pane.handMode) {
          this.pane.toggleHandMode();
          this.#updateModeToggle(false);
        }
        break;
    }
  }

  #updateModeToggle(isHandMode) {
    const handBtn = this.element.querySelector('[data-action="hand-tool"]');
    const cursorBtn = this.element.querySelector('[data-action="cursor"]');

    if (isHandMode) {
      handBtn.classList.add("active");
      cursorBtn.classList.remove("active");
    } else {
      handBtn.classList.remove("active");
      cursorBtn.classList.add("active");
    }
  }

  #updatePageDisplay() {
    const current = this.pane.getCurrentPage();
    const el = this.element.querySelector(".pane-current-page");
    if (el) el.textContent = current;
  }

  /**
   * Refresh page-dependent UI when the current page changes off the scroll path.
   */
  notifyPageChange() {
    if (!this.isHidden && this.element) {
      this.#updatePageDisplay();
    }
    for (const callback of this.scrollCallbacks) {
      callback(this.pane);
    }
  }

  updateZoomDisplay() {
    const pct = Math.round(this.pane.scale * 100);
    const el = this.element.querySelector(".pane-zoom-level");
    if (el) el.textContent = `${pct}%`;
  }

  hide() {
    if (this.isHidden) return;
    this.element.classList.add("hidden");
    this.isHidden = true;
  }

  show() {
    if (!this.isHidden) return;
    this.element.classList.remove("hidden");
    this.isHidden = false;

    // Update progress when shown
    requestAnimationFrame(() => {
      this.#updateProgressFill();
    });
  }

  destroy() {
    if (this._scrollRAF !== null) {
      cancelAnimationFrame(this._scrollRAF);
      this._scrollRAF = null;
    }
    this.scrollCallbacks.clear();
    this.element?.remove();
  }
}
