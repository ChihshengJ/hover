/**
 * @typedef {import('./window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./controls/navigate_tree.js').NavigationPopup} NavigationPopup;
 *
 * @typedef {Object} SectionMark
 * @property {string} title
 * @property {number} position - Normalized position (0-1) in document
 * @property {HTMLElement} element
 * @property {boolean} reached
 */

export class ProgressBar {
  /**
   * @param {SplitWindowManager} wm
   */
  constructor(wm) {
    this.wm = wm;
    this.doc = wm.document;

    /** @type {HTMLElement} */
    this.container = null;

    /** @type {HTMLElement} */
    this.track = null;

    /** @type {HTMLElement} */
    this.glowLine = null;

    /** @type {HTMLElement} */
    this.progressIndicator = null;

    /** @type {HTMLElement} */
    this.sectionsContainer = null;

    /** @type {SectionMark[]} */
    this.sectionMarks = [];

    /** @type {number} */
    this.currentProgress = 0;

    /** @type {number} */
    this.lastReachedSectionIndex = -1;

    /** @type {boolean} */
    this.isSplitMode = false;

    /** @type {boolean} */
    this.hasReachedEnd = false;

    /** @type {number} */
    this.#animationFrame = null;

    /** @type {boolean} */
    this.#initialized = false;

    // Scroll callback for PaneControls
    this.#scrollCallback = () => {
      if (this.#animationFrame) {
        cancelAnimationFrame(this.#animationFrame);
      }
      this.#animationFrame = requestAnimationFrame(() => {
        this.#updateProgress();
      });
    };
  }

  /** @type {number} */
  #animationFrame = null;

  /** @type {boolean} */
  #initialized = false;

  /** @type {Function} */
  #scrollCallback = null;

  /** @type {ViewerPane|null} */
  #previousPane = null;

  /** @type {Function} */
  #resizeHandler = null;

  get activePane() {
    return this.wm.activePane;
  }

  /**
   * Initialize the progress bar system
   */
  async initialize() {
    if (this.#initialized) return;

    this.createProgressBar();
    this.#setupEventListeners();

    // Wait for navigation popup to build its tree
    await this.#waitForSections();
    this.#createSectionMarks();

    this.#initialized = true;

    // Initial update
    requestAnimationFrame(() => {
      this.#updateProgress();
    });
  }

  /**
   * Wait for the navigation popup to build its tree
   */
  async #waitForSections() {
    const toolbar = this.wm.toolbar;
    if (!toolbar?.navigationTree) return;

    // Initialize the navigation popup if not already done
    await toolbar.navigationTree.initialize();
  }

  /**
   * Get top-level sections from navigation tree
   * @returns {Array<{title: string, pageIndex: number, top: number}>}
   */
  #getTopLevelSections() {
    const toolbar = this.wm.toolbar;
    if (!toolbar?.navigationTree?.tree) return [];

    // Get only top-level sections (first level of outline)
    return toolbar.navigationTree.tree
      .filter((item) => item.type === "section")
      .map((item) => ({
        title: item.title,
        pageIndex: item.pageIndex,
        top: item.top,
      }));
  }

  /**
   * Create the left-side progress bar DOM
   */
  createProgressBar() {
    // Main container
    this.container = document.createElement("div");
    this.container.className = "progress-bar-container";

    // The glowing track/line
    this.track = document.createElement("div");
    this.track.className = "progress-bar-track";

    // Glow effect layer
    this.glowLine = document.createElement("div");
    this.glowLine.className = "progress-bar-glow";

    // Progress indicator (the dot/light source)
    this.progressIndicator = document.createElement("div");
    this.progressIndicator.className = "progress-indicator";
    this.progressIndicator.innerHTML = `
      <div class="indicator-core"></div>
      <div class="indicator-glow"></div>
      <div class="indicator-pulse"></div>
    `;

    // Section marks container
    this.sectionsContainer = document.createElement("div");
    this.sectionsContainer.className = "progress-sections";

    // End marker
    this.endMarker = document.createElement("div");
    this.endMarker.className = "progress-end-marker";

    // Assemble
    this.track.appendChild(this.glowLine);
    this.track.appendChild(this.sectionsContainer);
    this.track.appendChild(this.progressIndicator);
    this.track.appendChild(this.endMarker);
    this.container.appendChild(this.track);

    document.body.appendChild(this.container);
  }

  /**
   * Create section mark elements based on navigation tree
   */
  #createSectionMarks() {
    const sections = this.#getTopLevelSections();
    if (sections.length === 0) return;

    // Calculate total document height for positioning
    const pane = this.activePane;
    if (!pane) return;

    const totalHeight = pane.scroller.scrollHeight;

    sections.forEach((section, index) => {
      const pageView = pane.pages[section.pageIndex];
      if (!pageView) return;

      // Calculate absolute position in document
      const pageTop = pageView.wrapper.offsetTop;
      const pageHeight = pageView.wrapper.offsetHeight;
      const pageDims = this.doc.pageDimensions[section.pageIndex];

      // Convert PDF coordinates to pixel position within page
      const topRatio = pageDims
        ? (pageDims.height - section.top) / pageDims.height
        : 0;
      const absolutePosition = pageTop + pageHeight * topRatio;

      // Normalize to 0-1
      const normalizedPosition =
        totalHeight > 0 ? absolutePosition / totalHeight : 0;

      // Create mark element
      const mark = document.createElement("div");
      mark.className = "section-mark";
      mark.style.top = `${normalizedPosition * 100}%`;
      mark.dataset.index = index;
      mark.title = section.title;

      // Add subtle tick
      const tick = document.createElement("div");
      tick.className = "section-tick";
      mark.appendChild(tick);

      this.sectionsContainer.appendChild(mark);

      this.sectionMarks.push({
        title: section.title,
        position: normalizedPosition,
        element: mark,
        reached: false,
      });
    });
  }

  /**
   * Setup event listeners
   */
  #setupEventListeners() {
    // Register scroll callback with active pane's controls
    this.activePane?.controls.onScroll(this.#scrollCallback);
    this.#previousPane = this.activePane;

    // Handle resize
    this.#resizeHandler = () => {
      this.#recalculateSections();
      this.#updateProgress();
    };
    window.addEventListener("resize", this.#resizeHandler);
  }

  /**
   * Update progress based on current scroll position
   */
  #updateProgress() {
    const pane = this.activePane;
    if (!pane || this.isSplitMode) return;

    const scroller = pane.scroller;
    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight - scroller.clientHeight;

    // Calculate progress (0-1)
    this.currentProgress =
      scrollHeight > 0 ? Math.min(1, scrollTop / scrollHeight) : 0;

    this.progressIndicator.style.top = `${this.currentProgress * 100}%`;
    this.glowLine.style.height = `${this.currentProgress * 100}%`;
    this.#checkSectionMilestones();
    this.#checkEndCompletion();
  }

  /**
   * Check if we've reached any section milestones
   */
  #checkSectionMilestones() {
    this.sectionMarks.forEach((section, index) => {
      const wasReached = section.reached;
      section.reached = this.currentProgress >= section.position - 0.01;

      if (
        section.reached &&
        !wasReached &&
        index > this.lastReachedSectionIndex
      ) {
        this.lastReachedSectionIndex = index;
        this.#celebrateSection(section);
      }

      section.element.classList.toggle("reached", section.reached);
    });
  }

  /**
   * Celebrate reaching a section with micro-interaction
   * @param {SectionMark} section
   */
  #celebrateSection(section) {
    // Add celebration class
    section.element.classList.add("celebrating");
    this.progressIndicator.classList.add("section-pulse");

    // Create ripple effect
    const ripple = document.createElement("div");
    ripple.className = "section-ripple";
    section.element.appendChild(ripple);

    // Remove after animation
    setTimeout(() => {
      section.element.classList.remove("celebrating");
      this.progressIndicator.classList.remove("section-pulse");
      ripple.remove();
    }, 600);
  }

  /**
   * Check if we've reached the end of the document
   */
  #checkEndCompletion() {
    const wasAtEnd = this.hasReachedEnd;
    this.hasReachedEnd = this.currentProgress >= 0.98;

    if (this.hasReachedEnd && !wasAtEnd) {
      this.#celebrateCompletion();
    }

    this.container.classList.toggle("completed", this.hasReachedEnd);
    this.endMarker.classList.toggle("reached", this.hasReachedEnd);
  }

  /**
   * Celebrate completing the document
   */
  #celebrateCompletion() {
    this.container.classList.add("completion-celebration");
    this.endMarker.classList.add("celebrating");

    // Pulse the entire track
    this.track.classList.add("completion-pulse");

    setTimeout(() => {
      this.container.classList.remove("completion-celebration");
      this.endMarker.classList.remove("celebrating");
      this.track.classList.remove("completion-pulse");
    }, 1200);
  }

  /**
   * Recalculate section positions after resize
   */
  #recalculateSections() {
    if (this.sectionMarks.length === 0) return;

    const pane = this.activePane;
    if (!pane) return;

    const totalHeight = pane.scroller.scrollHeight;
    const sections = this.#getTopLevelSections();

    sections.forEach((section, index) => {
      if (index >= this.sectionMarks.length) return;

      const pageView = pane.pages[section.pageIndex];
      if (!pageView) return;

      const pageTop = pageView.wrapper.offsetTop;
      const pageHeight = pageView.wrapper.offsetHeight;
      const pageDims = this.doc.pageDimensions[section.pageIndex];

      const topRatio = pageDims
        ? (pageDims.height - section.top) / pageDims.height
        : 0;
      const absolutePosition = pageTop + pageHeight * topRatio;
      const normalizedPosition =
        totalHeight > 0 ? absolutePosition / totalHeight : 0;

      this.sectionMarks[index].position = normalizedPosition;
      this.sectionMarks[index].element.style.top =
        `${normalizedPosition * 100}%`;
    });
  }

  /**
   * Enter split mode - fade out left progress bar
   */
  enterSplitMode() {
    this.isSplitMode = true;
    this.container.classList.add("split-mode");
  }

  /**
   * Exit split mode - fade in left progress bar
   */
  exitSplitMode() {
    this.isSplitMode = false;
    this.container.classList.remove("split-mode");

    // Update progress
    this.#recalculateSections();
    this.#updateProgress();
  }

  /**
   * Handle active pane change
   */
  updateActivePane() {
    if (this.isSplitMode) return;

    // Unregister from previous pane's controls
    if (this.#previousPane && this.#previousPane !== this.activePane) {
      this.#previousPane.controls.offScroll(this.#scrollCallback);
    }

    // Register with new active pane's controls
    this.activePane?.controls.onScroll(this.#scrollCallback);
    this.#previousPane = this.activePane;

    this.#recalculateSections();
    this.#updateProgress();
  }

  /**
   * Refresh after zoom/resize
   */
  refresh() {
    this.#recalculateSections();
    this.#updateProgress();
  }

  /**
   * Cleanup
   */
  destroy() {
    // Unregister scroll callback
    this.activePane?.controls.offScroll(this.#scrollCallback);

    // Remove resize listener
    if (this.#resizeHandler) {
      window.removeEventListener("resize", this.#resizeHandler);
    }

    if (this.#animationFrame) {
      cancelAnimationFrame(this.#animationFrame);
    }

    this.container?.remove();
  }
}
