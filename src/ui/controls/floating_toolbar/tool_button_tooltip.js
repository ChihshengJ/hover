/**
 * Hover tooltip for .tool-btn elements inside the floating toolbar wrapper.
 * Skips attachment on touch-only devices (no hover pointer).
 *
 * The tooltip only shows while the toolbar is in the "expanded" state, which
 * is signalled via `wrapper.dataset.state === "expanded"`.
 */
export class ToolButtonTooltip {
  /**
   * @param {HTMLElement} wrapper  The floating-toolbar wrapper element.
   */
  constructor(wrapper) {
    this.wrapper = wrapper;
    this.tooltip = null;
    this._tipTitle = null;
    this._tipDesc = null;
    this._tipShowTimer = null;
    this._tipHideTimer = null;
    this._tipVisible = false;
  }

  attach() {
    if (!window.matchMedia("(hover: hover)").matches) return;

    this.tooltip = document.createElement("div");
    this.tooltip.className = "tool-btn-tooltip";
    this.tooltip.innerHTML = `
      <div class="tool-btn-tooltip-title"></div>
      <div class="tool-btn-tooltip-desc"></div>
    `;
    document.body.appendChild(this.tooltip);

    this._tipTitle = this.tooltip.querySelector(".tool-btn-tooltip-title");
    this._tipDesc = this.tooltip.querySelector(".tool-btn-tooltip-desc");

    const showTip = (btn) => {
      if (this.wrapper.dataset.state !== "expanded") return;
      const title = btn.dataset.tipTitle;
      const desc = btn.dataset.tipDesc;
      if (!title) return;

      clearTimeout(this._tipHideTimer);
      this._tipHideTimer = null;

      this._tipTitle.textContent = title;
      this._tipDesc.textContent = desc;

      const rect = btn.getBoundingClientRect();
      this.tooltip.style.top = `${rect.top + rect.height / 2}px`;
      this.tooltip.style.left = `${rect.left - 10}px`;

      if (this._tipVisible) {
        // Already showing — reposition instantly, no delay
        return;
      }

      clearTimeout(this._tipShowTimer);
      this._tipShowTimer = setTimeout(() => {
        this._tipVisible = true;
        this.tooltip.classList.add("visible");
      }, 300);
    };

    const hideTip = () => {
      clearTimeout(this._tipShowTimer);
      // Short grace period so moving between buttons doesn't flicker
      this._tipHideTimer = setTimeout(() => {
        this._tipVisible = false;
        this.tooltip.classList.remove("visible");
      }, 80);
    };

    for (const btn of this.wrapper.querySelectorAll(".tool-btn")) {
      btn.addEventListener("mouseenter", () => showTip(btn));
      btn.addEventListener("mouseleave", hideTip);
    }
  }
}
