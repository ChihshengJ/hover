export class PaneControls {
  constructor(pane) {
    this.pane = pane;
    this.element = null;
    this.isHidden = false;
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

    this.element.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (btn) this.#handleAction(btn.dataset.action);
    });

    this.pane.scroller.addEventListener("scroll", () => {
      this.#updatePageDisplay();
    });

    this.pane.paneEl.appendChild(this.element);
    this.isHidden = true;
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
  }

  destroy() {
    this.element?.remove();
  }
}
