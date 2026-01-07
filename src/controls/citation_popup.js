export class CitationPopup {
  constructor() {
    this.popup = null;
    this.currentAnchor = null;
    this.isExpanded = false;
    this.closeTimer = null;
    this.isMouseOverPopup = false;
    this.isMouseOverAnchor = false;
    this.fullText = "";
    this.truncatedLength = 200;

    // Tab state
    this.activeTab = "reference"; // "reference" or "abstract"
    this.scholarData = null;
    this.scholarError = null;
    this.isLoadingScholar = false;

    this.init();
  }

  init() {
    this.popup = document.createElement("div");
    this.popup.className = "citation-popup";
    document.body.appendChild(this.popup);
    this.popup.style.opacity = "0";

    document.addEventListener("click", (e) => {
      if (
        this.popup.style.display !== "none" &&
        !this.popup.contains(e.target) &&
        !this.currentAnchor?.contains(e.target)
      ) {
        this.hide();
      }
    });

    this.popup.addEventListener("mouseenter", () => {
      this.isMouseOverPopup = true;
      this.cancelClose();
    });

    this.popup.addEventListener("mouseleave", () => {
      this.isMouseOverPopup = false;
      this.scheduleClose();
    });
  }

  async show(anchor, findCiteTextCallback, left, pageIndex, top) {
    // If showing the same anchor, just cancel any pending close
    if (this.currentAnchor === anchor && this.popup.style.display === "block") {
      this.cancelClose();
      return;
    }

    if (this.currentAnchor && this.currentAnchor !== anchor) {
      this.hide(true);
    }

    this.currentAnchor = anchor;
    this.isExpanded = false;
    this.isMouseOverAnchor = true;
    this.activeTab = "reference";
    this.scholarData = null;
    this.scholarError = null;
    this.isLoadingScholar = false;

    this.cancelClose();

    this.popup.style.display = "block";
    this.popup.style.transform = "translateY(-10px) scale(0.95)";
    this.positionPopup();
    this.popup.offsetHeight;
    this.popup.style.opacity = "1";
    this.popup.style.transform = "translateY(0) scale(1)";

    try {
      const result = await findCiteTextCallback(left, pageIndex, top);

      if (!result) {
        this.showError("Reference not found");
        return;
      }
      this.renderContent(result);
      this.positionPopup();
    } catch (error) {
      console.error("Error loading citation:", error);
      this.showError("Failed to load reference");
    }
  }

  positionPopup() {
    if (!this.currentAnchor) return;

    const anchorRect = this.currentAnchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Get popup dimensions (it needs to be displayed to measure)
    const popupRect = this.popup.getBoundingClientRect();
    const popupWidth = popupRect.width;
    const popupHeight = popupRect.height;

    const MARGIN = 16; // Margin from viewport edges
    const ANCHOR_OFFSET = 6; // Distance from anchor

    let finalX, finalY;
    let positionedAbove = false;

    // === HORIZONTAL POSITIONING ===
    // Default: center popup under anchor with slight left offset
    let preferredX = anchorRect.left - 25;

    // Check if popup would overflow right edge
    if (preferredX + popupWidth + MARGIN > viewportWidth) {
      // Try aligning popup's right edge with some margin
      preferredX = viewportWidth - popupWidth - MARGIN;

      // If popup is wider than viewport or anchor is very close to right edge
      // Position popup to the LEFT of the anchor instead
      if (preferredX < MARGIN || anchorRect.right > viewportWidth - 100) {
        preferredX = anchorRect.left - popupWidth - ANCHOR_OFFSET;

        // Make sure it doesn't go off the left edge
        if (preferredX < MARGIN) {
          preferredX = MARGIN;
        }
      }
    }

    // Ensure popup doesn't go off left edge
    if (preferredX < MARGIN) {
      preferredX = MARGIN;
    }

    finalX = preferredX;

    // === VERTICAL POSITIONING ===
    // Default: position below anchor
    let preferredY = anchorRect.bottom + ANCHOR_OFFSET;

    // Check space below and above anchor
    const spaceBelow = viewportHeight - anchorRect.bottom - ANCHOR_OFFSET;
    const spaceAbove = anchorRect.top - ANCHOR_OFFSET;

    // If not enough space below, check if there's more space above
    if (spaceBelow < popupHeight + MARGIN) {
      if (spaceAbove > spaceBelow && spaceAbove >= popupHeight + MARGIN) {
        // Position above anchor
        preferredY = anchorRect.top - popupHeight - ANCHOR_OFFSET;
        positionedAbove = true;
      } else if (spaceBelow < popupHeight + MARGIN) {
        // Not enough space either way - position below but allow scrolling
        // Or position to use the larger space available
        if (spaceAbove > spaceBelow) {
          // Use space above, may need scrolling
          preferredY = Math.max(
            MARGIN,
            anchorRect.top - popupHeight - ANCHOR_OFFSET,
          );
          positionedAbove = true;
        } else {
          // Use space below, may need scrolling
          preferredY = anchorRect.bottom + ANCHOR_OFFSET;

          // If it would go off bottom, adjust upward but keep some visible
          if (preferredY + popupHeight > viewportHeight - MARGIN) {
            preferredY = Math.max(
              anchorRect.bottom + ANCHOR_OFFSET,
              viewportHeight - popupHeight - MARGIN,
            );
          }
        }
      }
    }

    // Ensure popup top is not above viewport
    if (preferredY < MARGIN) {
      preferredY = MARGIN;
    }

    finalY = preferredY;

    // Apply final position
    this.popup.style.left = `${finalX}px`;
    this.popup.style.top = `${finalY}px`;

    // Store positioning info for debugging if needed
    this.popup.dataset.positionedAbove = positionedAbove;
  }

  renderContent(text) {
    this.popup.className = "citation-popup";
    this.fullText = text;

    this.popup.innerHTML = "";

    // Create tab header
    const header = this.#createTabHeader();
    this.popup.appendChild(header);

    // Create content container
    const content = document.createElement("div");
    content.className = "citation-popup-content";
    this.popup.appendChild(content);

    // Render reference tab content
    this.#renderReferenceContent(content, text);
  }

  #createTabHeader() {
    const header = document.createElement("div");
    header.className = "citation-popup-header";

    const tabs = document.createElement("div");
    tabs.className = "citation-popup-tabs";

    // Reference tab
    const refTab = document.createElement("button");
    refTab.className = "citation-tab active";
    refTab.dataset.tab = "reference";
    refTab.textContent = "Reference";
    refTab.addEventListener("click", () => this.#switchTab("reference"));

    // Abstract tab
    const absTab = document.createElement("button");
    absTab.className = "citation-tab";
    absTab.dataset.tab = "abstract";
    absTab.textContent = "Abstract";
    absTab.addEventListener("click", () => this.#switchTab("abstract"));

    tabs.appendChild(refTab);
    tabs.appendChild(absTab);
    header.appendChild(tabs);

    return header;
  }

  #switchTab(tabName) {
    if (this.activeTab === tabName) return;

    this.activeTab = tabName;

    // Update tab button states
    const tabs = this.popup.querySelectorAll(".citation-tab");
    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
    });

    const content = this.popup.querySelector(".citation-popup-content");

    if (tabName === "reference") {
      this.#renderReferenceContent(content, this.fullText);
    } else if (tabName === "abstract") {
      this.#renderAbstractContent(content);
    }

    this.positionPopup();
  }

  #renderReferenceContent(container, text) {
    container.innerHTML = "";
    container.className = "citation-popup-content";

    const needsCollapse = text.length > 250;

    const textElement = document.createElement("span");
    textElement.className = "citation-popup-text";

    if (needsCollapse) {
      // Start collapsed - show truncated text with inline "..." button
      const truncatedText = text.substring(0, this.truncatedLength);
      this.renderTextWithLinks(textElement, truncatedText);

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "citation-popup-toggle";
      toggleBtn.textContent = "...";
      toggleBtn.title = "Show more";
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.isExpanded = !this.isExpanded;
        this.#updateTextDisplay(textElement, toggleBtn);
        this.positionPopup();
      });

      container.appendChild(textElement);
      container.appendChild(toggleBtn);
    } else {
      this.renderTextWithLinks(textElement, text);
      container.appendChild(textElement);
    }
  }

  #updateTextDisplay(textElement, toggleBtn) {
    if (this.isExpanded) {
      this.renderTextWithLinks(textElement, this.fullText);
      toggleBtn.textContent = "−";
      toggleBtn.title = "Show less";
      toggleBtn.classList.add("expanded");
    } else {
      const truncatedText = this.fullText.substring(0, this.truncatedLength);
      this.renderTextWithLinks(textElement, truncatedText);
      toggleBtn.textContent = "...";
      toggleBtn.title = "Show more";
      toggleBtn.classList.remove("expanded");
    }
  }

  async #renderAbstractContent(container) {
    container.innerHTML = "";
    container.className = "citation-popup-content citation-popup-abstract";

    // If we already have data, render it
    if (this.scholarData) {
      this.#renderScholarData(container, this.scholarData);
      return;
    }

    // If we had an error, show error with retry button
    if (this.scholarError) {
      this.#renderScholarError(container, this.scholarError);
      return;
    }

    // If not loading yet, start loading
    if (!this.isLoadingScholar) {
      this.isLoadingScholar = true;
      this.#renderLoadingSkeleton(container);

      try {
        // Check if we're in extension context
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          const response = await chrome.runtime.sendMessage({
            type: "FETCH_SCHOLAR",
            query: this.fullText,
          });

          if (response.success && response.data) {
            const parsed = this.#parseScholarResult(
              response.data.html,
              response.data.query,
            );
            this.scholarData = parsed;
            this.#renderScholarData(container, parsed);
          } else {
            this.scholarError = response.error || "No results found";
            this.#renderScholarError(container, this.scholarError);
          }
        } else {
          // Not in extension context
          this.scholarError = "Extension context required";
          this.#renderScholarError(
            container,
            "Scholar search requires the browser extension",
          );
        }
      } catch (error) {
        console.error("Scholar fetch error:", error);
        this.scholarError = error.message;
        this.#renderScholarError(container, error.message);
      } finally {
        this.isLoadingScholar = false;
        this.positionPopup();
      }
    } else {
      // Already loading, show skeleton
      this.#renderLoadingSkeleton(container);
    }
  }

  #renderLoadingSkeleton(container) {
    container.innerHTML = `
      <div class="citation-skeleton">
        <div class="skeleton-bar skeleton-title"></div>
        <div class="skeleton-bar skeleton-authors"></div>
        <div class="skeleton-bar skeleton-abstract"></div>
        <div class="skeleton-bar skeleton-abstract"></div>
        <div class="skeleton-bar skeleton-abstract short"></div>
      </div>
    `;
  }

  #renderScholarData(container, data) {
    container.innerHTML = "";

    // Title (linked to paper)
    const titleEl = document.createElement("a");
    titleEl.className = "scholar-title";
    titleEl.textContent = data.title || "Unknown Title";
    titleEl.href = data.link || data.scholarUrl;
    titleEl.target = "_blank";
    titleEl.rel = "noopener noreferrer";
    container.appendChild(titleEl);

    // Authors
    if (data.authors) {
      const authorsEl = document.createElement("div");
      authorsEl.className = "scholar-authors";
      authorsEl.textContent = data.authors;
      container.appendChild(authorsEl);
    }

    // Abstract
    if (data.abstract) {
      const abstractEl = document.createElement("div");
      abstractEl.className = "scholar-abstract";
      abstractEl.textContent = data.abstract;
      container.appendChild(abstractEl);
    } else {
      const noAbstract = document.createElement("div");
      noAbstract.className = "scholar-no-abstract";
      noAbstract.textContent = "Abstract not available in search results";
      container.appendChild(noAbstract);
    }
  }

  #renderScholarError(container, errorMessage) {
    container.innerHTML = "";

    const errorWrapper = document.createElement("div");
    errorWrapper.className = "scholar-error";

    const errorText = document.createElement("div");
    errorText.className = "scholar-error-text";
    errorText.textContent = "Could not fetch abstract";
    errorWrapper.appendChild(errorText);

    // Search on Google Scholar button
    const searchBtn = document.createElement("a");
    searchBtn.className = "scholar-search-btn";
    searchBtn.textContent = "Search on Google Scholar";
    searchBtn.href = `https://scholar.google.com/scholar?q=${encodeURIComponent(this.fullText)}&hl=en`;
    searchBtn.target = "_blank";
    searchBtn.rel = "noopener noreferrer";
    errorWrapper.appendChild(searchBtn);

    container.appendChild(errorWrapper);
  }

  renderTextWithLinks(element, text) {
    const urlRegex = /https?:\/\/[^\s]+./;
    const arxivRegex = /[aA]rXiv:\d{4}\.\d{4,5}/;
    const combinedRegex = new RegExp(
      `(${urlRegex.source}|${arxivRegex.source})`,
    );
    const parts = text.split(combinedRegex);
    const processedArxivIds = new Set();

    element.innerHTML = "";

    parts.forEach((part) => {
      if (part && part.match(urlRegex)) {
        const link = document.createElement("a");
        link.href = part;
        link.textContent = part;
        link.target = "_blank";
        link.style.color = "#1a73e8";
        link.style.textDecoration = "none";
        link.style.borderBottom = "1px solid transparent";
        link.addEventListener("mouseenter", () => {
          link.style.borderBottom = "1px solid #1a73e8";
        });
        link.addEventListener("mouseleave", () => {
          link.style.borderBottom = "1px solid transparent";
        });
        element.appendChild(link);
        const arxivMatch = part.match(
          "/[aA]rxiv\.org\/abs\/(\d{4}\.\d{4,5})/i",
        );
        if (arxivMatch) {
          processedArxivIds.add(arxivMatch[1]);
        }
      } else if (part && part.match(arxivRegex)) {
        const arxivId = part.replace("arXiv:", "");
        if (!processedArxivIds.has(arxivId)) {
          const link = document.createElement("a");
          link.href = `https://arxiv.org/abs/${arxivId}`;
          link.textContent = part;
          link.target = "_blank";
          link.style.color = "#1a73e8";
          link.style.textDecoration = "none";
          link.style.borderBottom = "1px solid transparent";
          link.addEventListener("mouseenter", () => {
            link.style.borderBottom = "1px solid #1a73e8";
          });
          link.addEventListener("mouseleave", () => {
            link.style.borderBottom = "1px solid transparent";
          });
          element.appendChild(link);
          processedArxivIds.add(arxivId);
        }
      } else if (part) {
        element.appendChild(document.createTextNode(part));
      }
    });
  }

  #parseScholarResult(html, query) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    console.log("start parsing");

    // Find first result
    const firstResult = doc.querySelector(".gs_ri");
    if (!firstResult) {
      return null;
    }

    // Extract title and link from gs_rt
    const titleEl = firstResult.querySelector(".gs_rt a");
    const title = titleEl?.textContent?.trim() || null;
    const link = titleEl?.href || null;

    // Extract authors from gs_a (contains authors, journal, year)
    const authorsEl = firstResult.querySelector(".gs_a");
    const authorsText = authorsEl?.textContent?.trim() || null;

    // Extract abstract/snippet from gs_rs
    const abstractEl = firstResult.querySelector(".gs_rs");
    const abstract = abstractEl?.textContent?.trim() || null;

    // Build scholar search URL
    const scholarUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`;

    return {
      title,
      link,
      authors: authorsText,
      abstract,
      scholarUrl,
    };
  }

  showError(message) {
    this.popup.className = "citation-popup error";
    this.popup.innerHTML = `${message}`;
  }

  scheduleClose() {
    this.cancelClose();
    this.closeTimer = setTimeout(() => {
      if (!this.isMouseOverPopup && !this.isMouseOverAnchor) {
        this.hide();
      }
    }, 200);
  }

  cancelClose() {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  // Called when anchor mouse enter happens
  onAnchorEnter() {
    this.isMouseOverAnchor = true;
    this.cancelClose();
  }

  // Called when anchor mouse leave happens
  onAnchorLeave() {
    this.isMouseOverAnchor = false;
    this.scheduleClose();
  }

  hide(immediate = false) {
    this.cancelClose();

    if (immediate) {
      this.popup.style.display = "none";
      this.popup.style.opacity = "0";
      this.currentAnchor = null;
      this.isExpanded = false;
      this.isMouseOverAnchor = false;
      this.isMouseOverPopup = false;
      this.fullText = "";
      this.scholarData = null;
      this.scholarError = null;
      this.isLoadingScholar = false;
      this.activeTab = "reference";
      return;
    }

    this.popup.style.opacity = "0";
    this.popup.style.transform = "translateY(-10px) scale(0.95)";
    setTimeout(() => {
      this.popup.style.display = "none";
      this.currentAnchor = null;
      this.isExpanded = false;
      this.isMouseOverAnchor = false;
      this.isMouseOverPopup = false;
      this.fullText = "";
      this.scholarData = null;
      this.scholarError = null;
      this.isLoadingScholar = false;
      this.activeTab = "reference";
    }, 300);
  }
}
