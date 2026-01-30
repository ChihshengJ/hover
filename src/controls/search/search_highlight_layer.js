export class SearchHighlightLayer {
  /** @type {import('../../viewpane.js').ViewerPane} */
  #pane = null;

  /** @type {SVGSVGElement} */
  #svg = null;

  /** @type {Map<string, SVGGElement>} */
  #highlightGroups = new Map();

  /** @type {string|null} */
  #focusedId = null;

  /** @type {ResizeObserver} */
  #resizeObserver = null;

  /** @type {Array} */
  #matches = [];

  /** @type {Map<number, Array>} */
  #matchesByPage = new Map();

  /** @type {Set<number>} */
  #renderedPages = new Set();

  /** @type {Map<number, {top: number, left: number}>} */
  #pageLayoutCache = new Map();

  /** @type {boolean} */
  #layoutCacheValid = false;

  /** @type {Function|null} */
  #scrollHandler = null;

  /** @type {number|null} */
  #scrollRafId = null;

  // Single highlight color for all matches
  static HIGHLIGHT_COLOR = "#fabd1e";

  constructor(pane) {
    this.#pane = pane;
    this.#createSVG();
    this.#setupResizeObserver();
    this.#setupScrollHandler();
  }

  #createSVG() {
    const ns = "http://www.w3.org/2000/svg";
    this.#svg = document.createElementNS(ns, "svg");
    this.#svg.classList.add("search-highlight-layer");

    this.#svg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      pointer-events: none;
      z-index: 45;
      overflow: visible;
    `;

    this.#pane.stage.insertBefore(this.#svg, this.#pane.stage.firstChild);
    this.#updateSVGSize();
  }

  #setupResizeObserver() {
    this.#resizeObserver = new ResizeObserver(() => {
      this.#invalidateLayoutCache();
      this.refresh();
    });
    this.#resizeObserver.observe(this.#pane.stage);
  }

  #setupScrollHandler() {
    this.#scrollHandler = () => {
      // Use RAF to throttle scroll handling
      if (this.#scrollRafId) return;

      this.#scrollRafId = requestAnimationFrame(() => {
        this.#scrollRafId = null;
        this.#renderVisiblePages();
      });
    };

    this.#pane.scroller.addEventListener("scroll", this.#scrollHandler, {
      passive: true,
    });
  }

  #updateSVGSize() {
    const stageRect = this.#pane.stage.getBoundingClientRect();
    this.#svg.setAttribute("width", stageRect.width);
    this.#svg.setAttribute("height", stageRect.height);
    this.#svg.setAttribute(
      "viewBox",
      `0 0 ${stageRect.width} ${stageRect.height}`,
    );
  }

  #invalidateLayoutCache() {
    this.#layoutCacheValid = false;
    this.#pageLayoutCache.clear();
  }

  /**
   * Get page layout info, using cache when valid
   * @param {number} pageNumber - 1-based page number
   * @returns {{top: number, left: number}|null}
   */
  #getPageLayout(pageNumber) {
    if (this.#layoutCacheValid && this.#pageLayoutCache.has(pageNumber)) {
      return this.#pageLayoutCache.get(pageNumber);
    }

    const pageView = this.#pane.pages[pageNumber - 1];
    if (!pageView) return null;

    const layout = {
      top: pageView.wrapper.offsetTop,
      left: pageView.wrapper.offsetLeft,
    };

    this.#pageLayoutCache.set(pageNumber, layout);
    return layout;
  }

  /**
   * Batch read all layout properties for given pages
   * @param {Set<number>} pageNumbers - Page numbers to read layouts for
   */
  #batchReadLayouts(pageNumbers) {
    for (const pageNum of pageNumbers) {
      if (!this.#pageLayoutCache.has(pageNum)) {
        const pageView = this.#pane.pages[pageNum - 1];
        if (pageView) {
          this.#pageLayoutCache.set(pageNum, {
            top: pageView.wrapper.offsetTop,
            left: pageView.wrapper.offsetLeft,
          });
        }
      }
    }
    this.#layoutCacheValid = true;
  }

  /**
   * Get currently visible page numbers
   * @returns {Set<number>}
   */
  #getVisiblePageNumbers() {
    const visible = new Set();
    for (const pageView of this.#pane.visiblePages) {
      visible.add(pageView.pageNumber);
    }
    return visible;
  }

  /**
   * Render search highlights
   * @param {Array} matches - Array of SearchMatch objects
   */
  render(matches) {
    this.clear();
    this.#matches = matches;

    if (!Array.isArray(matches)) return;

    // Group matches by page for efficient lookup
    this.#matchesByPage.clear();
    for (const match of matches) {
      if (!this.#matchesByPage.has(match.pageNumber)) {
        this.#matchesByPage.set(match.pageNumber, []);
      }
      this.#matchesByPage.get(match.pageNumber).push(match);
    }

    // Render only visible pages
    this.#renderVisiblePages();
  }

  /**
   * Render highlights for currently visible pages only
   */
  #renderVisiblePages() {
    const visiblePages = this.#getVisiblePageNumbers();
    const pagesToRender = new Set();

    for (const pageNum of visiblePages) {
      if (
        !this.#renderedPages.has(pageNum) &&
        this.#matchesByPage.has(pageNum)
      ) {
        pagesToRender.add(pageNum);
      }
    }

    if (pagesToRender.size === 0) return;
    this.#batchReadLayouts(pagesToRender);
    const scale = this.#pane.scale;
    const fragment = document.createDocumentFragment();

    for (const pageNum of pagesToRender) {
      const layout = this.#pageLayoutCache.get(pageNum);
      if (!layout) continue;

      const pageMatches = this.#matchesByPage.get(pageNum) || [];

      for (const match of pageMatches) {
        const group = this.#createMatchGroup(match, layout, scale);
        if (group) {
          fragment.appendChild(group);
          this.#highlightGroups.set(match.id, group);
        }
      }
      this.#renderedPages.add(pageNum);
    }

    if (fragment.childNodes.length > 0) {
      this.#svg.appendChild(fragment);
    }
  }

  /**
   * Force render all matches on a specific page
   * @param {number} pageNumber - 1-based page number
   */
  #forceRenderPage(pageNumber) {
    if (this.#renderedPages.has(pageNumber)) return;
    if (!this.#matchesByPage.has(pageNumber)) return;

    this.#batchReadLayouts(new Set([pageNumber]));
    const layout = this.#pageLayoutCache.get(pageNumber);
    if (!layout) return;

    const scale = this.#pane.scale;
    const pageMatches = this.#matchesByPage.get(pageNumber) || [];
    const fragment = document.createDocumentFragment();

    for (const match of pageMatches) {
      // Skip if already rendered
      if (this.#highlightGroups.has(match.id)) continue;

      const group = this.#createMatchGroup(match, layout, scale);
      if (group) {
        fragment.appendChild(group);
        this.#highlightGroups.set(match.id, group);
      }
    }

    if (fragment.childNodes.length > 0) {
      this.#svg.appendChild(fragment);
    }

    this.#renderedPages.add(pageNumber);
  }

  /**
   * Create SVG group for a single match (no DOM operations)
   * @param {Object} match - SearchMatch object
   * @param {{top: number, left: number}} layout - Page layout info
   * @param {number} scale - Current scale
   * @returns {SVGGElement|null}
   */
  #createMatchGroup(match, layout, scale) {
    const ns = "http://www.w3.org/2000/svg";

    const group = document.createElementNS(ns, "g");
    group.classList.add("search-highlight-group");
    group.dataset.matchId = match.id;

    for (const rect of match.rects) {
      const element = document.createElementNS(ns, "rect");
      element.classList.add("search-highlight-rect");

      // Convert PDF coordinates to screen coordinates
      const x = layout.left + rect.x * scale;
      const y = layout.top + rect.y * scale;
      const width = rect.width * scale;
      const height = rect.height * scale;

      element.setAttribute("x", x);
      element.setAttribute("y", y);
      element.setAttribute("width", width);
      element.setAttribute("height", height);
      element.setAttribute("rx", 2);
      element.setAttribute("ry", 2);
      element.setAttribute("fill", SearchHighlightLayer.HIGHLIGHT_COLOR);
      element.setAttribute("fill-opacity", "0.3");

      group.appendChild(element);
    }

    // Create focus outline (hidden by default)
    const outline = this.#createFocusOutline(
      match,
      layout.left,
      layout.top,
      scale,
    );
    group.insertBefore(outline, group.firstChild);

    return group;
  }

  /**
   * Create focus outline for a match
   */
  #createFocusOutline(match, pageLeft, pageTop, scale) {
    const ns = "http://www.w3.org/2000/svg";

    // Calculate bounding box of all rects
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of match.rects) {
      const x = pageLeft + rect.x * scale;
      const y = pageTop + rect.y * scale;
      const width = rect.width * scale;
      const height = rect.height * scale;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    const padding = 2;
    const outline = document.createElementNS(ns, "rect");
    outline.classList.add("search-focus-outline");
    outline.setAttribute("x", minX - padding);
    outline.setAttribute("y", minY - padding);
    outline.setAttribute("width", maxX - minX + padding * 2);
    outline.setAttribute("height", maxY - minY + padding * 2);
    outline.setAttribute("rx", 4);
    outline.setAttribute("ry", 4);
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", "#2563eb");
    outline.setAttribute("stroke-width", "2");
    outline.setAttribute("opacity", "0");

    return outline;
  }

  /**
   * Set focus on a specific match
   * @param {string|null} matchId - Match ID to focus, or null to clear focus
   */
  setFocus(matchId) {
    // Remove focus from previous
    if (this.#focusedId) {
      const prevGroup = this.#highlightGroups.get(this.#focusedId);
      if (prevGroup) {
        prevGroup.classList.remove("focused");
        const outline = prevGroup.querySelector(".search-focus-outline");
        if (outline) outline.setAttribute("opacity", "0");
      }
    }

    this.#focusedId = matchId;

    // Add focus to new
    if (matchId) {
      // Find the match to get its page number
      const match = this.#matches.find((m) => m.id === matchId);
      if (match) {
        // FIX: Force render ALL matches on this page, not just the focused one
        // This ensures all highlights are visible when scrolling to a new page
        if (!this.#renderedPages.has(match.pageNumber)) {
          this.#forceRenderPage(match.pageNumber);
        }
      }

      const group = this.#highlightGroups.get(matchId);
      if (group) {
        group.classList.add("focused");
        const outline = group.querySelector(".search-focus-outline");
        if (outline) outline.setAttribute("opacity", "1");
      }
    }
  }

  /**
   * Get the bounding rect for a match (for scrolling into view)
   * @param {string} matchId - Match ID
   * @returns {DOMRect|null}
   */
  getMatchRect(matchId) {
    const match = this.#matches.find((m) => m.id === matchId);
    if (!match) return null;

    const layout = this.#getPageLayout(match.pageNumber);
    if (!layout) return null;

    const scale = this.#pane.scale;

    // Calculate bounding box
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of match.rects) {
      const x = layout.left + rect.x * scale;
      const y = layout.top + rect.y * scale;
      const width = rect.width * scale;
      const height = rect.height * scale;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  /**
   * Get the page-relative position for a match (for scrolling)
   * @param {string} matchId - Match ID
   * @returns {{pageNumber: number, offsetTop: number}|null}
   */
  getMatchPosition(matchId) {
    const match = this.#matches.find((m) => m.id === matchId);
    if (!match) return null;

    const layout = this.#getPageLayout(match.pageNumber);
    if (!layout) return null;

    const scale = this.#pane.scale;

    // Get center Y of first rect
    const firstRect = match.rects[0];
    const centerY = firstRect.y * scale + (firstRect.height * scale) / 2;

    return {
      pageNumber: match.pageNumber,
      offsetTop: layout.top + centerY,
    };
  }

  /**
   * Refresh all highlights (e.g., after zoom)
   */
  refresh() {
    this.#updateSVGSize();
    if (this.#matches.length > 0) {
      const focusedId = this.#focusedId;

      // Clear rendered state but keep matches grouped
      this.#svg.innerHTML = "";
      this.#highlightGroups.clear();
      this.#renderedPages.clear();
      this.#invalidateLayoutCache();

      // Re-render visible pages
      this.#renderVisiblePages();

      if (focusedId) {
        this.setFocus(focusedId);
      }
    }
  }

  /**
   * Clear all highlights
   */
  clear() {
    this.#svg.innerHTML = "";
    this.#highlightGroups.clear();
    this.#focusedId = null;
    this.#matches = [];
    this.#matchesByPage.clear();
    this.#renderedPages.clear();
    this.#invalidateLayoutCache();
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    // Clean up scroll handler
    if (this.#scrollHandler) {
      this.#pane.scroller.removeEventListener("scroll", this.#scrollHandler);
      this.#scrollHandler = null;
    }

    if (this.#scrollRafId) {
      cancelAnimationFrame(this.#scrollRafId);
      this.#scrollRafId = null;
    }

    if (this.#resizeObserver) {
      this.#resizeObserver.unobserve(this.#pane.stage);
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }

    this.clear();
    this.#svg?.remove();
  }
}
