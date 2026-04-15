/**
 * Handles all pointer-driven gestures on the floating ball:
 *   - Vertical drag   → scrolls the active pane at a curved velocity.
 *   - Horizontal drag → translates the goo container left, and once past
 *                       `treeOpenThreshold` requests the navigation tree.
 *   - Edge-zone jumps → top/bottom zones trigger scrollToTop / scrollToBottom
 *                       via the JumpIndicators collaborator.
 *
 * Inside a single rAF the controller batches all DOM writes (goo deformation
 * variables, transform, scroll) before any reads (jump-zone hit-test). That
 * ordering is load-bearing — don't split this loop across modules.
 *
 * The facade reads `isDragging` / `dragMode` / `wasDragged` as getters and
 * clears `wasDragged` after each click.
 */
export class DragController {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.ball
   * @param {HTMLElement} opts.gooContainer
   * @param {() => any} opts.getPane
   * @param {() => boolean} opts.isTreeOpen
   * @param {{show: () => void, hide: () => void, checkZones: (y: number) => void}} opts.jumpIndicators
   * @param {number} opts.treeOpenThreshold
   * @param {Object} opts.hooks
   * @param {() => void} opts.hooks.onDragStart           Called at the start of a drag (cancel timers etc.).
   * @param {() => void} opts.hooks.onDragEnd             Called after a drag ends and the ball has snapped back.
   * @param {() => void} opts.hooks.onTreeOpenRequested   Called when the horizontal threshold is crossed.
   * @param {() => void} opts.hooks.onTreeCloseRequested  Called when user drags the ball back while the tree is open.
   */
  constructor({
    ball,
    gooContainer,
    getPane,
    isTreeOpen,
    jumpIndicators,
    treeOpenThreshold,
    hooks,
  }) {
    this.ball = ball;
    this.gooContainer = gooContainer;
    this.getPane = getPane;
    this.isTreeOpen = isTreeOpen;
    this.jumpIndicators = jumpIndicators;
    this.treeOpenThreshold = treeOpenThreshold;
    this.hooks = hooks;

    this.isDragging = false;
    this.isJumping = false;
    this.wasDragged = false;
    this.dragMode = null;

    this.dragStartX = 0;
    this.dragStartY = 0;
    this.currentDeltaX = 0;
    this.currentDeltaY = 0;
    this.currentScrollVelocity = 0;
    this.scrollAnimationFrame = null;

    // rAF-batched pending writes — see class comment.
    this._pendingTransform = null;
    this._pendingGooX = null;
    this._pendingGooY = null;
    this._pendingJumpClientY = null;
    this._pendingTreeOpen = false;
  }

  init() {
    this.ball.addEventListener("pointerdown", (e) => {
      if (e.button === 0) {
        this.wasDragged = false;
        this.#startDrag(e);
      }
    });

    document.addEventListener("pointermove", (e) => {
      if (this.isDragging) {
        this.#handleDrag(e);
      }
    });

    document.addEventListener("pointerup", () => {
      if (this.isDragging) {
        this.endDrag();
      }
    });
  }

  clearWasDragged() {
    this.wasDragged = false;
  }

  /** Called by JumpIndicators via its onExecute callback. */
  executeJump(direction) {
    this.isJumping = true;
    const pane = this.getPane();
    if (direction === 1) {
      pane.scrollToTop();
    } else {
      pane.scrollToBottom();
    }
    setTimeout(() => {
      this.isJumping = false;
      this.endDrag();
    }, 200);
  }

  #startDrag(e) {
    this.hooks.onDragStart();
    this.isDragging = true;
    this.isJumping = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    this.gooContainer.classList.add("dragging");

    this.currentScrollVelocity = 0;
    this.currentDeltaY = 0;
    this.currentDeltaX = 0;
    this.dragMode = null;

    this._pendingTransform = null;
    this._pendingGooX = null;
    this._pendingGooY = null;
    this._pendingJumpClientY = null;
    this._pendingTreeOpen = false;

    this.#computeGooPosition(e);

    if (!this.isTreeOpen()) {
      this.jumpIndicators.show();
    }
    this.#startScrollLoop();

