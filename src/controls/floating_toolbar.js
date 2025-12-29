/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('../controls/navigate_toc.js') NavigationPopup};
 */

import { NavigationPopup } from "../controls/navigate_tree.js";

export class FloatingToolbar {
  /**
   * @param {SplitWindowManager} wm;
   */

  constructor(wm) {
    this.wm = wm;
    this.isExpanded = false;
    this.isDragging = false;
    this.wasDragged = false;
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

    this.nightModeAnimating = false;
    this.isJumping = false;

    this.#createToolbar();
    /** @type {NavigationPopup} */
    this.navigationPopup = new NavigationPopup(this);
    this.#createHitArea();
    this.#setupEventListeners();
    this.#updatePosition();
  }

  /** @returns {ViewerPane} */
  get pane() {
    return this.wm.activePane;
  }

  #createToolbar() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "floating-toolbar-wrapper";

    this.ball = document.createElement("div");
    this.ball.className = "floating-ball";
    this.ball.innerHTML = `
      <div class="page-display">
        <span class="page-current">1</span>
        <span class="page-divider">-</span>
        <span class="page-total">?</span>
      </div>
    `;

    let effect = document.createElement("div");
    effect.className = "effect";

    // Top half of the toolbar
    this.toolbarTop = document.createElement("div");
    this.toolbarTop.className = "floating-toolbar floating-toolbar-top";
    this.toolbarTop.innerHTML = `
      <button class="tool-btn" data-action="horizontal-spread">
        <div class="inner">
          <img src="public/book.svg" width="25" />
        </div>
        <div class="effect"></div>
      </button>
      <button class="tool-btn" data-action="split-screen">
        <div class="inner">
          <img src="public/split.svg" width="25" />
        </div>
        <div class="effect"></div>
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
          <img src="public/fit.svg" width="23" />
        </div>
        <div class="effect"></div>
      </button>
      <button class="tool-btn" data-action="zoom-in">
        <div class="inner">
          <div>+</div>
        </div>
        <div class="effect"></div>
      </button>
      <button class="tool-btn" data-action="zoom-out">
        <div class="inner">
          <div>-</div>
        </div>
      </button>
    `;

    this.wrapper.appendChild(this.toolbarTop);
    this.wrapper.appendChild(this.ball);
    this.wrapper.appendChild(this.toolbarBottom);
    this.ball.appendChild(effect);
    document.body.appendChild(this.wrapper);
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
    // left click for page options
    this.ball.addEventListener("click", (e) => {
      if (!this.wasDragged) {
        e.preventDefault();
        this.#handleClick();
      }
      this.wasDragged = false;
    });

