export class PaneControls {
  constructor(pane) {
    this.pane = pane;
    this.element = null;
    this.isHidden = false;
    this.progressRing = null;
    this.currentProgress = 0;
    this.ringPerimeter = 0;
    this._scrollBound = false;

    /** @type {Set<Function>} */
    this.scrollCallbacks = new Set();
  }

  attach() {
    this.element = document.createElement("div");
    this.element.className = "pane-controls hidden";
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
          <button class="pane-btn small active" data-action="cursor" title="Selection mode"><img src="/assets/cursor.svg" width="16" /></button>
          <button class="pane-btn small" data-action="hand-tool" title="Hand tool"><img src="/assets/handtool.svg" width="16" /></button>
        </span>
      </div>
    `;

    this.#createProgressRing();

    this.element.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (btn) this.#handleAction(btn.dataset.action);
    });

    this.pane.paneEl.appendChild(this.element);
    this.isHidden = true;
  }

  bindScrollEvents() {
    if (this._scrollBound) return;
    this.pane.scroller.addEventListener("scroll", () => {
      this.#onScroll();
    });
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
      this.#updateProgressRing();
    }

    // Notify all subscribers
    for (const callback of this.scrollCallbacks) {
      callback(this.pane);
    }
  }

  #getRoundedRectPath(w, h, r) {
    const x = 1;
    const y = 1;
    const startX = x + w / 2;
    const startY = y + h;

    return [
      `M ${startX} ${startY}`,
      `H ${x + w - r}`,
      `A ${r} ${r} 0 0 0 ${x + w} ${y + h - r}`,
      `V ${y + r}`,
      `A ${r} ${r} 0 0 0 ${x + w - r} ${y}`,
      `H ${x + r}`,
      `A ${r} ${r} 0 0 0 ${x} ${y + r}`,
      `V ${y + h - r}`,
      `A ${r} ${r} 0 0 0 ${x + r} ${y + h}`,
      `H ${startX}`,
    ].join(" ");
  }

  #createProgressRing() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("pane-progress-ring");

    svg.innerHTML = `
      <defs>
        <linearGradient id="progress-grad-${this.pane.id}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" class="progress-grad-start" />
          <stop offset="100%" class="progress-grad-end" />
        </linearGradient>
      </defs>
      <path class="progress-ring-bg" />
      <path class="progress-ring-fill" />
      <path class="progress-ring-glow" />
    `;

    this.progressRing = svg;
    this.element.appendChild(svg);
    this.#updateRingDimensions();
  }

  #updateRingDimensions() {
    if (!this.progressRing || !this.element) return;

    requestAnimationFrame(() => {
      const rect = this.element.getBoundingClientRect();
      if (rect.width === 0) return;

      const width = rect.width + 2;
      const height = rect.height + 6;

      this.progressRing.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.progressRing.style.width = `${width}px`;
      this.progressRing.style.height = `${height}px`;

      const r = 19;
      const w = width;
      const h = height - 2;
      const pathD = this.#getRoundedRectPath(w, h, r);

      // Update all paths with the same d attribute
      const paths = this.progressRing.querySelectorAll("path");
      paths.forEach((p) => {
        p.setAttribute("d", pathD);
      });

      // Calculate perimeter: 2 straights + 2 straights + 4 quarter circles
      const perimeter = (w - 2 * r) * 2 + (h - 2 * r) * 2 + 2 * Math.PI * r;
      this.ringPerimeter = perimeter;

      // Set initial dash array
      const fill = this.progressRing.querySelector(".progress-ring-fill");
      const glow = this.progressRing.querySelector(".progress-ring-glow");
      if (fill) {
        fill.style.strokeDasharray = `0 ${perimeter}`;
      }
      if (glow) {
        glow.style.strokeDasharray = `0 ${perimeter}`;
      }
    });
  }

  #updateProgressRing() {
    if (!this.progressRing || !this.ringPerimeter) return;

    const scroller = this.pane.scroller;
    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight - scroller.clientHeight;
    const progress =
      scrollHeight > 0 ? Math.min(1, scrollTop / scrollHeight) : 0;

    this.currentProgress = progress;

    const dashLength = progress * this.ringPerimeter;
    const fill = this.progressRing.querySelector(".progress-ring-fill");
    const glow = this.progressRing.querySelector(".progress-ring-glow");

    if (fill) {
      fill.style.strokeDasharray = `${dashLength} ${this.ringPerimeter}`;
    }
    if (glow) {
      glow.style.strokeDasharray = `${dashLength} ${this.ringPerimeter}`;
    }

    // Check for completion
    const isComplete = progress >= 0.98;
    this.progressRing.classList.toggle("completed", isComplete);
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

    // Update dimensions when shown
    requestAnimationFrame(() => {
      this.#updateRingDimensions();
      this.#updateProgressRing();
    });
  }

  destroy() {
    this.scrollCallbacks.clear();
    this.element?.remove();
  }
}
