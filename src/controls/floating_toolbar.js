/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 */

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
    this.nightModeClip = document.createElement("div");
    this.nightModeClip.id = "night-mode-clip";
    document.body.appendChild(this.nightModeClip);

    this.#createToolbar();
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
        <div class="effect"></div>
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
        <div class="effect"></div>
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
      this.pane.scrollToTop();
      this.lastClickTime = 0;
    } else {
      this.clickTimeout = setTimeout(() => {
        this.pane.scrollToRelative(1);
        this.clickTimeout = null;
      }, 100); // The number here is for single click timeout

      this.lastClickTime = now;
    }
  }

  #startDrag(e) {
    this.#cancelHideTimer();
    this.#cancelExpandTimer();
    this.isDragging = true;
    this.dragStartY = e.clientY;
    this.scrollStartTop = this.pane.scroller.scrollTop;
    this.initialBallY = parseInt(this.ball.style.top) || 0;
    this.ball.classList.add("dragging");
    document.body.style.cursor = "grabbing";
    e.preventDefault();
  }

  #handleDrag(e) {
    const deltaY = e.clientY - this.dragStartY;

    //mark as dragged if moved more than 5px
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
      Math.min(maxDragDistance, effectiveDelta),
    );
    const normalizedDistance = clampedDelta / maxDragDistance; // -1 to 1
    let scrollMultiplier;
    const mvRange = Math.abs(normalizedDistance);
    if (mvRange < 0.5) {
      //small move
      scrollMultiplier = mvRange * 2;
    } else if (mvRange < 0.8) {
      //medium move
      scrollMultiplier = 0.6 + Math.pow((mvRange - 0.3) / 0.4, 1.5) * 2;
    } else {
      scrollMultiplier = 2.6 + Math.pow((mvRange - 0.7) / 0.3, 2) * 10;
    }

    scrollMultiplier *= Math.sign(normalizedDistance);
    const maxScrollSpeed = 20;
    const scrollDelta = scrollMultiplier * maxScrollSpeed;
    const visualDelta = deltaY * 0.7;
    this.ball.style.transform = `translateY(${visualDelta}px)`;
    this.ball.style.transition = "none";

    // apply non-linear scroll
    this.pane.scroller.scrollTop += scrollDelta;
  }

  #endDrag() {
    this.isDragging = false;
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

  #updatePosition() {
    const containerRect = this.pane.scroller.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;

    this.wrapper.style.top = `${centerY}px`;
    this.wrapper.style.right = "35px";

    this.hitArea.style.top = `${centerY - 150}px`; // Extend above
    this.hitArea.style.right = "0";
  }

  #handleToolAction(action) {
    switch (action) {
      case "zoom-in":
        this.pane.zoom(0.25);
        break;
      case "zoom-out":
        this.pane.zoom(-0.25);
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
    }
  }

  #spread() {
    if (!this.wm.isSplit) {
      const newMode = this.pane.spread();
      this.#updateSpreadIcon(newMode);
    }
  }

  #updateSpreadIcon(mode) {
    const btn = this.toolbarTop.querySelector('[data-action="horizontal-spread"]');
    const img = btn.querySelector('img');

    const config = {
      0: { src: 'public/book.svg', title: 'Single page view' },
      1: { src: 'public/even.png', title: 'Even spread (1-2, 3-4...)' },
      2: { src: 'public/odd.png', title: 'Odd spread (1, 2-3, 4-5...)' },
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

    const rect = btn.getBoundingClientRect();
    const clipX = rect.left + rect.width / 2;
    const clipY = rect.top + rect.height / 2;

    this.nightModeClip.style.setProperty("--clip-x", `${clipX}px`);
    this.nightModeClip.style.setProperty("--clip-y", `${clipY}px`);

    const clone = this.pane.scroller.cloneNode(true);
    clone.style.position = "fixed";
    clone.style.inset = "0";

    // Right now it's cloning every canvas, needs to come up with a way to only clone visible canvases
    const originalCanvases = this.pane.scroller.querySelectorAll("canvas");
    const clonedCanvases = clone.querySelectorAll("canvas");
    originalCanvases.forEach((original, i) => {
      const cloned = clonedCanvases[i];
      if (cloned && original.width > 0 && original.height > 0) {
        cloned.width = original.width;
        cloned.height = original.height;
        const ctx = cloned.getContext("2d");
        ctx.drawImage(original, 0, 0);
      }
    });

    // set cloned canvases to night mode
    if (isCurrentlyNight) {
      clone.classList.remove("night-mode-content");
      this.nightModeClip.classList.add("to-light");
      this.nightModeClip.classList.remove("to-dark");
    } else {
      clone.classList.add("night-mode-content");
      this.nightModeClip.classList.add("to-dark");
      this.nightModeClip.classList.remove("to-light");
    }

    this.nightModeClip.innerHTML = "";
    this.nightModeClip.appendChild(clone);
    clone.scrollTop = scrollPos;

    const syncScroll = () => {
      clone.scrollTop = this.pane.scroller.scrollTop;
    };
    this.pane.scroller.addEventListener("scroll", syncScroll);

    this.nightModeClip.classList.remove("anim");
    void this.nightModeClip.offsetWidth;
    this.nightModeClip.classList.add("anim");

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
      this.nightModeClip.classList.remove("anim", "to-light", "to-dark");
      this.nightModeClip.innerHTML = "";
      this.pane.scroller.removeEventListener("scroll", syncScroll);
      this.nightModeAnimating = false;
    }, 800);
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
