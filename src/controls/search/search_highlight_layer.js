/**
 * SearchHighlightLayer - SVG layer for rendering search result highlights
 */

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

  // Single highlight color for all matches
  static HIGHLIGHT_COLOR = "#fabd1e";

  constructor(pane) {
    this.#pane = pane;
    this.#createSVG();
    this.#setupResizeObserver();
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
      this.refresh();
    });
    this.#resizeObserver.observe(this.#pane.stage);
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

  /**
   * Render search highlights
   * @param {Array} matches - Array of SearchMatch objects
   */
  render(matches) {
    this.clear();
    this.#matches = matches;

    for (const match of matches) {
      this.#renderMatch(match);
    }
  }

  /**
   * Render a single search match
   * @param {Object} match - SearchMatch object
   */
  #renderMatch(match) {
    const ns = "http://www.w3.org/2000/svg";
    const pageView = this.#pane.pages[match.pageNumber - 1];
    if (!pageView) return;

    const group = document.createElementNS(ns, "g");
    group.classList.add("search-highlight-group");
    group.dataset.matchId = match.id;

    const pageTop = pageView.wrapper.offsetTop;
    const pageLeft = pageView.wrapper.offsetLeft;
    const scale = this.#pane.scale;

    for (const rect of match.rects) {
      const element = document.createElementNS(ns, "rect");
      element.classList.add("search-highlight-rect");

      // Convert PDF coordinates to screen coordinates
      const x = pageLeft + rect.x * scale;
      const y = pageTop + rect.y * scale;
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
    const outline = this.#createFocusOutline(match, pageLeft, pageTop, scale);
    group.insertBefore(outline, group.firstChild);

    this.#svg.appendChild(group);
    this.#highlightGroups.set(match.id, group);
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
    outline.setAttribute("stroke-width", "1");
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

    const pageView = this.#pane.pages[match.pageNumber - 1];
    if (!pageView) return null;

    const scale = this.#pane.scale;
    const pageTop = pageView.wrapper.offsetTop;
    const pageLeft = pageView.wrapper.offsetLeft;

    // Calculate bounding box
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

    const pageView = this.#pane.pages[match.pageNumber - 1];
    if (!pageView) return null;

    const scale = this.#pane.scale;

    // Get center Y of first rect
    const firstRect = match.rects[0];
    const centerY = firstRect.y * scale + (firstRect.height * scale) / 2;

    return {
      pageNumber: match.pageNumber,
      offsetTop: pageView.wrapper.offsetTop + centerY,
    };
  }

  /**
   * Refresh all highlights (e.g., after zoom)
   */
  refresh() {
    this.#updateSVGSize();
    if (this.#matches.length > 0) {
      const focusedId = this.#focusedId;
      this.render(this.#matches);
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
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    if (this.#resizeObserver) {
      this.#resizeObserver.unobserve(this.#pane.stage);
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
    this.clear();
    this.#svg?.remove();
  }
}
