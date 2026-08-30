/**
 * Handles the fan-out/fan-in animation of the top and bottom toolbar halves,
 * plus the auto-collapse timer that closes the toolbar after a period of
 * inactivity when `autoCollapse` is enabled.
 *
 * The `wrapper.dataset.state` attribute is the single source of truth for
 * the current animation phase: "collapsed" | "expanding" | "expanded" |
 * "collapsing". Other modules (e.g. the tool-button tooltip) read this.
 */
export interface ExpandOptions {
  wrapper: HTMLElement;
  toolbarTop: HTMLElement;
  toolbarBottom: HTMLElement;
  /** Whether the toolbar re-collapses on its own after a pause. */
  autoCollapse: boolean;
}

export class ExpandController {
  wrapper: ExpandOptions["wrapper"];
  toolbarTop: ExpandOptions["toolbarTop"];
  toolbarBottom: ExpandOptions["toolbarBottom"];
  autoCollapse: boolean;
  isExpanded: boolean;
  expandTimer: ReturnType<typeof setTimeout> | null;

  COLLAPSE_DELAY = 7000;

  constructor({
    wrapper,
    toolbarTop,
    toolbarBottom,
    autoCollapse,
  }: ExpandOptions) {
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

  setAutoCollapse(enabled: boolean) {
    this.autoCollapse = enabled;
    if (enabled) {
      if (this.isExpanded) {
        this.startExpandTimer();
      }
    } else {
      this.cancelExpandTimer();
    }
  }

  #animateButtons(state: "expanding" | "collapsing") {
    const topButtons =
      this.toolbarTop.querySelectorAll<HTMLElement>(".tool-btn");
    const bottomButtons =
      this.toolbarBottom.querySelectorAll<HTMLElement>(".tool-btn");

    const animate = (
      buttons: NodeListOf<HTMLElement>,
      reverse: boolean,
      direction: 1 | -1,
    ) => {
      const arr = [...buttons];
      if (reverse) arr.reverse();

      let cumulativeY = 0;
      arr.forEach((btn, i) => {
        const scale = 1.05 - i * 0.17;
        const gap = 5 - i * 8;
        cumulativeY += gap;

        btn.style.setProperty("--btn-delay", `${i * 60}ms`);
        btn.style.setProperty("--btn-scale", String(scale));
        btn.style.setProperty("--btn-y", `${direction * cumulativeY}px`);
      });
    };

    const reverse = state !== "expanding";
    animate(topButtons, reverse, -1);
    animate(bottomButtons, reverse, 1);

    this.wrapper.dataset.state = state;
  }
}
