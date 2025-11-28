export class CitationPopup {
  constructor() {
    this.popup = null;
    this.currentAnchor = null;
    this.isExpanded = false;
    this.closeTimer = null;
    this.isMouseOverPopup = false;
    this.isMouseOverAnchor = false;
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

    // If showing a different anchor while one is open, close immediately and show new one
    if (this.currentAnchor && this.currentAnchor !== anchor) {
      this.hide(true); // immediate hide
    }

    this.currentAnchor = anchor;
    this.isExpanded = false;
    this.isMouseOverAnchor = true;

    // Cancel any pending close operations
    this.cancelClose();

    // Initial positioning - will be adjusted after content loads
    this.popup.style.display = "block";
    this.popup.style.transform = "translateY(-10px) scale(0.95)";

    // Position popup initially (will be refined after content loads)
    this.positionPopup();

    // Trigger reflow
    this.popup.offsetHeight;

    // Animate in
    this.popup.style.opacity = "1";
    this.popup.style.transform = "translateY(0) scale(1)";

    try {
      const result = await findCiteTextCallback(left, pageIndex, top);

      if (!result) {
        this.showError("Reference not found");
        return;
      }
      this.renderContent(result);
      // Adjust position after content is loaded
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
    const needsCollapse = text.length > 250;

    const textElement = document.createElement("p");
    textElement.className = "citation-popup-text";
    if (needsCollapse) {
      textElement.classList.add("collapsed");
    }
    this.renderTextWithLinks(textElement, text);

    this.popup.innerHTML = "";
    this.popup.appendChild(textElement);

    if (needsCollapse) {
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "citation-popup-toggle";
      toggleBtn.textContent = "Show more";
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.isExpanded = !this.isExpanded;
        if (this.isExpanded) {
          textElement.classList.remove("collapsed");
          toggleBtn.textContent = "Show less";
        } else {
          textElement.classList.add("collapsed");
          toggleBtn.textContent = "Show more";
        }
        this.positionPopup();
      });
      this.popup.appendChild(toggleBtn);
    }
  }

  renderTextWithLinks(element, text) {
    const urlRegex = /https?:\/\/[^\s]+./;
    const arxivRegex = /[aA]rXiv:\d{4}\.\d{4,5}/;
    const combinedRegex = new RegExp(
      `(${urlRegex.source}|${arxivRegex.source})`,
    );
    const parts = text.split(combinedRegex);
    console.log(parts);
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

  showError(message) {
    this.popup.className = "citation-popup error";
    this.popup.innerHTML = `
      <button class="citation-popup-close" onclick="this.closest('.citation-popup').style.display='none'">×</button>
      ${message}
    `;
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
    }, 300);
  }
}
