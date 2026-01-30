import { SearchBar } from "./search_bar.js";
import { SearchHighlightLayer } from "./search_highlight_layer.js";

export class SearchController {
  /** @type {import('../../window_manager.js').SplitWindowManager} */
  #wm = null;

  /** @type {SearchBar|null} */
  #searchBar = null;

  /** @type {SearchHighlightLayer|null} */
  #highlightLayer = null;

  /** @type {boolean} */
  #isActive = false;

  /** @type {Array} */
  #results = [];

  /** @type {number} */
  #focusIndex = -1;

  /** @type {Object} */
  #range = { from: 1, to: null };

  /** @type {string} */
  #currentQuery = "";

  /** @type {Function|null} */
  #scrollCallback = null;

  /** @type {Function|null} */
  #indexingStartHandler = null;

  /** @type {Function|null} */
  #indexingProgressHandler = null;

  /** @type {Function|null} */
  #indexingReadyHandler = null;

  /** @type {Object|null} */
  #indexingSubscriber = null;

  /**
   * Navigation lock: when true, scroll-based range updates are ignored.
   * Set when user navigates through results (focusNext/focusPrev).
   * Released when user explicitly changes query or manually changes range.
   * @type {boolean}
   */
  #isNavigating = false;

  constructor(wm) {
    this.#wm = wm;
    this.#setupIndexingListeners();
  }

