/**
 * Top/bottom edge zones that appear to the left of the ball during a
 * vertical drag. Hovering the cursor into one for ~150ms fires a jump to
 * the top or bottom of the document.
 *
 * Owns its own DOM (lazy-created on first show) and the zone-tracking
 * timer. Signals the caller via onExecute when a jump should be applied —
 * the caller is responsible for actually scrolling and ending the drag.
 */
export class JumpIndicators {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.wrapper       Toolbar wrapper (used for positioning reference).
   * @param {() => boolean} opts.isDragging  Predicate — we only fire a jump while still dragging.
   * @param {(direction: 0|1) => void} opts.onExecute
   *    Called when a jump should fire. direction === 1 is top, 0 is bottom.
   */
  constructor({ wrapper, isDragging, onExecute }) {
    this.wrapper = wrapper;
    this.isDragging = isDragging;
    this.onExecute = onExecute;

    this.container = null;
    this.topIndicator = null;
    this.bottomIndicator = null;
    this.activeZone = null;
    this.timeout = null;
  }

  #create() {
    this.container = document.createElement("div");
    this.container.className = "jump-indicators";
    this.container.innerHTML = `
      <div class="jump-indicator jump-top" data-direction="top">
         <div>↑</div>
      </div>
      <div class="jump-indicator jump-bottom" data-direction="bottom">
         <div>↓</div>
      </div>
    `;
    document.body.appendChild(this.container);

    this.topIndicator = this.container.querySelector(".jump-top");
    this.bottomIndicator = this.container.querySelector(".jump-bottom");
  }

  show() {
    if (!this.container) {
      this.#create();
    }

    // Position indicators relative to the ball
    const wrapperRect = this.wrapper.getBoundingClientRect();
    const rightOffset = parseInt(this.wrapper.style.right) || 20;

    this.container.style.right = `${rightOffset + 40}px`;
    this.container.style.top = `${wrapperRect.top}px`;

    requestAnimationFrame(() => {
      this.container.classList.add("visible");
    });

    this.activeZone = null;
    this.timeout = null;
  }

  hide() {
    if (this.container) {
      this.container.classList.remove("visible");
      this.topIndicator?.classList.remove("active", "triggered");
      this.bottomIndicator?.classList.remove("active", "triggered");
    }
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.activeZone = null;
  }

  checkZones(mouseY) {
    if (!this.container) return;

    const topRect = this.topIndicator.getBoundingClientRect();
    const bottomRect = this.bottomIndicator.getBoundingClientRect();

    const inTopZone = mouseY >= topRect.top && mouseY <= topRect.bottom;
    const inBottomZone =
      mouseY >= bottomRect.top && mouseY <= bottomRect.bottom;

    const newZone = inTopZone ? 1 : inBottomZone ? 0 : null;

    if (newZone !== this.activeZone) {
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }

      // Reset visual states
      this.topIndicator.classList.remove("active", "triggered");
      this.bottomIndicator.classList.remove("active", "triggered");

      this.activeZone = newZone;

      if (newZone !== null) {
        const indicator =
          newZone === 1 ? this.topIndicator : this.bottomIndicator;
        indicator.classList.add("active");

        this.timeout = setTimeout(() => {
          if (this.isDragging() && this.activeZone === newZone) {
            indicator.classList.add("triggered");
            this.onExecute(newZone);
          }
        }, 150);
      }
    }
  }
}
