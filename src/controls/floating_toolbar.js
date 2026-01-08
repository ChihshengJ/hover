/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./navigate_tree.js').NavigationTree} NavigationTree;
 */

import { NavigationTree } from "./navigation_tree.js";

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

    this.#scrollCallback = () => this.updatePageNumber();

    this.nightModeAnimating = false;
    this.isJumping = false;

    // Navigation tree state
    this.isTreeOpen = false;
    this.treeOpenThreshold = 100; // Pixels to drag left before tree opens
    this.ballOriginalRight = 35;
    this.ballTreeOpenRight = null; // Calculated based on viewport

    this.#createToolbar();
    /** @type {NavigationTree} */
    this.navigationTree = new NavigationTree(this);
    this.#createHitArea();
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

    // Content layer - sits on top of the ::before pseudo-element
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
      <button class="tool-btn" data-action="horizontal-spread">
        <div class="inner">
          <img src="/assets/book.svg" width="25" />
        </div>
      </button>
      <button class="tool-btn" data-action="split-screen">
        <div class="inner">
          <img src="/assets/split.svg" width="25" />
        </div>
      </button>
      <button class="tool-btn" data-action="night-mode">
        <div class="inner">
          <div>☽</div>
        </div>
      </button>
    `;

    // Bottom half of the toolbar
    this.toolbarBottom = document.createElement("div");
    this.toolbarBottom.className = "floating-toolbar floating-toolbar-bottom";
    this.toolbarBottom.innerHTML = `
      <button class="tool-btn" data-action="fit-width">
        <div class="inner">
          <img src="/assets/fit.svg" width="23" />
        </div>
      </button>
      <button class="tool-btn" data-action="zoom-in">
        <div class="inner">
          <div>+</div>
        </div>
      </button>
      <button class="tool-btn" data-action="zoom-out">
        <div class="inner">
          <div>-</div>
        </div>
      </button>
    `;

    this.wrapper.appendChild(this.toolbarTop);
    this.wrapper.appendChild(this.gooContainer);
    this.wrapper.appendChild(this.toolbarBottom);

    document.body.appendChild(this.wrapper);
    this.wrapper.dataset.state = "collapsed";

    const svgFilter = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svgFilter.style.position = "absolute";
    svgFilter.style.width = "0";
    svgFilter.style.height = "0";
    svgFilter.innerHTML = `
      <defs>
        <filter id="goo" x="-75%" y="-75%" width="250%" height="250%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
          <feColorMatrix in="blur" mode="matrix" 
            values="1 0 0 0 0  
                    0 1 0 0 0  
                    0 0 1 0 0  
                    0 0 0 25 -8" result="goo" />
          <feGaussianBlur in="goo" stdDeviation="3" result="softGlow"/>
          <feComposite in="goo" in2="softGlow" operator="over"/>
        </filter>
      </defs>
    `;
    document.body.appendChild(svgFilter);
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

  #setupEventListeners() {
    // left click - only for double-click to scroll top now
    this.ball.addEventListener("click", (e) => {
      if (!this.wasDragged && !this.isTreeOpen) {
        e.preventDefault();
        this.#handleClick();
      }
      this.wasDragged = false;
    });

    // right click for toolbar expansion
    this.ball.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.isTreeOpen) {
        this.#toggleExpand();
      }
    });

    // drag to scroll (vertical) or open tree (horizontal)
    this.ball.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        this.dragStartTime = Date.now();
        this.wasDragged = false;
        this.#startDrag(e);
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (this.isDragging) {
        this.#handleDrag(e);
      }
    });

    document.addEventListener("mouseup", () => {
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
    if (!this.isExpanded) return;
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
      // Double-click - scroll to top
      this.pane.scrollToTop();
      this.lastClickTime = 0;
    } else {
      // Single click - do nothing now (tree is opened by drag)
      this.lastClickTime = now;
    }
  }

  #updateGooPosition(e) {
    const rect = this.gooContainer.getBoundingClientRect();
    // Need to be bigger than the padding in the pseudo element for more viscosity
    const padding = 45;
    const expandedWidth = rect.width + padding * 2;
    const expandedHeight = rect.height + padding * 2;

    const x = ((e.clientX - rect.left + padding) / expandedWidth) * 100;
    const y = ((e.clientY - rect.top + padding) / expandedHeight) * 100;

    this.gooContainer.style.setProperty("--x", Math.max(0, Math.min(100, x)));
    this.gooContainer.style.setProperty("--y", Math.max(0, Math.min(100, y)));
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
    this.#boundGooUpdate = (e) => this.#updateGooPosition(e);
    document.addEventListener("mousemove", this.#boundGooUpdate);
    this.#updateGooPosition(e);

    this.currentScrollVelocity = 0;
    this.currentDeltaY = 0;
    this.currentDeltaX = 0;

    this.dragMode = null; // 'vertical', 'horizontal', or null

    if (!this.isTreeOpen) {
      this.#showJumpIndicators();
    }
    this.#startScrollLoop();

    e.preventDefault();
  }

  #startScrollLoop() {
    const scrollLoop = () => {
      if (!this.isDragging || this.isJumping) return;
      if (this.currentScrollVelocity !== 0 && this.dragMode === "vertical") {
        this.pane.scroller.scrollTop += this.currentScrollVelocity;
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

    // Determine drag mode on first significant movement
    if (!this.dragMode) {
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        // Horizontal drag takes priority for tree opening
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

  #handleHorizontalDrag(deltaX) {
    const visualDelta = Math.max(-150, Math.min(0, deltaX * 0.8));
    this.gooContainer.style.transform = `translateX(${visualDelta}px)`;
    this.gooContainer.style.transition = "none";

    if (deltaX < -this.treeOpenThreshold && !this.isTreeOpen) {
      this.#openTree();
    }
  }

  #handleTreeDrag(deltaX) {
    if (deltaX > 30) {
      this.#closeTree();
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
    const normalizedDistance = clampedDelta / maxDragDistance; // -1 to 1

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

    const visualDelta = deltaY * 0.8;
    // Move the entire goo container, not just the ball
    this.gooContainer.style.transform = `translateY(${visualDelta}px)`;
    // this.gooContainer.style.transition = "none";

    this.#checkJumpZones(clientY);
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
    document.removeEventListener("mousemove", this.#boundGooUpdate);
    // Reset goo position to center
    this.gooContainer.style.setProperty("--x", 50);
    this.gooContainer.style.setProperty("--y", 50);
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
    this.ballTreeOpenRight = (viewportWidth - ballWidth) / 3;

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
    const rightOffset = parseInt(this.wrapper.style.right) || 35;

    this.jumpIndicators.style.right = `${rightOffset + 38}px`;
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

    const newZone = inTopZone ? "top" : inBottomZone ? "bottom" : null;

    if (newZone !== this.activeJumpZone) {
      if (this.jumpTimeout) {
        clearTimeout(this.jumpTimeout);
        this.jumpTimeout = null;
      }

      // Reset visual states
      this.jumpTopIndicator.classList.remove("active", "triggered");
      this.jumpBottomIndicator.classList.remove("active", "triggered");

      this.activeJumpZone = newZone;

      if (newZone) {
        const indicator =
          newZone === "top" ? this.jumpTopIndicator : this.jumpBottomIndicator;
        indicator.classList.add("active");

        this.jumpTimeout = setTimeout(() => {
          if (this.isDragging && this.activeJumpZone === newZone) {
            indicator.classList.add("triggered");
            this.#executeJump(newZone);
          }
        }, 200);
      }
    }
  }

  #executeJump(direction) {
    this.isJumping = true;
    this.gooContainer.classList.add("jumping");

    if (direction === "top") {
      this.pane.scrollToTop();
    } else {
      this.pane.scrollToBottom();
    }

    setTimeout(() => {
      this.gooContainer.classList.remove("jumping");
      this.isJumping = false;
      this.#endDrag();
    }, 150);
  }

  #updatePosition() {
    const containerRect = this.pane.paneEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;

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
        this.pane.controls.updateZoomDisplay();
        break;
      case "zoom-out":
        this.pane.zoom(-0.25);
        this.pane.controls.updateZoomDisplay();
        break;
      case "night-mode":
        this.#nightmode();
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
        this.pane.fitWidth();
        this.pane.controls.updateZoomDisplay();
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
      0: { src: "public/book.svg", title: "Single page view" },
      1: { src: "public/even.png", title: "Even spread (1-2, 3-4...)" },
      2: { src: "public/odd.png", title: "Odd spread (1, 2-3, 4-5...)" },
    };

    const { src, title } = config[mode];
    img.src = src;
    btn.title = title;
  }

  #nightmode() {
    if (this.nightModeAnimating) return;
    this.nightModeAnimating = true;

    const btn = this.toolbarTop.querySelector('[data-action="night-mode"]');
    const btns = this.wrapper.querySelectorAll(".tool-btn");
    const pageInfo = this.ball.querySelector(".page-display");
    const isCurrentlyNight = document.body.classList.contains("night-mode");
    const scrollPos = this.pane.scroller.scrollTop;

    // floating toolbar animation
    if (isCurrentlyNight) {
      this.ball.classList.remove("night-mode");
      pageInfo.classList.remove("night-mode");
      for (const b of btns) {
        b.classList.remove("night-mode");
        b.firstElementChild.classList.remove("night-mode");
      }
      btn.firstElementChild.firstElementChild.textContent = "☽";
    } else {
      this.ball.classList.add("night-mode");
      for (const b of btns) {
        b.classList.add("night-mode");
        b.firstElementChild.classList.add("night-mode");
      }
      btn.firstElementChild.firstElementChild.textContent = "☼";
      pageInfo.classList.add("night-mode");
    }

    // document body animation
    setTimeout(() => {
      if (isCurrentlyNight) {
        document.body.classList.remove("night-mode");
      } else {
        document.body.classList.add("night-mode");
      }

      this.pane.scroller.scrollTop = scrollPos;
      this.nightModeAnimating = false;
    }, 50);
  }

  updatePageNumber() {
    const currentPage = this.pane.getCurrentPage();
    const totalPages = this.pane.document.pdfDoc?.numPages || "?";

    this.ball.querySelector(".page-current").textContent = currentPage;
    this.ball.querySelector(".page-total").textContent = totalPages;
  }

  updateActivePane() {
    this.pane.scroller.addEventListener("scroll", () => {
      this.updatePageNumber();
    });
  }

  destroy() {
    this.#cancelHideTimer();
    this.navigationTree?.destroy();
    this.hitArea.remove();
    this.wrapper.remove();
  }
}
