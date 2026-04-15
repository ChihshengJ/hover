/**
 * Hides the floating toolbar after a period of inactivity (mainly for
 * split-screen mode, where the ball is in the way). Creates an invisible
 * hit area along the right edge that the user can hover into to bring
 * the toolbar back.
 */
export class AutoHideController {
  HIDE_DELAY = 3000;

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.wrapper            Toolbar wrapper (the thing that slides out).
   * @param {() => boolean} opts.isTreeOpen       Predicate — don't slide out while the nav tree is open.
   * @param {() => void} opts.onSlideOutCollapse  Called when slide-out begins, so the toolbar can also collapse.
   */
  constructor({ wrapper, isTreeOpen, onSlideOutCollapse }) {
    this.wrapper = wrapper;
    this.isTreeOpen = isTreeOpen;
    this.onSlideOutCollapse = onSlideOutCollapse;

    this.isHidden = false;
    this.hideTimer = null;
    this.hitArea = null;
  }

  init() {
    this.hitArea = document.createElement("div");
    this.hitArea.className = "floating-toolbar-hit-area";
    document.body.appendChild(this.hitArea);

    this.hitArea.addEventListener("mouseenter", () => {
      this.slideIn();
    });

    this.hitArea.addEventListener("mouseleave", () => {
      this.startHideTimer();
    });
  }

  startHideTimer() {
    this.cancelHideTimer();
    this.hideTimer = setTimeout(() => {
      this.slideOut();
    }, this.HIDE_DELAY);
  }

  cancelHideTimer() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  slideOut() {
    if (this.isHidden || this.isTreeOpen()) return;
    this.isHidden = true;
    this.onSlideOutCollapse();
    this.wrapper.classList.add("hidden");
    setTimeout(() => {
      this.hitArea.classList.add("active");
    }, 500);
    this.cancelHideTimer();
  }

  slideIn() {
    if (!this.isHidden) return;
    this.isHidden = false;
    this.wrapper.classList.remove("hidden");
  }

  enterSplitMode() {
    this.cancelHideTimer();
    this.slideOut();
  }

  exitSplitMode() {
    this.hitArea.classList.remove("active");
    this.cancelHideTimer();
  }

  /** Position the invisible hit area to match the wrapper's vertical center. */
  reposition(wrapperCenterY) {
    this.hitArea.style.top = `${wrapperCenterY - 150}px`;
    this.hitArea.style.right = "0";
  }

  destroy() {
    this.cancelHideTimer();
    this.hitArea?.remove();
  }
}
