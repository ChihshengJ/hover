export class SearchBar {
  /** @type {Boolean} */
  #isIndexing = null;

  /** @type {import('./search_controller.js').SearchController} */
  #controller = null;

  /** @type {HTMLElement} */
  #container = null;

  /** @type {HTMLInputElement} */
  #searchInput = null;

  /** @type {HTMLElement} */
  #resultCount = null;

  /** @type {HTMLElement} */
  #indexingIndicator = null;

  /** @type {HTMLElement} */
  #fromSelect = null;

  /** @type {HTMLInputElement} */
  #fromInput = null;

  /** @type {HTMLElement} */
  #toSelect = null;

  /** @type {HTMLInputElement} */
  #toInput = null;

  /** @type {HTMLElement[]} */
  #clearBtns = null;

  /** @type {boolean} */
  #fromSelected = false;

  /** @type {number} */
  #debounceTimer = null;

  /** @type {number} */
  #currentFromPage = 1;

  /** @type {Array} */
  #outline = [];

  constructor(controller) {
    this.#controller = controller;
    this.#createElements();
    this.#setupEventListeners();
  }

  #createElements() {
    this.#container = document.createElement("div");
    this.#container.className = "search-bar";
    this.#container.innerHTML = `
      <button class="search-close-btn" title="Close (Esc)">×</button>
      
      <div class="search-main">
        <div class="search-input-wrapper">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input type="text" class="search-input" placeholder="Search in document..." autocomplete="off" />
          <span class="search-result-count">
            <span class="search-current">0</span>/<span class="search-total">0</span>
          </span>
          <span class="search-indexing-indicator" style="display: none;">
            <svg class="search-indexing-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            <span class="search-indexing-text">Indexing...</span>
          </span>
        </div>
      </div>
      
      <div class="search-range">
        <div class="search-range-field search-from-field">
          <label>From</label>
          <div class="search-range-input-wrapper">
            <input type="text" class="search-range-input search-from-input" placeholder="Page or section" />
            <button type="button" class="clear-button" id="clear-1">×</button>
            <div class="search-dropdown search-from-dropdown"></div>
          </div>
        </div>
        
        <div class="search-range-field search-to-field disabled">
          <label>To</label>
          <div class="search-range-input-wrapper">
            <input type="text" class="search-range-input search-to-input" placeholder="Page or section" disabled />
            <button type="button" class="clear-button" id="clear-2">×</button>
            <div class="search-dropdown search-to-dropdown"></div>
          </div>
        </div>
      </div>
    `;

    // Get references
    this.#searchInput = this.#container.querySelector(".search-input");
    this.#resultCount = this.#container.querySelector(".search-result-count");
    this.#indexingIndicator = this.#container.querySelector(
      ".search-indexing-indicator",
    );
    this.#fromInput = this.#container.querySelector(".search-from-input");
    this.#toInput = this.#container.querySelector(".search-to-input");
    this.#fromSelect = this.#container.querySelector(".search-from-dropdown");
    this.#toSelect = this.#container.querySelector(".search-to-dropdown");
    this.#clearBtns = [
      this.#container.querySelector("#clear-1"),
      this.#container.querySelector("#clear-2"),
    ];

    document.body.appendChild(this.#container);
  }

  #setupEventListeners() {
    // Close button
    this.#container
      .querySelector(".search-close-btn")
      .addEventListener("click", () => {
        this.#controller.deactivate();
        this.#container.classList.remove("visible");
      });

    // Search input
    this.#searchInput.addEventListener("input", () => {
      this.#debounceSearch();
    });

    this.#searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          this.#controller.focusPrev();
        } else {
          this.#controller.focusNext();
        }
      } else if (e.key === "Escape") {
        this.#controller.deactivate();
      }
    });

    // From input
    this.#fromInput.addEventListener("focus", () => {
      this.#showFromDropdown();
    });

    this.#fromInput.addEventListener("blur", (e) => {
      // Delay hide to allow click on dropdown
      setTimeout(() => this.#hideDropdown(this.#fromSelect), 150);
    });

    this.#fromInput.addEventListener("input", () => {
      this.#handleFromInput();
    });

    this.#fromInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.#confirmFromSelection();
        this.#hideDropdown(this.#fromSelect);
      }
    });

    // To input
    this.#toInput.addEventListener("focus", () => {
      if (this.#fromSelected) {
        this.#showToDropdown();
      }
    });

    this.#toInput.addEventListener("blur", () => {
      setTimeout(() => this.#hideDropdown(this.#toSelect), 150);
    });

    this.#toInput.addEventListener("input", () => {
      this.#handleToInput();
    });

    this.#toInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.#confirmToSelection();
        this.#hideDropdown(this.#toSelect);
      }
    });

    // Prevent search bar from stealing focus when clicking container
    this.#container.addEventListener("mousedown", (e) => {
      if (e.target === this.#container) {
        e.preventDefault();
      }
    });

    this.#clearBtns[0].addEventListener("click", () => {
      this.#fromInput.value = "";
    });

    this.#clearBtns[1].addEventListener("click", () => {
      this.#toInput.value = "";
    });
  }

  #debounceSearch() {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#controller.onQueryChange(this.#searchInput.value);
    }, 150);
  }

  // =========================================
  // From field handling
  // =========================================

  #showFromDropdown() {
    const dropdown = this.#fromSelect;
    dropdown.innerHTML = "";

    // Add "Current page" option
    const currentPage = this.#controller.getCurrentPage();
    const currentOption = this.#createDropdownOption(
      `Current page (${currentPage})`,
      "current",
      () => {
        this.#selectFrom("current", currentPage);
      },
    );
    dropdown.appendChild(currentOption);

    // Add outline sections
    for (const section of this.#outline) {
      const option = this.#createDropdownOption(
        section.title,
        section.pageNumber,
        () => {
          this.#selectFrom("section", section.pageNumber, section.title);
        },
      );
      option.style.paddingLeft = `${12 + section.depth * 12}px`;
      dropdown.appendChild(option);
    }

    dropdown.classList.add("visible");
  }

  #handleFromInput() {
    const value = this.#fromInput.value.trim();
    const pageNum = parseInt(value, 10);

    // Filter dropdown based on input
    const dropdown = this.#fromSelect;
    const options = dropdown.querySelectorAll(".search-dropdown-option");

    for (const option of options) {
      const text = option.textContent.toLowerCase();
      const matches =
        text.includes(value.toLowerCase()) || option.dataset.page === value;
      option.style.display = matches ? "" : "none";
    }

    // If it's a valid page number, enable it
    if (
      !isNaN(pageNum) &&
      pageNum >= 1 &&
      pageNum <= this.#controller.totalPages
    ) {
      // Valid page number entered
    }
  }

  #selectFrom(type, pageNumber, title = null) {
    this.#currentFromPage = pageNumber;
    this.#fromSelected = true;

    if (type === "current") {
      this.#fromInput.value = `Current page (${pageNumber})`;
      this.#fromInput.dataset.type = "current";
    } else if (type === "section") {
      this.#fromInput.value = title || `Page ${pageNumber}`;
      this.#fromInput.dataset.type = "section";
    } else {
      this.#fromInput.value = `Page ${pageNumber}`;
      this.#fromInput.dataset.type = "page";
    }

    this.#fromInput.dataset.page = pageNumber;
    this.#hideDropdown(this.#fromSelect);

    // Enable "to" field
    this.#enableToField();
    this.#validateToSelection();

    // Trigger search with new range
    this.#updateRange();
  }

  #confirmFromSelection() {
    const value = this.#fromInput.value.trim();
    const pageNum = parseInt(value, 10);

    if (
      !isNaN(pageNum) &&
      pageNum >= 1 &&
      pageNum <= this.#controller.totalPages
    ) {
      this.#selectFrom("page", pageNum);
    }
  }

  // =========================================
  // To field handling
  // =========================================

  #enableToField() {
    const toField = this.#container.querySelector(".search-to-field");
    toField.classList.remove("disabled");
    this.#toInput.disabled = false;
  }

  #disableToField() {
    const toField = this.#container.querySelector(".search-to-field");
    toField.classList.add("disabled");
    this.#toInput.disabled = true;
    this.#toInput.value = "";
  }

  #showToDropdown() {
    const dropdown = this.#toSelect;
    dropdown.innerHTML = "";

    const fromPage = this.#currentFromPage;

    // Add "End of document" option
    const endOption = this.#createDropdownOption(
      "End of document",
      this.#controller.totalPages,
      () => {
        this.#selectTo("end", this.#controller.totalPages);
      },
    );
    dropdown.appendChild(endOption);

    // Add outline sections that come after fromPage
    for (const section of this.#outline) {
      if (section.pageNumber > fromPage) {
        const option = this.#createDropdownOption(
          section.title,
          section.pageNumber,
          () => {
            this.#selectTo("section", section.pageNumber, section.title);
          },
        );
        option.style.paddingLeft = `${12 + section.depth * 12}px`;
        dropdown.appendChild(option);
      }
    }

    dropdown.classList.add("visible");
  }

  #handleToInput() {
    let value = this.#toInput.value.trim();
    let isToRelative = false;
    if (value.match(/^\+/)) {
      value = value.substring(1);
      isToRelative = true;
    }
    const pageNum = parseInt(value, 10);

    if (isToRelative) {
      // Relative mode: value is number of pages
      if (!isNaN(pageNum) && pageNum > 0) {
        const toPage = this.#currentFromPage + pageNum;
        this.#toInput.dataset.page = Math.min(
          toPage,
          this.#controller.totalPages,
        );
        this.#updateRange();
      }
    } else {
      // Absolute mode: filter dropdown
      const dropdown = this.#toSelect;
      const options = dropdown.querySelectorAll(".search-dropdown-option");

      for (const option of options) {
        const text = option.textContent.toLowerCase();
        const matches =
          text.includes(value.toLowerCase()) || option.dataset.page === value;
        option.style.display = matches ? "" : "none";
      }
    }
  }

  #selectTo(type, pageNumber, title = null) {
    this.#toInput.dataset.page = pageNumber;

    if (type === "end") {
      this.#toInput.value = "End of document";
    } else if (type === "section") {
      this.#toInput.value = title || `Page ${pageNumber}`;
    } else {
      this.#toInput.value = `Page ${pageNumber}`;
    }

    this.#hideDropdown(this.#toSelect);
    this.#updateRange();
  }

  #confirmToSelection() {
    const value = this.#toInput.value.trim();
    const pageNum = parseInt(value, 10);

    if (
      !isNaN(pageNum) &&
      pageNum > this.#currentFromPage &&
      pageNum <= this.#controller.totalPages
    ) {
      this.#selectTo("page", pageNum);
    }
  }

  #validateToSelection() {
    const toPage = parseInt(this.#toInput.dataset.page, 10);

    if (!isNaN(toPage) && toPage <= this.#currentFromPage) {
      // To page is now invalid, reset it
      this.#toInput.value = "";
      this.#toInput.dataset.page = "";
      this.#toInput.classList.add("invalid");
      setTimeout(() => this.#toInput.classList.remove("invalid"), 500);
      this.#updateRange();
    }
  }

  // =========================================
  // Helpers
  // =========================================

  #createDropdownOption(text, pageNumber, onClick) {
    const option = document.createElement("div");
    option.className = "search-dropdown-option";
    option.textContent = text;
    option.dataset.page = pageNumber;
    option.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onClick();
    });
    return option;
  }

  #hideDropdown(dropdown) {
    dropdown.classList.remove("visible");
  }

  #updateRange() {
    const fromPage = this.#currentFromPage || 1;
    const toPage =
      parseInt(this.#toInput.dataset.page, 10) || this.#controller.totalPages;

    this.#controller.onRangeChange(fromPage, toPage);
  }

  // =========================================
  // Public API
  // =========================================

  /**
   * Show the search bar
   */
  show() {
    this.#container.classList.add("visible");
    setTimeout(() => {
      this.#searchInput.focus();
    }, 100);
  }

  /**
   * Hide the search bar
   */
  hide() {
    this.#container.classList.remove("visible");
    this.#hideDropdown(this.#fromSelect);
    this.#hideDropdown(this.#toSelect);
    this.reset();
  }

  /**
   * Reset the search bar state
   */
  reset() {
    this.#searchInput.value = "";
    this.#fromInput.value = "";
    this.#fromInput.dataset.page = "";
    this.#fromInput.dataset.type = "";
    this.#toInput.value = "";
    this.#toInput.dataset.page = "";
    this.#fromSelected = false;
    this.#currentFromPage = 1;
    this.#disableToField();
    this.updateResultCount(0, 0);
  }

  /**
   * Update result count display
   * @param {number} current - Current focused result index (1-based)
   * @param {number} total - Total number of results
   */
  updateResultCount(current, total) {
    this.#container.querySelector(".search-current").textContent = current;
    this.#container.querySelector(".search-total").textContent = total;

    const resultCount = this.#container.querySelector(".search-result-count");
    resultCount.classList.toggle("has-results", total > 0);
    resultCount.classList.toggle(
      "no-results",
      total === 0 && this.#searchInput.value.length > 0,
    );
  }

  /**
   * Set the outline data for dropdown options
   * @param {Array} outline - Flattened outline array with {title, pageNumber, depth}
   */
  setOutline(outline) {
    this.#outline = outline;
  }

  /**
   * Update current page (for "current page" option validation)
   * Called when user scrolls
   */
  updateCurrentPage(pageNumber) {
    // If "current page" was selected, update the from value
    if (this.#fromInput.dataset.type === "current") {
      this.#currentFromPage = pageNumber;
      this.#fromInput.value = `Current page (${pageNumber})`;
      this.#fromInput.dataset.page = pageNumber;
      this.#validateToSelection();
      this.#updateRange();
    }
  }

  /**
   * Set indexing state - shows/hides the indexing indicator
   * @param {boolean} isIndexing - Whether indexing is in progress
   * @param {number} [percent=0] - Progress percentage (0-100)
   */
  setIndexingState(isIndexing, percent = 0) {
    this.#isIndexing = isIndexing;

    if (isIndexing) {
      this.#indexingIndicator.style.display = "flex";
      this.#resultCount.style.display = "none";
      this.#searchInput.placeholder = `Indexing... ${percent}%`;
      this.#searchInput.disabled = true;
      this.#container.classList.add("indexing");

      // Update progress text
      const textEl = this.#indexingIndicator.querySelector(
        ".search-indexing-text",
      );
      if (textEl) {
        textEl.textContent = `Indexing... ${percent}%`;
      }
    } else {
      this.#indexingIndicator.style.display = "none";
      this.#resultCount.style.display = "";
      this.#searchInput.placeholder = "Search in document...";
      this.#searchInput.disabled = false;
      this.#container.classList.remove("indexing");
    }
  }

  /**
   * Update indexing progress
   * @param {number} percent - Progress percentage (0-100)
   */
  updateIndexingProgress(percent) {
    if (!this.#isIndexing) return;

    this.#searchInput.placeholder = `Indexing... ${percent}%`;

    const textEl = this.#indexingIndicator.querySelector(
      ".search-indexing-text",
    );
    if (textEl) {
      textEl.textContent = `Indexing... ${percent}%`;
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    this.#container?.remove();
  }
}
