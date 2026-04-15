/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./navigate_tree.js').NavigationTree} NavigationTree;
 */

import { NavigationTree } from "./navigation_tree.js";
import { Settings } from "../settings/settings.js";

export class FloatingToolbar {
  /**
   * @param {SplitWindowManager} wm;
   */

  #boundGooUpdate = null;
  constructor(wm) {
    this.wm = wm;
    this.isExpanded = false;
    this.isDragging = false;
    this.wasDragged = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.scrollStartTop = 0;
    this.lastClickTime = 0;
    this.clickTimeout = null;
    this.dragStartTime = 0;
    this.wrapper = null;

    // Auto-hide state
    this.isHidden = false;
    this.hideTimer = null;
    this.expandTimer = null;
    this.HIDE_DELAY = 3000;
    this.COLLAPSE_DELAY = 7000;
    this.autoCollapse = Settings.isAutoCollapseEnabled();

    this.#scrollCallback = () => this.updatePageNumber();

    this.isJumping = false;

    this._cumulativeRotation = 0;
    this._lastRotateClick = 0;
    this._rotateClickTimeout = null;

    // Navigation tree state
    this.isTreeOpen = false;
    this.treeOpenThreshold = 100; // Pixels to drag left before tree opens
    this.ballOriginalRight = 20;
    this.ballTreeOpenRight = null;

    this.#createToolbar();
    /** @type {NavigationTree} */
    this.navigationTree = new NavigationTree(this);
    this.#createHitArea();
    this.#createJumpPopup();
    this.#setupEventListeners();
    this.#updatePosition();
  }

  /** @type {Function} */
  #scrollCallback = null;

  /** @returns {ViewerPane} */
  get pane() {
    return this.wm.activePane;
  }

  #createToolbar() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "floating-toolbar-wrapper";

    this.gooContainer = document.createElement("div");
    this.gooContainer.className = "goo-container";

    this.ball = document.createElement("div");
    this.ball.className = "floating-ball";
    this.ball.innerHTML = `
      <div class="page-display">
        <span class="page-current">1</span>
        <span class="page-divider">-</span>
        <span class="page-total">?</span>
      </div>
    `;

    this.gooContainer.appendChild(this.ball);

    // Top half of the toolbar
    this.toolbarTop = document.createElement("div");
    this.toolbarTop.className = "floating-toolbar floating-toolbar-top";
    this.toolbarTop.innerHTML = `
      <button class="tool-btn" data-action="horizontal-spread" data-tip-title="Spread Mode" data-tip-desc="Click to cycle: single → even → odd spread">
        <div class="inner">
          <img src="/assets/book.svg" width="25" />
        </div>
      </button>
      <button class="tool-btn" data-action="split-screen" data-tip-title="Split Screen" data-tip-desc="Click to toggle split-screen reading">
        <div class="inner">
          <img src="/assets/split.svg" width="25" />
        </div>
      </button>
      <button class="tool-btn" data-action="rotate" data-tip-title="Rotate" data-tip-desc="Click to rotate 90°, double-click to reset">
        <div class="inner">
          <svg class="rotate-icon" xmlns="http://www.w3.org/2000/svg" width="24" fill="currentColor" class="bi bi-arrow-clockwise" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/>
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/>
          </svg>
        </div>
      </button>
    `;

    // Bottom half of the toolbar
    this.toolbarBottom = document.createElement("div");
    this.toolbarBottom.className = "floating-toolbar floating-toolbar-bottom";
    this.toolbarBottom.innerHTML = `
      <button class="tool-btn" data-action="fit-width" data-tip-title="Fit to View" data-tip-desc="Click to toggle fit width / fit height">
        <div class="inner">
          <img src="/assets/fit_width.svg" width="20" />
        </div>
      </button>
      <button class="tool-btn" data-action="zoom-in" data-tip-title="Zoom In" data-tip-desc="Increase zoom level">
        <div class="inner">
            <img src="/assets/plus.svg" width="24" />
        </div>
      </button>
      <button class="tool-btn" data-action="zoom-out" data-tip-title="Zoom Out" data-tip-desc="Decrease zoom level">
        <div class="inner">
            <img src="/assets/minus.svg" width="24" />
        </div>
      </button>
    `;

    this.wrapper.appendChild(this.toolbarTop);
    this.wrapper.appendChild(this.gooContainer);
    this.wrapper.appendChild(this.toolbarBottom);