    e.preventDefault();
  }

  #startScrollLoop() {
    const scrollLoop = () => {
      if (!this.isDragging || this.isJumping) return;

      // --- Single DOM-write phase per frame ---

      // 1. Apply goo custom properties
      if (this._pendingGooX !== null) {
        this.gooContainer.style.setProperty("--x", this._pendingGooX);
        this.gooContainer.style.setProperty("--y", this._pendingGooY);
        this._pendingGooX = null;
        this._pendingGooY = null;
      }

      // 2. Apply transform
      if (this._pendingTransform !== null) {
        this.gooContainer.style.transform = this._pendingTransform;
        this._pendingTransform = null;
      }

      // 3. Apply scroll
      if (this.currentScrollVelocity !== 0 && this.dragMode === "vertical") {
        this.getPane().scroller.scrollTop += this.currentScrollVelocity;
      }

      // 4. Check jump zones (reads layout, but after all writes)
      if (this._pendingJumpClientY !== null) {
        this.jumpIndicators.checkZones(this._pendingJumpClientY);
        this._pendingJumpClientY = null;
      }

      // 5. Tree open trigger (deferred from horizontal drag)
      if (this._pendingTreeOpen) {
        this._pendingTreeOpen = false;
        this.hooks.onTreeOpenRequested();
      }

      this.scrollAnimationFrame = requestAnimationFrame(scrollLoop);
    };
    this.scrollAnimationFrame = requestAnimationFrame(scrollLoop);
  }

  #handleDrag(e) {
    const deltaX = e.clientX - this.dragStartX;
    const deltaY = e.clientY - this.dragStartY;
    this.currentDeltaX = deltaX;
    this.currentDeltaY = deltaY;

    this.#computeGooPosition(e);

    // Determine drag mode on first significant movement
    if (!this.dragMode) {
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        if (deltaX < -15 && Math.abs(deltaX) > Math.abs(deltaY) * 0.7) {
          this.dragMode = "horizontal";
          this.jumpIndicators.hide();
        } else if (Math.abs(deltaY) > 10) {
          this.dragMode = "vertical";
        }
      }
    }

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      this.wasDragged = true;
    }

    if (this.isTreeOpen()) {
      this.#handleTreeDrag(deltaX);
      return;
    }

    if (this.dragMode === "horizontal") {
      this.#handleHorizontalDrag(deltaX);
    } else if (this.dragMode === "vertical") {
      this.#handleVerticalDrag(deltaY, e.clientY);
    }
  }

  /** Compute-only: stores goo coords for next rAF, no DOM writes. */
  #computeGooPosition(e) {
    const rect = this.gooContainer.getBoundingClientRect();
    const padding = 45;
    const expandedWidth = rect.width + padding * 2;
    const expandedHeight = rect.height + padding * 2;

    const x = ((e.clientX - rect.left + padding) / expandedWidth) * 100;
    const y = ((e.clientY - rect.top + padding) / expandedHeight) * 100;

    this._pendingGooX = Math.max(0, Math.min(100, x));
    this._pendingGooY = Math.max(0, Math.min(100, y));
  }

  #handleHorizontalDrag(deltaX) {
    const visualDelta = Math.max(-150, Math.min(0, deltaX * 0.8));
    this._pendingTransform = `translateX(${visualDelta}px)`;

    if (deltaX < -this.treeOpenThreshold && !this.isTreeOpen()) {
      this._pendingTreeOpen = true;
    }
  }

  #handleVerticalDrag(deltaY, clientY) {
    const deadZone = 10;
    const maxDragDistance = 100;

    let effectiveDelta = deltaY;
    if (Math.abs(deltaY) < deadZone) {
      effectiveDelta = 0;
    } else {
      effectiveDelta = deltaY - Math.sign(deltaY) * deadZone;
    }

    const clampedDelta = Math.max(
      -maxDragDistance,
      Math.min(maxDragDistance, effectiveDelta),
    );
    const normalizedDistance = clampedDelta / maxDragDistance;

    let scrollMultiplier;
    const mvRange = Math.abs(normalizedDistance);
    if (mvRange < 0.5) {
      scrollMultiplier = mvRange * 2;
    } else if (mvRange < 0.8) {
      scrollMultiplier = 0.6 + Math.pow((mvRange - 0.3) / 0.4, 1.5) * 2;
    } else {
      scrollMultiplier = 2.6 + Math.pow((mvRange - 0.7) / 0.3, 2) * 10;
    }

    scrollMultiplier *= Math.sign(normalizedDistance);
    const maxScrollSpeed = 20;
    this.currentScrollVelocity = scrollMultiplier * maxScrollSpeed;

    this._pendingTransform = `translateY(${deltaY * 0.8}px)`;
    this._pendingJumpClientY = clientY;
  }

  #handleTreeDrag(deltaX) {
    if (deltaX > 30) {
      this.hooks.onTreeCloseRequested();
    }
  }

  endDrag() {
    if (this.isJumping) return;

    this.isDragging = false;
    this.currentScrollVelocity = 0;
    this.dragMode = null;

    if (this.scrollAnimationFrame) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = null;
    }

    // Hide jump indicators (also clears any pending jump timer)
    this.jumpIndicators.hide();

    this.gooContainer.classList.remove("dragging");
    this.gooContainer.style.filter = "";
    this.gooContainer.style.willChange = "";
    document.body.style.cursor = "";

    // If tree is not open, snap gooContainer back
    if (!this.isTreeOpen()) {
      this.gooContainer.style.transition =
        "transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
      this.gooContainer.style.transform = "translateY(0) translateX(0)";

      setTimeout(() => {
        this.gooContainer.style.transition = "";
        this.gooContainer.style.transform = "";
      }, 300);
    }

    this.hooks.onDragEnd();
  }
}
