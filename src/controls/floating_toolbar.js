export class FloatingToolbar {
  constructor(viewer, viewerContainer) {
    this.viewer = viewer;
    this.viewerContainer = viewerContainer;
    this.isExpanded = false;
    this.isDragging = false;
    this.wasDragged = false;
    this.dragStartY = 0;
    this.scrollStartTop = 0;
    this.lastClickTime = 0;
    this.clickTimeout = null;
    this.dragStartTime = 0;
    this.wrapper = null;

    this.#createToolbar();
    this.#setupEventListeners();
    this.#updatePosition();
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

    // Create toolbar buttons above
    this.toolbarTop = document.createElement("div");
    this.toolbarTop.className = "floating-toolbar floating-toolbar-top";
    this.toolbarTop.innerHTML = `
      <button class="tool-btn" data-action="drag">D</button>
      <button class="tool-btn" data-action="select">\T</button>
    `;

    // Create toolbar buttons below
    this.toolbarBottom = document.createElement("div");
    this.toolbarBottom.className = "floating-toolbar floating-toolbar-bottom";
    this.toolbarBottom.innerHTML = `
      <button class="tool-btn" data-action="zoom-in">+</button>
      <button class="tool-btn" data-action="zoom-out">-</button>
    `;

    this.wrapper.appendChild(this.toolbarTop);
    this.wrapper.appendChild(this.ball);
    this.wrapper.appendChild(this.toolbarBottom);
    this.ball.appendChild(effect);
    document.body.appendChild(this.wrapper);
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

    // Update page number on scroll
    this.viewerContainer.addEventListener("scroll", () => {
      this.updatePageNumber();
    });

    // Keep wrapper positioned on window resize
    window.addEventListener("resize", () => {
      this.#updateWrapperPosition();
    });
  }

  #toggleExpand() {
    if (this.isExpanded) {
      this.#collapse();
    } else {
      this.#expand();
    }
  }

  #expand() {
    this.isExpanded = true;
    this.wrapper.classList.remove("collapsing");
    this.wrapper.classList.add("expanding");

    setTimeout(() => {
      this.wrapper.classList.remove("expanding");
      this.wrapper.classList.add("expanded");
    }, 500);
  }

  #collapse() {
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
      // the number here is for double-click interval
      this.viewer.scrollToTop();
      this.lastClickTime = 0;
    } else {
      this.clickTimeout = setTimeout(() => {
        this.viewer.scrollToRelative(1);
        this.clickTimeout = null;
      }, 100); // the number here is for single click timeout

      this.lastClickTime = now;
    }
  }

  #startDrag(e) {
    this.isDragging = true;
    this.dragStartY = e.clientY;
    this.scrollStartTop = this.viewerContainer.scrollTop;
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
    this.viewerContainer.scrollTop += scrollDelta;
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
  }

  #updateWrapperPosition() {
    const containerRect = this.viewerContainer.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;

    this.wrapper.style.top = `${centerY}px`;
    this.wrapper.style.right = "20px";
  }

  #updatePosition() {
    this.#updateWrapperPosition();
  }

  #handleToolAction(action) {
    switch (action) {
      case "zoom-in":
        this.viewer.zoom(0.25);
        break;
      case "zoom-out":
        this.viewer.zoom(-0.25);
        break;
      case "text-selection":
        break;
      case "drag":
        break;
    }
  }

  updatePageNumber() {
    const currentPage = this.viewer.getCurrentPage();
    const totalPages = this.viewer.pdfDoc?.numPages || "?";

    this.ball.querySelector(".page-current").textContent = currentPage;
    this.ball.querySelector(".page-total").textContent = totalPages;
  }

  destroy() {
    this.wrapper.remove();
  }
}