  /** @returns {import('../../viewpane.js').ViewerPane} */
  get #pane() {
    return this.#wm.activePane;
  }

  get #doc() {
    return this.#wm.document;
  }

  get #searchIndex() {
    return this.#doc.searchIndex;
  }

  get totalPages() {
    return this.#doc.numPages;
  }

  get isActive() {
    return this.#isActive;
  }

  // =========================================
  // Activation / Deactivation
  // =========================================

  /**
   * Setup listeners for search index building events
   */
  #setupIndexingListeners() {
    this.#indexingStartHandler = ({ totalPages }) => {
      this.#searchBar?.setIndexingState(true, 0);
    };

    this.#indexingProgressHandler = ({
      completedPages,
      totalPages,
      percent,
    }) => {
      this.#searchBar?.updateIndexingProgress(percent);
    };

    this.#indexingReadyHandler = ({ elapsedMs }) => {
      this.#searchBar?.setIndexingState(false);

      // If there's a pending query, run the search now
      if (this.#currentQuery.trim()) {
        this.#performSearch();
      }
    };

    // Subscribe to document events using the correct callback interface
    const subscriber = {
      onDocumentChange: (event, data) => {
        switch (event) {
          case "search-index-start":
            this.#indexingStartHandler(data);
            break;
          case "search-index-progress":
            this.#indexingProgressHandler(data);
            break;
          case "search-index-ready":
            this.#indexingReadyHandler(data);
            break;
        }
      },
    };

    this.#doc?.subscribe(subscriber);
    this.#indexingSubscriber = subscriber;
  }

  /**
   * Activate search mode
   */
  async activate() {
    if (this.#isActive) {
      // If already active, just focus the input
      this.#searchBar?.show();
      return;
    }

    this.#isActive = true;

    // Create search bar if needed
    if (!this.#searchBar) {
      this.#searchBar = new SearchBar(this);
      this.#updateSearchBarOutline();
    }

    // Check current indexing state and update UI
    if (this.#searchIndex?.isBuilding) {
      this.#searchBar.setIndexingState(
        true,
        this.#searchIndex.buildProgress || 0,
      );
    } else if (!this.#searchIndex?.isBuilt) {
      // Index not started yet - show indexing at 0%
      this.#searchBar.setIndexingState(true, 0);
    }

    // Create highlight layer for active pane
    this.#createHighlightLayer();

    // Setup scroll listener for "current page" updates
    this.#setupScrollListener();

    // Show search bar
    this.#searchBar.show();

    // Initialize range
    this.#range = { from: 1, to: this.totalPages };
  }

  /**
   * Deactivate search mode
   */
  deactivate() {
    if (!this.#isActive) return;

    this.#isActive = false;

    // Hide and reset search bar
    this.#searchBar?.hide();

    // Clear highlights
    this.#destroyHighlightLayer();

    // Remove scroll listener
    this.#removeScrollListener();

    // Reset state
    this.#results = [];
    this.#focusIndex = -1;
    this.#currentQuery = "";
    this.#range = { from: 1, to: null };
    this.#isNavigating = false;
  }

  // =========================================
  // Search operations
  // =========================================

  /**
   * Called when search query changes
   * @param {string} query
   */
  onQueryChange(query) {
    this.#currentQuery = query;

    // User explicitly changed query - release navigation lock
    this.#isNavigating = false;

    if (!query.trim()) {
      this.#results = [];
      this.#focusIndex = -1;
      this.#highlightLayer?.clear();
      this.#searchBar?.updateResultCount(0, 0);
      return;
    }

    // SearchBar already debounces, so perform search immediately
    this.#performSearch();
  }

  /**
   * Called when search range changes
   * @param {number} from - Start page (1-based)
   * @param {number} to - End page (1-based)
   * @param {boolean} [isScrollUpdate=false] - Whether this is from scroll-based current page update
   */
  onRangeChange(from, to, isScrollUpdate = false) {
    // If navigating through results and this is a scroll-based update,
    // ignore it completely to preserve navigation state
    if (this.#isNavigating && isScrollUpdate) {
      return;
    }

    // User explicitly changed range - release navigation lock
    if (!isScrollUpdate) {
      this.#isNavigating = false;
    }

    const newRange = { from, to: to || this.totalPages };

    // Check if range actually changed
    if (this.#range.from === newRange.from && this.#range.to === newRange.to) {
      return;
    }

    this.#range = newRange;

    // Re-run search if there's a query
    if (this.#currentQuery.trim()) {
      this.#performSearch();
    }
  }

  /**
   * Perform the actual search
   */
  async #performSearch() {
    if (!this.#searchIndex?.isBuilt) {
      console.warn("Search index not ready");
      return;
    }

    const query = this.#currentQuery.trim();
    if (!query || query.length < 2) return;

    const { from, to } = this.#range;
    this.#results = await this.#searchIndex.search(query, from, to);

    // Update highlight layer
    this.#highlightLayer?.render(this.#results);

    // Update result count
    const total = this.#results.length;
    this.#searchBar?.updateResultCount(total > 0 ? 1 : 0, total);

    // Reset focus index when search is performed
    this.#focusIndex = -1;
  }

  // =========================================
  // Focus navigation
  // =========================================

  /**
   * Move focus to next result
   */
  focusNext() {
    if (this.#results.length === 0) return;

    // Enter navigation mode - scroll-based range updates will be ignored
    this.#isNavigating = true;

    this.#focusIndex = (this.#focusIndex + 1) % this.#results.length;
    this.#focusCurrentResult();
  }

  /**
   * Move focus to previous result
   */
  focusPrev() {
    if (this.#results.length === 0) return;

    // Enter navigation mode - scroll-based range updates will be ignored
    this.#isNavigating = true;

    this.#focusIndex =
      (this.#focusIndex - 1 + this.#results.length) % this.#results.length;
    this.#focusCurrentResult();
  }

  /**
   * Focus the current result and scroll to it
   */
  #focusCurrentResult() {
    if (this.#focusIndex < 0 || this.#focusIndex >= this.#results.length)
      return;

    const match = this.#results[this.#focusIndex];

    // Update highlight layer focus
    this.#highlightLayer?.setFocus(match.id);

    // Update result count
    this.#searchBar?.updateResultCount(
      this.#focusIndex + 1,
      this.#results.length,
    );

    // Scroll to center the match
    this.#scrollToMatch(match.id);
  }

  /**
   * Scroll to center a match in the viewport
   * @param {string} matchId
   */
  #scrollToMatch(matchId) {
    const position = this.#highlightLayer?.getMatchPosition(matchId);
    if (!position) return;

    const scroller = this.#pane.scroller;
    const scrollerHeight = scroller.clientHeight;

    // Calculate scroll position to center the match
    const targetScrollTop = position.offsetTop - scrollerHeight / 2;

    scroller.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: "smooth",
    });
  }

  // =========================================
  // Helper methods
  // =========================================

  /**
   * Get current page number
   * @returns {number}
   */
  getCurrentPage() {
    return this.#pane?.getCurrentPage() || 1;
  }

  /**
   * Create highlight layer for active pane
   */
  #createHighlightLayer() {
    this.#destroyHighlightLayer();
    if (this.#pane) {
      this.#highlightLayer = new SearchHighlightLayer(this.#pane);
    }
  }

  /**
   * Destroy highlight layer
   */
  #destroyHighlightLayer() {
    this.#highlightLayer?.destroy();
    this.#highlightLayer = null;
  }

  /**
   * Setup scroll listener for current page tracking
   */
  #setupScrollListener() {
    if (this.#scrollCallback) return;

    this.#scrollCallback = () => {
      const currentPage = this.getCurrentPage();
      this.#searchBar?.updateCurrentPage(currentPage);
    };

    this.#pane?.controls.onScroll(this.#scrollCallback);
  }

  /**
   * Remove scroll listener
   */
  #removeScrollListener() {
    if (this.#scrollCallback && this.#pane?.controls) {
      this.#pane.controls.offScroll(this.#scrollCallback);
    }
    this.#scrollCallback = null;
  }

  /**
   * Update search bar outline from document
   */
  #updateSearchBarOutline() {
    const outline = this.#doc.outline || [];
    const flatOutline = this.#flattenOutline(outline);
    this.#searchBar?.setOutline(flatOutline);
  }

  /**
   * Flatten hierarchical outline to array with depth info
   * @param {Array} outline - Hierarchical outline
   * @param {number} depth - Current depth
   * @returns {Array}
   */
  #flattenOutline(outline, depth = 0) {
    const result = [];

    for (const item of outline) {
      result.push({
        title: item.title,
        pageNumber: item.pageIndex + 1, // Convert 0-based to 1-based
        depth,
      });

      if (item.children && item.children.length > 0) {
        result.push(...this.#flattenOutline(item.children, depth + 1));
      }
    }

    return result;
  }

  /**
   * Handle pane change (e.g., when switching active pane in split mode)
   */
  onPaneChange() {
    if (!this.#isActive) return;

    // Recreate highlight layer for new pane
    this.#createHighlightLayer();

    // Re-render highlights
    if (this.#results.length > 0) {
      this.#highlightLayer?.render(this.#results);
      if (this.#focusIndex >= 0) {
        this.#highlightLayer?.setFocus(this.#results[this.#focusIndex].id);
      }
    }

    // Re-setup scroll listener
    this.#removeScrollListener();
    this.#setupScrollListener();
  }

  /**
   * Refresh after zoom or layout change
   */
  refresh() {
    this.#highlightLayer?.refresh();
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this.deactivate();

    // Unsubscribe from document events
    if (this.#indexingSubscriber) {
      this.#doc?.unsubscribe(this.#indexingSubscriber);
      this.#indexingSubscriber = null;
    }

    this.#searchBar?.destroy();
    this.#searchBar = null;
  }
}