    document.body.appendChild(this.wrapper);
    this.wrapper.dataset.state = "collapsed";

    this.#createTooltip();

    const svgFilter = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svgFilter.style.position = "absolute";
    svgFilter.style.width = "0";
    svgFilter.style.height = "0";
    svgFilter.innerHTML = `
      <defs>
        <filter id="goo" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
          <feColorMatrix in="blur" mode="matrix" 
            values="1 0 0 0 0  
                    0 1 0 0 0  
                    0 0 1 0 0  
                    0 0 0 25 -10" result="goo" />
          <feGaussianBlur in="goo" stdDeviation="8" result="softGlow"/>
          <feComposite in="goo" in2="softGlow" operator="over"/>
        </filter>
      </defs>
    `;
    document.body.appendChild(svgFilter);
  }

  #createTooltip() {
    // Only enable on devices with a real pointer (no touch-only)
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
    this._tipShowTimer = null;
    this._tipHideTimer = null;
    this._tipVisible = false;

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

  #createHitArea() {
    this.hitArea = document.createElement("div");
    this.hitArea.className = "floating-toolbar-hit-area";
    document.body.appendChild(this.hitArea);

    this.hitArea.addEventListener("mouseenter", () => {
      this.#slideIn();
    });

    this.hitArea.addEventListener("mouseleave", () => {
      this.#startHideTimer();
    });
  }

  #createJumpPopup() {
    this.jumpPopup = document.createElement("div");
    this.jumpPopup.className = "jump-to-page-popup";
    this.jumpPopup.innerHTML = `
      <label class="jump-to-page-label">to Page:</label>
      <input type="number" class="jump-to-page-input" min="1" inputmode="numeric" />
    `;
    document.body.appendChild(this.jumpPopup);

    this.jumpTopBtn = document.createElement("button");
    this.jumpTopBtn.className = "jump-to-top-btn";
    this.jumpTopBtn.type = "button";
    this.jumpTopBtn.title = "Jump to top";
    this.jumpTopBtn.textContent = "↑";
    document.body.appendChild(this.jumpTopBtn);

    this.jumpInput = this.jumpPopup.querySelector(".jump-to-page-input");
    this.isJumpPopupOpen = false;
  }

  #positionJumpPopup() {
    const rect = this.ball.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    // Popup sits just left of the ball
    this.jumpPopup.style.top = `${centerY}px`;
    this.jumpPopup.style.left = `${rect.left - 16}px`;
    // Jump-to-top button sits further left, as a separate floating circle
    this.jumpTopBtn.style.top = `${centerY}px`;
    this.jumpTopBtn.style.left = `${rect.left - 16}px`;
  }

  #openJumpPopup() {
    if (this.isJumpPopupOpen) {
      this.#closeJumpPopup();
      return;
    }
    this.isJumpPopupOpen = true;
    this.jumpInput.value = "";
    this.jumpInput.max = String(this.pane.pages.length);
    this.#positionJumpPopup();
    this.jumpPopup.classList.add("visible");
    this.jumpTopBtn.classList.add("visible");
    requestAnimationFrame(() => this.jumpInput.focus());
    this.#cancelHideTimer();

    // Dismiss on any click outside the popup, the to-top button, or the ball.
    // Defer binding to the next tick so the opening click doesn't close it.
    this._jumpOutsideHandler = (e) => {
      if (
        this.jumpPopup.contains(e.target) ||
        this.jumpTopBtn.contains(e.target) ||
        this.ball.contains(e.target)
      ) {
        return;
      }
      this.#closeJumpPopup();
    };
    setTimeout(() => {
      if (this.isJumpPopupOpen) {
        document.addEventListener("pointerdown", this._jumpOutsideHandler, true);
      }
    }, 0);
  }

  #closeJumpPopup() {
    this.isJumpPopupOpen = false;
    this.jumpPopup.classList.remove("visible");
    this.jumpTopBtn.classList.remove("visible");
    if (this._jumpOutsideHandler) {
      document.removeEventListener("pointerdown", this._jumpOutsideHandler, true);
      this._jumpOutsideHandler = null;
    }
  }

  #submitJumpPopup() {
    const total = this.pane.pages.length;
    const raw = parseInt(this.jumpInput.value, 10);
    if (Number.isNaN(raw)) {
      this.#closeJumpPopup();
      return;
    }
    if (raw < 1) {
      this.pane.goToPage(1);
    } else if (raw > total) {
      this.pane.scrollToBottom();
    } else {
      this.pane.goToPage(raw);
    }
    this.#closeJumpPopup();
  }

  #setupEventListeners() {
    // Click - only for double-click to scroll top now
    this.ball.addEventListener("click", (e) => {
      if (!this.wasDragged && !this.isTreeOpen) {
        e.preventDefault();
        this.#handleClick();
      }
      this.wasDragged = false;
    });

    // Left click for toolbar expansion
    this.ball.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.isTreeOpen) {
        this.#toggleExpand();
      }
    });

    // drag to scroll (vertical) or open tree (horizontal)
    this.ball.addEventListener("pointerdown", (e) => {
      if (e.button === 0) {
        this.dragStartTime = Date.now();
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
        this.#endDrag();
      }
    });

    this.toolbarTop.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-btn");
      if (btn) {
        this.#handleToolAction(btn.dataset.action);
      }
    });

    this.toolbarBottom.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-btn");
      if (btn) {
        this.#handleToolAction(btn.dataset.action);
      }
    });

    this.toolbarTop.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#collapse();
    });

    this.toolbarBottom.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#collapse();
    });

    window.addEventListener("resize", () => {
      this.#updatePosition();
      if (this.isTreeOpen) {
        this.#closeTree();
      }
      if (this.isJumpPopupOpen) {
        this.#positionJumpPopup();
      }
    });

    this.jumpInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#submitJumpPopup();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.#closeJumpPopup();
      }
    });

    this.jumpInput.addEventListener("blur", (e) => {
      if (this.isJumpPopupOpen && e.relatedTarget !== this.jumpTopBtn) {
        this.#closeJumpPopup();
      }
    });

    this.jumpTopBtn.addEventListener("mousedown", (e) => {
      // Prevent input blur from closing popup before click fires
      e.preventDefault();
    });

    this.jumpTopBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.pane.scrollToTop();
      this.#closeJumpPopup();
    });

    this.pane.controls.onScroll(this.#scrollCallback);
  }

  #startHideTimer() {
    this.#cancelHideTimer();
    this.hideTimer = setTimeout(() => {
      this.#slideOut();
    }, this.HIDE_DELAY);
  }

  #cancelHideTimer() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  #startExpandTimer() {
    if (!this.autoCollapse) return;
    this.#cancelExpandTimer();
    this.expandTimer = setTimeout(() => {
      this.#collapse();
    }, this.COLLAPSE_DELAY);
  }

  #cancelExpandTimer() {
    if (this.expandTimer) {
      clearTimeout(this.expandTimer);
      this.expandTimer = null;
    }
  }

  #slideOut() {
    if (this.isHidden || this.isTreeOpen) return;
    this.isHidden = true;
    this.#collapse();
    this.wrapper.classList.add("hidden");
    setTimeout(() => {
      this.hitArea.classList.add("active");
    }, 500);
    this.#cancelHideTimer();
  }

  #slideIn() {
    if (!this.isHidden) return;
    this.isHidden = false;
    this.wrapper.classList.remove("hidden");
  }

  /**
   * @param {boolean} enabled
   */
  setAutoCollapse(enabled) {
    this.autoCollapse = enabled;
    if (enabled) {
      if (this.isExpanded) {
        this.#startExpandTimer();
      }
    } else {
      this.#cancelExpandTimer();
    }
  }

  enterSplitMode() {
    this.#cancelHideTimer();
    this.#slideOut();
  }

  exitSplitMode() {
    this.hitArea.classList.remove("active");
    this.#cancelHideTimer();
    this.updatePageNumber();
  }

  #toggleExpand() {
    if (this.isExpanded) {
      this.#collapse();
    } else {
      this.#expand();
    }
  }

  #expand() {
    if (this.isExpanded) return;
    this.isExpanded = true;
    this.#animateButtons("expanding");

    setTimeout(() => {
      this.wrapper.dataset.state = "expanded";
    }, 300);

    this.#startExpandTimer();
  }

  #collapse() {
    if (!this.isExpanded || !this.autoCollapse) return;
    this.isExpanded = false;
    this.#animateButtons("collapsing");

    setTimeout(() => {
      this.wrapper.dataset.state = "collapsed";
    }, 300);
  }

  #handleClick() {
    const now = Date.now();
    const timeSinceLastClick = now - this.lastClickTime;

    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
    }

    if (timeSinceLastClick < 220) {
      // Double-click: open jump-to-page popup
      this.#openJumpPopup();
      this.lastClickTime = 0;
    } else {
      // Single click: open toolbar
      this.lastClickTime = now;
      this.clickTimeout = setTimeout(() => {
        this.clickTimeout = null;
        this.#toggleExpand();
      }, 220);
    }
  }

  #startDrag(e) {
    this.#cancelHideTimer();
    this.#cancelExpandTimer();
    this.isDragging = true;
    this.isJumping = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.scrollStartTop = this.pane.scroller.scrollTop;
    this.initialBallY = parseInt(this.ball.style.top) || 0;

    this.gooContainer.classList.add("dragging");

    this.currentScrollVelocity = 0;
    this.currentDeltaY = 0;
    this.currentDeltaX = 0;

    this.dragMode = null;

    // Pending state for rAF batching
    this._pendingTransform = null; // string to apply, or null for no update
    this._pendingGooX = null;
    this._pendingGooY = null;
    this._pendingJumpClientY = null;
    this._pendingTreeOpen = false;

    // Seed initial goo position
    this.#computeGooPosition(e);

    if (!this.isTreeOpen) {
      this.#showJumpIndicators();
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
        this.pane.scroller.scrollTop += this.currentScrollVelocity;
      }

      // 4. Check jump zones (reads layout, but after all writes)
      if (this._pendingJumpClientY !== null) {
        this.#checkJumpZones(this._pendingJumpClientY);
        this._pendingJumpClientY = null;
      }

      // 5. Tree open trigger (deferred from horizontal drag)
      if (this._pendingTreeOpen) {
        this._pendingTreeOpen = false;
        this.#openTree();
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

    // Compute goo position (store, don't write)
    this.#computeGooPosition(e);

    // Determine drag mode on first significant movement
    if (!this.dragMode) {
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        if (deltaX < -15 && Math.abs(deltaX) > Math.abs(deltaY) * 0.7) {
          this.dragMode = "horizontal";
          this.#hideJumpIndicators();
        } else if (Math.abs(deltaY) > 10) {
          this.dragMode = "vertical";
        }
      }
    }

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      this.wasDragged = true;
    }

    if (this.isTreeOpen) {
      this.#handleTreeDrag(deltaX);
      return;
    }

    if (this.dragMode === "horizontal") {
      this.#handleHorizontalDrag(deltaX);
    } else if (this.dragMode === "vertical") {
      this.#handleVerticalDrag(deltaY, e.clientY);
    }
  }

  /** Compute-only: stores goo coords for next rAF, no DOM writes */
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

    if (deltaX < -this.treeOpenThreshold && !this.isTreeOpen) {
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
      this.#closeTree();
    }
  }

  #endDrag() {
    if (this.isJumping) return;

    this.isDragging = false;
    this.currentScrollVelocity = 0;
    this.dragMode = null;

    // Cancel the scroll loop
    if (this.scrollAnimationFrame) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = null;
    }

    // Hide jump indicators
    this.#hideJumpIndicators();

    // Cancel any pending jump
    if (this.jumpTimeout) {
      clearTimeout(this.jumpTimeout);
      this.jumpTimeout = null;
    }

    this.gooContainer.classList.remove("dragging");
    this.gooContainer.style.filter = "";
    this.gooContainer.style.willChange = "";
    document.body.style.cursor = "";

    // If tree is not open, snap gooContainer back
    if (!this.isTreeOpen) {
      this.gooContainer.style.transition =
        "transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
      this.gooContainer.style.transform = "translateY(0) translateX(0)";

      setTimeout(() => {
        this.gooContainer.style.transition = "";
        this.gooContainer.style.transform = "";
      }, 300);
    }

    if (!this.isTreeOpen) {
      this.#startExpandTimer();
      if (this.wm.isSplit) {
        this.#startHideTimer();
      }
    }
  }

  #openTree() {
    if (this.isTreeOpen) return;
    this.isTreeOpen = true;

    // Ball moves to center of window
    const viewportWidth = window.innerWidth;
    const ballWidth = 75;

    // Position ball at center of window
    this.ballTreeOpenRight = viewportWidth / 3;

    // Calculate where the ball will be after animation
    const ballFinalLeft = viewportWidth - this.ballTreeOpenRight - ballWidth;
    const ballFinalRight = ballFinalLeft + ballWidth;

    // Hide toolbar buttons first
    this.wrapper.classList.add("tree-open");
    this.#collapse();

    // Reset gooContainer transform (from dragging)
    this.gooContainer.style.transition = "transform 0.3s ease";
    this.gooContainer.style.transform = "";

    // Animate ball to new position
    this.wrapper.style.transition = "right 0.4s cubic-bezier(0.4, 0, 0.2, 1)";
    this.wrapper.style.right = `${this.ballTreeOpenRight}px`;

    // Show navigation tree after a brief delay to let ball start moving
    // Pass the onClose callback to return ball when tree is closed externally
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

  #returnBall() {
    if (!this.isTreeOpen) return;
    this.isTreeOpen = false;
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

  #closeTree() {
    if (!this.isTreeOpen) return;
    this.navigationTree.hide();
  }

  #createJumpIndicators() {
    // Create container for jump indicators
    this.jumpIndicators = document.createElement("div");
    this.jumpIndicators.className = "jump-indicators";
    this.jumpIndicators.innerHTML = `
      <div class="jump-indicator jump-top" data-direction="top">
         <div>↑</div>
      </div>
      <div class="jump-indicator jump-bottom" data-direction="bottom">
         <div>↓</div>
      </div>
    `;
    document.body.appendChild(this.jumpIndicators);

    this.jumpTopIndicator = this.jumpIndicators.querySelector(".jump-top");
    this.jumpBottomIndicator =
      this.jumpIndicators.querySelector(".jump-bottom");
  }

  #showJumpIndicators() {
    if (!this.jumpIndicators) {
      this.#createJumpIndicators();
    }

    // Position indicators relative to the ball
    const wrapperRect = this.wrapper.getBoundingClientRect();
    const rightOffset = parseInt(this.wrapper.style.right) || 20;

    this.jumpIndicators.style.right = `${rightOffset + 40}px`;
    this.jumpIndicators.style.top = `${wrapperRect.top}px`; // Center on ball

    // Show with animation
    requestAnimationFrame(() => {
      this.jumpIndicators.classList.add("visible");
    });

    this.activeJumpZone = null;
    this.jumpTimeout = null;
  }

  #hideJumpIndicators() {
    if (this.jumpIndicators) {
      this.jumpIndicators.classList.remove("visible");
      this.jumpTopIndicator?.classList.remove("active", "triggered");
      this.jumpBottomIndicator?.classList.remove("active", "triggered");
    }
  }

  #checkJumpZones(mouseY) {
    if (!this.jumpIndicators) return;

    const topRect = this.jumpTopIndicator.getBoundingClientRect();
    const bottomRect = this.jumpBottomIndicator.getBoundingClientRect();

    const inTopZone = mouseY >= topRect.top && mouseY <= topRect.bottom;
    const inBottomZone =
      mouseY >= bottomRect.top && mouseY <= bottomRect.bottom;

    const newZone = inTopZone ? 1 : inBottomZone ? 0 : null;

    if (newZone !== this.activeJumpZone) {
      if (this.jumpTimeout) {
        clearTimeout(this.jumpTimeout);
        this.jumpTimeout = null;
      }

      // Reset visual states
      this.jumpTopIndicator.classList.remove("active", "triggered");
      this.jumpBottomIndicator.classList.remove("active", "triggered");

      this.activeJumpZone = newZone;

      if (newZone !== null) {
        const indicator =
          newZone === 1 ? this.jumpTopIndicator : this.jumpBottomIndicator;
        indicator.classList.add("active");

        this.jumpTimeout = setTimeout(() => {
          if (this.isDragging && this.activeJumpZone === newZone) {
            indicator.classList.add("triggered");
            this.#executeJump(newZone);
          }
        }, 150);
      }
    }
  }

  #executeJump(direction) {
    this.isJumping = true;

    if (direction === 1) {
      this.pane.scrollToTop();
    } else {
      this.pane.scrollToBottom();
    }

    setTimeout(() => {
      this.isJumping = false;
      this.#endDrag();
    }, 200);
  }

  #updatePosition() {
    const containerRect = this.pane.paneEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2 - 37;

    this.wrapper.style.top = `${centerY}px`;
    if (!this.isTreeOpen) {
      this.wrapper.style.right = `${this.ballOriginalRight}px`;
    }

    this.hitArea.style.top = `${centerY - 150}px`; // Extend above
    this.hitArea.style.right = "0";
  }

  #handleToolAction(action) {
    switch (action) {
      case "zoom-in":
        this.pane.zoom(0.25);
        if (!this.pane.controls.isHidden) {
          this.pane.controls.updateZoomDisplay();
        }
        break;
      case "zoom-out":
        this.pane.zoom(-0.25);
        if (!this.pane.controls.isHidden) {
          this.pane.controls.updateZoomDisplay();
        }
        break;
      case "rotate":
        this.#handleRotateClick();
        break;
      case "split-screen":
        if (!this.wm.isSplit) {
          this.wm.split();
        } else {
          this.wm.unsplit();
        }
        break;
      case "horizontal-spread":
        this.#spread();
        break;
      case "fit-width":
        const fitMode = this.pane.fit();
        this.#updateFitIcon(fitMode);
        break;
    }
  }

  #spread() {
    if (!this.wm.isSplit) {
      const newMode = this.pane.spread();
      this.#updateSpreadIcon(newMode);
    }
  }

  #updateSpreadIcon(mode) {
    const btn = this.toolbarTop.querySelector(
      '[data-action="horizontal-spread"]',
    );
    const img = btn.querySelector("img");

    const config = {
      0: { src: "/assets/book.svg", title: "Single page view" },
      1: { src: "/assets/even.png", title: "Even spread (1-2, 3-4...)" },
      2: { src: "/assets/odd.png", title: "Odd spread (1, 2-3, 4-5...)" },
    };

    const { src, title } = config[mode];
    img.src = src;
    btn.title = title;
  }

  #updateFitIcon(fitMode) {
    const btn = this.toolbarBottom.querySelector('[data-action="fit-width"]');
    const img = btn.querySelector("img");

    if (fitMode === 1) {
      img.src = "/assets/fit_width.svg";
      img.width = "20";
      btn.title = "Fit horizontal";
      btn.classList.add("active");
    } else {
      img.src = "/assets/fit_height.svg";
      img.width = "18";
      btn.title = "Fit vertical";
      btn.classList.remove("active");
    }
  }

  #handleRotateClick() {
    const now = Date.now();
    if (this._rotateClickTimeout) {
      clearTimeout(this._rotateClickTimeout);
      this._rotateClickTimeout = null;
    }

    if (now - this._lastRotateClick < 250) {
      // Double-click — reset rotation to 0°
      this.pane.resetRotation();
      // Animate icon back to 0
      this._cumulativeRotation = 0;
      this.#updateRotateIcon();
      this._lastRotateClick = 0;
    } else {
      // Single-click — wait to distinguish from double-click
      this._lastRotateClick = now;
      this._rotateClickTimeout = setTimeout(() => {
        this._rotateClickTimeout = null;
        this.pane.rotate();
        this._cumulativeRotation += 90;
        this.#updateRotateIcon();
      }, 250);
    }
  }

  #updateRotateIcon() {
    const btn = this.toolbarTop.querySelector('[data-action="rotate"]');
    const icon = btn?.querySelector(".rotate-icon");
    if (!icon) return;

    icon.style.transform = `rotate(${this._cumulativeRotation}deg)`;
    btn.classList.toggle("active", this.pane.rotation !== 0);
  }

  updatePageNumber() {
    const currentPage = this.pane.getCurrentPage();
    const totalPages = this.pane.pages.length || "?";

    this.ball.querySelector(".page-current").textContent = currentPage;
    this.ball.querySelector(".page-total").textContent = totalPages;
  }

  updateActivePane() {
    if (this.#scrollCallback) {
      this.pane.controls.offScroll(this.#scrollCallback);
    }
    this.#scrollCallback = () => this.updatePageNumber();
    this.pane.controls.onScroll(this.#scrollCallback);

    // Sync rotation icon with new active pane
    this._cumulativeRotation = this.pane.rotation;
    this.#updateRotateIcon();
  }

  destroy() {
    this.#cancelHideTimer();
    this.navigationTree?.destroy();
    this.hitArea.remove();
    this.wrapper.remove();
  }
}
