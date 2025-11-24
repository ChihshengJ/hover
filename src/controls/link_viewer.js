export class CitationPopup {
  constructor() {
    this.popup = null;
    this.currentAnchor = null;
    this.isExpanded = false;
    this.hoverTimer = null;
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
        this.scheduleClose();
      }
    });

    this.popup.addEventListener("mouseenter", () => {
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
      }
    });

    this.popup.addEventListener("mouseleave", () => {
      this.scheduleClose();
    });
  }

  async show(anchor, findCiteTextCallback, left, pageIndex, top) {
    this.currentAnchor = anchor;
    this.isExpanded = false;

    // Position popup near the anchor
    const rect = anchor.getBoundingClientRect();
    const popupX = rect.left - 25;
    const popupY = rect.bottom + 8;

    this.popup.style.left = `${popupX}px`;
    this.popup.style.top = `${popupY}px`;
    this.popup.style.display = "block";
    this.popup.style.opacity = "1";

    try {
      const result = await findCiteTextCallback(left, pageIndex, top);

      if (!result) {
        this.showError("Reference not found");
        return;
      }
      this.renderContent(result);
      this.adjustPosition();
    } catch (error) {
      console.error("Error loading citation:", error);
      this.showError("Failed to load reference");
    }
  }

  renderContent(text) {
    this.popup.className = "citation-popup";
    const needsCollapse = text.length > 250;

    const textElement = document.createElement("p");
    textElement.className = "citation-popup-text";
    if (needsCollapse) {
      textElement.classList.add("collapsed");
    }
    // textElement.textContent = text;
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
        this.adjustPosition();
      });
      this.popup.appendChild(toggleBtn);
    }
  }

  renderTextWithLinks(element, text) {
    // Regex to match URLs
    const urlRegex = /(https?:\/\/[^\s]+)./g;
    const parts = text.split(urlRegex);

    element.innerHTML = ""; // Clear existing content

    parts.forEach((part, index) => {
      if (part.match(urlRegex)) {
        const link = document.createElement("a");
        link.href = part;
        link.textContent = part;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.style.color = "#1a73e8";
        link.style.textDecoration = "none";
        link.style.borderBottom = "1px solid #1a73e8";
        link.addEventListener("mouseenter", () => {
          link.style.borderBottom = "1px solid transparent";
        });
        link.addEventListener("mouseleave", () => {
          link.style.borderBottom = "1px solid #1a73e8";
        });
        element.appendChild(link);
      } else {
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

  adjustPosition() {
    // Ensure pop-up stays within viewport
    const rect = this.popup.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Adjust horizontal position if off-screen
    if (rect.right > viewportWidth) {
      this.popup.style.left = `${viewportWidth - rect.width - 16}px`;
    }

    // Adjust vertical position if off-screen
    if (rect.bottom > viewportHeight) {
      const anchorRect = this.currentAnchor?.getBoundingClientRect();
      if (anchorRect) {
        // Show above the anchor instead
        this.popup.style.top = `${anchorRect.top - rect.height - 8}px`;
      }
    }
  }

  scheduleClose() {
    this.hoverTimer = setTimeout(() => {
      this.hide();
    }, 500);
  }

  cancelClose() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  hide() {
    this.popup.style.display = "none";
    this.currentAnchor = null;
    this.isExpanded = false;
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }
}
