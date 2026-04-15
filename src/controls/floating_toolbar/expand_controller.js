/**
 * Handles the fan-out/fan-in animation of the top and bottom toolbar halves,
 * plus the auto-collapse timer that closes the toolbar after a period of
 * inactivity when `autoCollapse` is enabled.
 *
 * The `wrapper.dataset.state` attribute is the single source of truth for
 * the current animation phase: "collapsed" | "expanding" | "expanded" |
 * "collapsing". Other modules (e.g. the tool-button tooltip) read this.
 */
export class ExpandController {
  COLLAPSE_DELAY = 7000;

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.wrapper
   * @param {HTMLElement} opts.toolbarTop
   * @param {HTMLElement} opts.toolbarBottom
   * @param {boolean} opts.autoCollapse  Initial value for the auto-collapse setting.
   */
  constructor({ wrapper, toolbarTop, toolbarBottom, autoCollapse }) {
    this.wrapper = wrapper;
    this.toolbarTop = toolbarTop;
    this.toolbarBottom = toolbarBottom;
    this.autoCollapse = autoCollapse;

    this.isExpanded = false;
    this.expandTimer = null;
  }

  toggle() {
    if (this.isExpanded) this.collapse();
    else this.expand();
  }

  expand() {
    if (this.isExpanded) return;
    this.isExpanded = true;
    this.#animateButtons("expanding");

    setTimeout(() => {
      this.wrapper.dataset.state = "expanded";
    }, 300);

    this.startExpandTimer();
  }

  collapse() {
    if (!this.isExpanded || !this.autoCollapse) return;
    this.isExpanded = false;
    this.#animateButtons("collapsing");

    setTimeout(() => {
      this.wrapper.dataset.state = "collapsed";
    }, 300);
  }

  startExpandTimer() {
    if (!this.autoCollapse) return;
    this.cancelExpandTimer();
    this.expandTimer = setTimeout(() => {
      this.collapse();
    }, this.COLLAPSE_DELAY);
  }

  cancelExpandTimer() {
    if (this.expandTimer) {
      clearTimeout(this.expandTimer);
      this.expandTimer = null;
    }
  }

  /** @param {boolean} enabled */
  setAutoCollapse(enabled) {
    this.autoCollapse = enabled;
    if (enabled) {
      if (this.isExpanded) {
        this.startExpandTimer();
      }
    } else {
      this.cancelExpandTimer();
    }
  }

  #animateButtons(state) {
    const topButtons = this.toolbarTop.querySelectorAll(".tool-btn");
    const bottomButtons = this.toolbarBottom.querySelectorAll(".tool-btn");

    const animate = (buttons, reverse, direction) => {
      const arr = [...buttons];
      if (reverse) arr.reverse();

      let cumulativeY = 0;
      arr.forEach((btn, i) => {
        const scale = 1.05 - i * 0.17;
        const gap = 5 - i * 8;
        cumulativeY += gap;

        btn.style.setProperty("--btn-delay", `${i * 60}ms`);
        btn.style.setProperty("--btn-scale", scale);
        btn.style.setProperty("--btn-y", `${direction * cumulativeY}px`);
      });
    };

    const reverse = state !== "expanding";
    animate(topButtons, reverse, -1);
    animate(bottomButtons, reverse, 1);

    this.wrapper.dataset.state = state;
  }
}
