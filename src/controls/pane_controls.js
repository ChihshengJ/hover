export class PaneControls {
  constructor(pane) {
    this.pane = pane;
    this.element = null;
    this.isHidden = false;
    this.progressRing = null;
    this.currentProgress = 0;
    this.ringPerimeter = 0;

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
        <button class="pane-btn" data-action="fit-width" title="Fit to width">↔</button>
      </div>
    `;

    // Create progress ring SVG
    this.#createProgressRing();

    this.element.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (btn) this.#handleAction(btn.dataset.action);
    });

    // Single scroll listener for this pane - notifies all subscribers
    this.pane.scroller.addEventListener("scroll", () => {
      this.#onScroll();
    });

    this.pane.paneEl.appendChild(this.element);
    this.isHidden = true;
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
    // Update own UI
    this.#updatePageDisplay();
    this.#updateProgressRing();

    // Notify all subscribers
    for (const callback of this.scrollCallbacks) {
      callback(this.pane);
    }
  }

  #createProgressRing() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('pane-progress-ring');

    // We'll use a path for the rounded rectangle to get proper stroke animation
    svg.innerHTML = `
      <defs>
        <linearGradient id="progress-grad-${this.pane.id}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" class="progress-grad-start" />
          <stop offset="100%" class="progress-grad-end" />
        </linearGradient>
      </defs>
      <rect class="progress-ring-bg" x="1" y="1" rx="19" ry="19" />
      <rect class="progress-ring-fill" x="1" y="1" rx="19" ry="19" />
      <rect class="progress-ring-glow" x="1" y="1" rx="19" ry="19" />
    `;

    this.progressRing = svg;
    this.element.appendChild(svg);

    // Initial size update will happen when shown
    this.#updateRingDimensions();
  }

  #updateRingDimensions() {
    if (!this.progressRing || !this.element) return;

    // Get the control bar dimensions after it's in the DOM
    requestAnimationFrame(() => {
      const rect = this.element.getBoundingClientRect();
      if (rect.width === 0) return;

      const width = rect.width + 6;
      const height = rect.height + 6;

      this.progressRing.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.progressRing.style.width = `${width}px`;
      this.progressRing.style.height = `${height}px`;

      const rects = this.progressRing.querySelectorAll('rect');
      rects.forEach(r => {
        r.setAttribute('width', width - 2);
        r.setAttribute('height', height - 2);
      });

      // Calculate perimeter for stroke-dasharray
      // Approximate perimeter of rounded rect: 2*(w-2r) + 2*(h-2r) + 2*pi*r
      const r = 19;
      const perimeter = 2 * (width - 2 - 2 * r) + 2 * (height - 2 - 2 * r) + 2 * Math.PI * r;
      this.ringPerimeter = perimeter;

      // Set initial dash array
      const fill = this.progressRing.querySelector('.progress-ring-fill');
      const glow = this.progressRing.querySelector('.progress-ring-glow');
      if (fill) {
        fill.style.strokeDasharray = `0 ${perimeter}`;
        fill.style.strokeDashoffset = perimeter / 4; // Start from top
      }
      if (glow) {
        glow.style.strokeDasharray = `0 ${perimeter}`;
        glow.style.strokeDashoffset = perimeter / 4;
      }
    });
  }

  #updateProgressRing() {
    if (!this.progressRing || !this.ringPerimeter) return;

    const scroller = this.pane.scroller;
    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight - scroller.clientHeight;
    const progress = scrollHeight > 0 ? Math.min(1, scrollTop / scrollHeight) : 0;

    this.currentProgress = progress;

    const dashLength = progress * this.ringPerimeter;
    const fill = this.progressRing.querySelector('.progress-ring-fill');
    const glow = this.progressRing.querySelector('.progress-ring-glow');

    if (fill) {
      fill.style.strokeDasharray = `${dashLength} ${this.ringPerimeter}`;
    }
    if (glow) {
      glow.style.strokeDasharray = `${dashLength} ${this.ringPerimeter}`;
    }

    // Check for completion
    const isComplete = progress >= 0.98;
    this.progressRing.classList.toggle('completed', isComplete);
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
        this.pane.fitWidth?.();
        this.updateZoomDisplay();
        break;
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
