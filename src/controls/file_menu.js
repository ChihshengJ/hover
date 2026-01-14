/**
 * @typedef {import('./window_manager.js').SplitWindowManager} SplitWindowManager;
 */

export class FileMenu {
  /**
   * @param {SplitWindowManager} wm
   */
  constructor(wm) {
    this.wm = wm;
    this.isOpen = false;
    this.isHovered = false;
    this.isNearHitBox = false;

    this.#createDOM();
    this.#setupEventListeners();
  }

  #createDOM() {
    // Hit area for detecting mouse proximity
    this.hitArea = document.createElement("div");
    this.hitArea.className = "file-menu-hit-area";

    // Main container
    this.container = document.createElement("div");
    this.container.className = "file-menu-container";

    // The menu button (rounded square)
    this.button = document.createElement("button");
    this.button.className = "file-menu-button";
    this.button.innerHTML = `
      <div class="file-menu-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="5" r="1.5"/>
          <circle cx="12" cy="12" r="1.5"/>
          <circle cx="12" cy="19" r="1.5"/>
        </svg>
      </div>
    `;

    // Goo bridge element (connects button to menu)
    // this.gooBridge = document.createElement("div");
    // this.gooBridge.className = "file-menu-goo-bridge";

    // Menu list container
    this.menuList = document.createElement("div");
    this.menuList.className = "file-menu-list";
    this.menuList.innerHTML = `
      <button class="file-menu-item" data-action="print">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M6 9V2h12v7"/>
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
          <rect x="6" y="14" width="12" height="8"/>
        </svg>
        <span>Print</span>
        <span class="shortcut">âŒ˜P</span>
      </button>
      <button class="file-menu-item" data-action="save">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span>Save PDF</span>
        <span class="shortcut">âŒ˜S</span>
      </button>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="share">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="18" cy="5" r="3"/>
          <circle cx="6" cy="12" r="3"/>
          <circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        <span>Share</span>
      </button>
      <button class="file-menu-item" data-action="metadata">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>Document Info</span>
      </button>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="tutorial">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>Tutorial</span>
      </button>
    `;

    // Append elements
    // this.container.appendChild(this.gooBridge);
    this.container.appendChild(this.button);
    this.container.appendChild(this.menuList);

    document.body.appendChild(this.hitArea);
    document.body.appendChild(this.container);

