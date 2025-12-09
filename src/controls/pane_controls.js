export class PaneControls {
  constructor(pane) {
    this.pane = pane;
    this.element = null;
  }

  attach() {
    this.element = document.createElement("div");
    this.element.className = "pane-controls";
    this.element.innerHTML = `
      <div class="pane-controls-inner">
        <button class="pane-btn" data-action="pin" title="Pin this view">📌</button>
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

    this.pane.viewerEl.addEventListener("scroll", () => {
      this.#updatePageDisplay();
    });

    this.pane.viewerEl.insertBefore(
      this.element,
      this.pane.viewerEl.firstChild,
    );
  }

  #handleAction(action) {
    switch (action) {
      case "pin":
        this.pane.setPinned(!this.pane.isPinned);
        break;
      case "prev":
        this.pane.scrollToRelative(-1);
        break;
      case "next":
        this.pane.scrollToRelative(1);
        break;
      case "zoom-in":
        this.pane.zoom(0.25);
        this.#updateZoomDisplay();
        break;
      case "zoom-out":
        this.pane.zoom(-0.25);
        this.#updateZoomDisplay();
        break;
      case "fit-width":
        this.pane.fitToWidth();
        this.#updateZoomDisplay();
        break;
    }
  }

  #updatePageDisplay() {
    const current = this.pane.getCurrentPage();
    this.element.querySelector(".pane-current-page").textContent = current;
  }

  #updateZoomDisplay() {
    const pct = Math.round(this.pane.scale * 100);
    this.element.querySelector(".pane-zoom-level").textContent = `${pct}%`;
  }

  updatePinState(pinned) {
    const btn = this.element.querySelector('[data-action="pin"]');
    btn.classList.toggle("active", pinned);
  }

  destroy() {
    this.element?.remove();
  }
}
