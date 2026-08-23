/**
 * Coordinates the animation between the floating ball and the navigation
 * tree: on `open()` the ball slides left to about 1/3 of the viewport and
 * the tree slides into view; on `close()` the tree hides and the ball
 * returns to its original right-anchored position.
 *
 * Owns the `isOpen` flag — the facade exposes it as `isTreeOpen`.
 */
export class TreeIntegration {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.wrapper
   * @param {HTMLElement} opts.gooContainer
   * @param {{show: (x: number, onClose: () => void) => void, hide: () => void}} opts.navigationTree
   * @param {{collapse: () => void}} opts.expandController
   * @param {number} opts.ballOriginalRight  The right offset the ball snaps back to when closing.
   */
  constructor({
    wrapper,
    gooContainer,
    navigationTree,
    expandController,
    ballOriginalRight,
  }) {
    this.wrapper = wrapper;
    this.gooContainer = gooContainer;
    this.navigationTree = navigationTree;
    this.expandController = expandController;
    this.ballOriginalRight = ballOriginalRight;

    this.isOpen = false;
    this.ballTreeOpenRight = null;
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;

    // Ball moves to center of window
    const viewportWidth = window.innerWidth;
    const ballWidth = 75;

    this.ballTreeOpenRight = viewportWidth / 3;

    // Calculate where the ball will be after animation
    const ballFinalLeft = viewportWidth - this.ballTreeOpenRight - ballWidth;
    const ballFinalRight = ballFinalLeft + ballWidth;

    // Hide toolbar buttons first
    this.wrapper.classList.add("tree-open");
    this.expandController.collapse();

    // Reset gooContainer transform (from dragging)
    this.gooContainer.style.transition = "transform 0.3s ease";
    this.gooContainer.style.transform = "";

    // Animate ball to new position
    this.wrapper.style.transition = "right 0.4s cubic-bezier(0.4, 0, 0.2, 1)";
    this.wrapper.style.right = `${this.ballTreeOpenRight}px`;

    // Show navigation tree after a brief delay to let ball start moving.
    // The onClose callback fires if the tree closes itself (e.g. user clicks
    // outside) — we need to return the ball to its home position.
    setTimeout(() => {
      this.navigationTree.show(ballFinalRight, () => {
        this.#returnBall();
      });
    }, 50);

    // Cleanup transition after animation
    setTimeout(() => {
      this.wrapper.style.transition = "";
      this.gooContainer.style.transition = "";
    }, 400);
  }

  close() {
    if (!this.isOpen) return;
    this.navigationTree.hide();
  }

  #returnBall() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.wrapper.style.transition = "right 0.4s cubic-bezier(0.1, 0.3, 0.2, 1)";
    this.wrapper.style.right = `${this.ballOriginalRight}px`;
    this.wrapper.classList.remove("tree-open");
    this.gooContainer.style.transition = "transform 0.3s ease";
    this.gooContainer.style.transform = "";
    setTimeout(() => {
      this.wrapper.style.transition = "";
      this.gooContainer.style.transition = "";
    }, 400);
  }
}