    // right click for toolbar expansion
    this.ball.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#toggleExpand();
    });

    // drag to scroll
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
    });

    this.pane.scroller.addEventListener("scroll", () => {
      this.updatePageNumber();
    });
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
    if (this.isHidden) return;
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
    this.wrapper.classList.remove("collapsing");
    this.wrapper.classList.add("expanding");

    setTimeout(() => {
      this.wrapper.classList.remove("expanding");
      this.wrapper.classList.add("expanded");
    }, 500);

    this.#startExpandTimer();
  }

  #collapse() {
    if (!this.isExpanded) return;
    this.isExpanded = false;
    this.wrapper.classList.remove("expanded", "expanding");
    this.wrapper.classList.add("collapsing");

    setTimeout(() => {
      this.wrapper.classList.remove("collapsing");
    }, 600);
  }

  #handleClick() {
    const now = Date.now();
    const timeSinceLastClick = now - this.lastClickTime;

    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
    }

    if (timeSinceLastClick < 220) {
      // The number here is for double-click interval
      this.navigationPopup.hide();
      this.pane.scrollToTop();
      this.lastClickTime = 0;
    } else {
      this.clickTimeout = setTimeout(() => {
        this.navigationPopup.toggle();
        this.clickTimeout = null;
      }, 100); // The number here is for single click timeout

      this.lastClickTime = now;
    }
  }

  #startDrag(e) {
    this.#cancelHideTimer();
    this.#cancelExpandTimer();
    this.isDragging = true;
    this.isJumping = false;
    this.dragStartY = e.clientY;
    this.scrollStartTop = this.pane.scroller.scrollTop;
    this.initialBallY = parseInt(this.ball.style.top) || 0;
    this.ball.classList.add("dragging");
    document.body.style.cursor = "grabbing";
    
    this.currentScrollVelocity = 0;
    this.currentDeltaY = 0;
    
    this.#showJumpIndicators();
    this.#startScrollLoop();
    
    e.preventDefault();
  }

  #startScrollLoop() {
    const scrollLoop = () => {
      if (!this.isDragging || this.isJumping) return;
      if (this.currentScrollVelocity !== 0) {
        this.pane.scroller.scrollTop += this.currentScrollVelocity;
      }
      this.scrollAnimationFrame = requestAnimationFrame(scrollLoop);
    };
    this.scrollAnimationFrame = requestAnimationFrame(scrollLoop);
  }

  #handleDrag(e) {
    const deltaY = e.clientY - this.dragStartY;
    this.currentDeltaY = deltaY;

    // Mark as dragged if moved more than 5px
    if (Math.abs(deltaY) > 5) {
      this.wasDragged = true;
    }
    
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
      Math.min(maxDragDistance, effectiveDelta)
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
    
    // Store velocity for continuous scrolling (TrackPoint style)
    this.currentScrollVelocity = scrollMultiplier * maxScrollSpeed;

    // Visual feedback - ball follows mouse
    const visualDelta = deltaY * 0.7;
    this.ball.style.transform = `translateY(${visualDelta}px)`;
    this.ball.style.transition = "none";
    
    // Check for jump zone hover
    this.#checkJumpZones(e.clientY);
  }

  #endDrag() {
    if (this.isJumping) return;

    this.isDragging = false;
    this.currentScrollVelocity = 0;
    
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
    
    this.ball.classList.remove("dragging");
    document.body.style.cursor = "";

    this.ball.style.transition =
      "transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
    this.ball.style.transform = "translateY(0)";

    setTimeout(() => {
      this.ball.style.transition = "";
      this.ball.style.transform = "";
    }, 300);
    
    this.#startExpandTimer();
    if (this.wm.isSplit) {
      this.#startHideTimer();
    }
  }

  #createJumpIndicators() {
    // Create container for jump indicators
    this.jumpIndicators = document.createElement("div");
    this.jumpIndicators.className = "jump-indicators";
    this.jumpIndicators.innerHTML = `
      <div class="jump-indicator jump-top" data-direction="top">
         <div>⇈</div>
      </div>
      <div class="jump-indicator jump-bottom" data-direction="bottom">
         <div>⇊</div>
      </div>
    `;
    document.body.appendChild(this.jumpIndicators);
    
    this.jumpTopIndicator = this.jumpIndicators.querySelector(".jump-top");
    this.jumpBottomIndicator = this.jumpIndicators.querySelector(".jump-bottom");
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
      this.jumpTopIndicator.classList.remove("active", "triggered");
      this.jumpBottomIndicator.classList.remove("active", "triggered");
    }
  }

  #checkJumpZones(mouseY) {
    if (!this.jumpIndicators) return;
    
    const topRect = this.jumpTopIndicator.getBoundingClientRect();
    const bottomRect = this.jumpBottomIndicator.getBoundingClientRect();
    
    const inTopZone = mouseY >= topRect.top && mouseY <= topRect.bottom;
    const inBottomZone = mouseY >= bottomRect.top && mouseY <= bottomRect.bottom;
    
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
        const indicator = newZone === "top" ? this.jumpTopIndicator : this.jumpBottomIndicator;
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
    this.ball.classList.add("jumping");
    
    if (direction === "top") {
      this.pane.scrollToTop();
    } else {
      this.pane.scrollToBottom();
    }
    
    setTimeout(() => {
      this.ball.classList.remove("jumping");
      this.isJumping = false;
      this.#endDrag();
    }, 150);
  }


  #updatePosition() {
    const containerRect = this.pane.paneEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2 - 35;

    this.wrapper.style.top = `${centerY}px`;
    this.wrapper.style.right = "35px";

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
      btn.firstElementChild.firstElementChild.textContent = "☀";
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
    this.hitArea.remove();
    this.wrapper.remove();
  }
}