    // Add SVG filter for gooey effect
    this.#createGooFilter();
  }

  #createGooFilter() {
    const existingFilter = document.getElementById("file-menu-goo-filter");
    if (existingFilter) return;

    const svgFilter = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svgFilter.style.position = "absolute";
    svgFilter.style.width = "0";
    svgFilter.style.height = "0";
    svgFilter.innerHTML = `
      <defs>
        <filter id="file-menu-goo-filter" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feColorMatrix in="blur" mode="matrix" 
            values="1 0 0 0 0  
                    0 1 0 0 0  
                    0 0 1 0 0  
                    0 0 0 20 -15" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    `;
    document.body.appendChild(svgFilter);
  }

  #setupEventListeners() {
    // Hit area hover detection
    this.hitArea.addEventListener("mouseenter", () => {
      this.isNearHitBox = true;
      this.#activateButton();
    });

    this.hitArea.addEventListener("mouseleave", () => {
      this.isNearHitBox = false;
      if (!this.isHovered && !this.isOpen) {
        this.#deactivateButton();
      }
    });

    // Button hover
    this.button.addEventListener("mouseenter", () => {
      this.isHovered = true;
      this.#activateButton();
    });

    this.button.addEventListener("mouseleave", () => {
      this.isHovered = false;
      if (!this.isNearHitBox && !this.isOpen) {
        this.#deactivateButton();
      }
    });

    // Button click
    this.button.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#toggleMenu();
    });

    // Menu item clicks
    this.menuList.addEventListener("click", (e) => {
      const item = e.target.closest(".file-menu-item");
      if (item) {
        this.#handleAction(item.dataset.action);
      }
    });

    // Close on outside click
    document.addEventListener("click", (e) => {
      if (
        this.isOpen &&
        !this.container.contains(e.target) &&
        !this.hitArea.contains(e.target)
      ) {
        this.#closeMenu();
      }
    });

    // Close on escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        this.#closeMenu();
      }
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        this.#handleAction("print");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        this.#handleAction("save");
      }
    });
  }

  #activateButton() {
    this.container.classList.add("active");
  }

  #deactivateButton() {
    this.container.classList.remove("active");
  }

  #toggleMenu() {
    if (this.isOpen) {
      this.#closeMenu();
    } else {
      this.#openMenu();
    }
  }

  #openMenu() {
    if (this.isOpen) return;
    this.isOpen = true;

    this.container.classList.add("open");
    this.button.classList.add("open");

    // Stagger animate menu items
    const items = this.menuList.querySelectorAll(
      ".file-menu-item, .file-menu-divider",
    );
    items.forEach((item, i) => {
      item.style.setProperty("--item-delay", `${i * 40}ms`);
    });
  }

  #closeMenu() {
    if (!this.isOpen) return;
    this.isOpen = false;

    this.container.classList.remove("open");
    this.button.classList.remove("open");

    if (!this.isHovered && !this.isNearHitBox) {
      this.#deactivateButton();
    }
  }

  #handleAction(action) {
    this.#closeMenu();

    switch (action) {
      case "print":
        this.#print();
        break;
      case "save":
        this.#save();
        break;
      case "share":
        this.#share();
        break;
      case "metadata":
        this.#showMetadata();
        break;
      case "tutorial":
        this.#showTutorial();
        break;
    }
  }

  #print() {
    window.print();
  }

  async #save() {
    const pdfDocument = this.wm.document;

    if (!pdfDocument?.pdfDoc) {
      console.warn("Cannot save: PDF document not available");
      return;
    }

    try {
      // Show saving indicator
      this.#showToast("Saving PDF...");

      // Get PDF data with annotations embedded
      const data = await pdfDocument.saveWithAnnotations();

      // Create blob and download
      const blob = new Blob([data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      const link = window.document.createElement("a");
      link.href = url;
      link.download = this.#getFilename();
      link.click();

      // Clean up
      URL.revokeObjectURL(url);

      if (pdfDocument.hasAnnotations()) {
        this.#showToast("PDF saved with annotations!");
      } else {
        this.#showToast("PDF saved!");
      }
    } catch (error) {
      console.error("Error saving PDF:", error);
      this.#showToast("Error saving PDF");
    }
  }

  #getFilename() {
    let title = window.document.title.replace(" - Hover PDF", "");
    if (!title.toLowerCase().endsWith(".pdf")) {
      title += ".pdf";
    }
    return title;
  }

  #share() {
    const url = window.location.href;

    if (navigator.share) {
      navigator
        .share({
          title: document.title,
          url: url,
        })
        .catch(console.error);
    } else {
      navigator.clipboard
        .writeText(url)
        .then(() => {
          this.#showToast("Link copied to clipboard!");
        })
        .catch(console.error);
    }
  }

  async #showMetadata() {
    const pdfDoc = this.wm.document.pdfDoc;
    if (!pdfDoc) return;

    try {
      const metadata = await pdfDoc.getMetadata();
      const info = metadata.info || {};

      this.#showMetadataModal({
        title: info.Title || "Untitled",
        author: info.Author || "Unknown",
        subject: info.Subject || "",
        keywords: info.Keywords || "",
        creator: info.Creator || "",
        producer: info.Producer || "",
        creationDate: this.#formatPDFDate(info.CreationDate),
        modDate: this.#formatPDFDate(info.ModDate),
        pages: pdfDoc.numPages,
        pdfVersion: metadata.metadata?.get("pdf:PDFVersion") || "Unknown",
      });
    } catch (error) {
      console.error("Failed to get metadata:", error);
    }
  }

  #formatPDFDate(dateStr) {
    if (!dateStr) return "Unknown";
    // PDF dates are in format: D:YYYYMMDDHHmmss
    const match = dateStr.match(
      /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/,
    );
    if (!match) return dateStr;

    const [, year, month, day, hour = "00", min = "00"] = match;
    return `${year}-${month}-${day} ${hour}:${min}`;
  }

  #showMetadataModal(data) {
    // Remove existing modal if any
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";
    overlay.innerHTML = `
      <div class="file-menu-modal">
        <div class="file-menu-modal-header">
          <h2>Document Information</h2>
          <button class="file-menu-modal-close">Ã—</button>
        </div>
        <div class="file-menu-modal-content">
          <div class="metadata-row">
            <span class="metadata-label">Title</span>
            <span class="metadata-value">${data.title}</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-label">Author</span>
            <span class="metadata-value">${data.author}</span>
          </div>
          ${data.subject
        ? `
          <div class="metadata-row">
            <span class="metadata-label">Subject</span>
            <span class="metadata-value">${data.subject}</span>
          </div>`
        : ""
      }
          ${data.keywords
        ? `
          <div class="metadata-row">
            <span class="metadata-label">Keywords</span>
            <span class="metadata-value">${data.keywords}</span>
          </div>`
        : ""
      }
          <div class="metadata-divider"></div>
          <div class="metadata-row">
            <span class="metadata-label">Pages</span>
            <span class="metadata-value">${data.pages}</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-label">Created</span>
            <span class="metadata-value">${data.creationDate}</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-label">Modified</span>
            <span class="metadata-value">${data.modDate}</span>
          </div>
          ${data.creator
        ? `
          <div class="metadata-row">
            <span class="metadata-label">Creator</span>
            <span class="metadata-value">${data.creator}</span>
          </div>`
        : ""
      }
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add("visible");
    });

    // Close handlers
    const close = () => {
      overlay.classList.remove("visible");
      setTimeout(() => overlay.remove(), 300);
    };

    overlay
      .querySelector(".file-menu-modal-close")
      .addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  }

  #showTutorial() {
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";
    overlay.innerHTML = `
    `;

    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.classList.add("visible");
    });

    const close = () => {
      overlay.classList.remove("visible");
      setTimeout(() => overlay.remove(), 300);
    };

    overlay
      .querySelector(".file-menu-modal-close")
      .addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  }

  #showToast(message) {
    const toast = document.createElement("div");
    toast.className = "file-menu-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add("visible");
    });

    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  destroy() {
    this.hitArea?.remove();
    this.container?.remove();
  }
}
