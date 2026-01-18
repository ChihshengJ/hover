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

    this.fileInput = null;

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

    // Menu list container
    this.menuList = document.createElement("div");
    this.menuList.className = "file-menu-list";
    this.menuList.innerHTML = `
      <button class="file-menu-item" data-action="upload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 8 12 3 17 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <span>Upload</span>
      </button>
      <input type="file" id="file-upload" accept="application/pdf" hidden>
      <div class="file-menu-divider"></div>
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
      <button class="file-menu-item" data-action="cite">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h6v6a6 6 0 0 1-6 6v-2a4 4 0 0 0 4-4H4z"/>
          <path d="M14 5h6v6a6 6 0 0 1-6 6v-2a4 4 0 0 0 4-4h-4z"/>
        </svg>
        <span>Cite</span>
      </button>
      <button class="file-menu-item" data-action="metadata">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="12" y1="7" x2="12" y2="9"/>
        </svg>
        <span>Document Info</span>
      </button>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="tutorial">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
          <line x1="12" y1="16" x2="12" y2="18"/>
        </svg>
        <span>Tutorial</span>
      </button>
    `;

    this.container.appendChild(this.button);
    this.container.appendChild(this.menuList);

    document.body.appendChild(this.hitArea);
    document.body.appendChild(this.container);

    this.fileInput = document.getElementById("file-upload");
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

    // File input
    this.fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file || file.type !== "application/pdf") return;

      this.load(file);
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
      case "upload":
        this.#triggerFileUpload();
        break;
      case "print":
        this.#print();
        break;
      case "save":
        this.#save();
        break;
      case "cite":
        this.#showCitation();
        break;
      case "metadata":
        this.#showMetadata();
        break;
      case "tutorial":
        this.#showTutorial();
        break;
    }
  }

  #triggerFileUpload() {
    this.fileInput.value = "";
    this.fileInput.click();
  }

  async load(file) {
    if (!file) return;

    try {
      const arrayBuffer = await this.#readFileAsArrayBuffer(file);

      // Store in sessionStorage for persistence across reload
      // Convert ArrayBuffer to base64 for storage
      const base64 = this.#arrayBufferToBase64(arrayBuffer);
      sessionStorage.setItem("hover_pdf_data", base64);
      sessionStorage.setItem("hover_pdf_name", file.name);

      // Reload the page to reinitialize with new PDF
      // main.js checks sessionStorage first on load
      window.location.href = window.location.pathname;
    } catch (error) {
      console.error("Error loading file:", error);
      this.#showToast("Failed to load PDF file");
    }
  }

  /**
   * Read file as ArrayBuffer
   * @param {File} file
   * @returns {Promise<ArrayBuffer>}
   */
  #readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e.target.error);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Convert ArrayBuffer to base64 string
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  #arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async #print() {
    const docModel = this.wm.document;

    // If there are annotations, print the saved version with embedded annotations
    try {
      const pdfData = await docModel.saveWithAnnotations();
      const blob = new Blob([pdfData], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "none";
      iframe.src = url;

      iframe.onload = () => {
        setTimeout(() => {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();

          // Clean up after print dialog closes
          setTimeout(() => {
            document.body.removeChild(iframe);
            URL.revokeObjectURL(url);
          }, 1000);
        }, 100);
      };
      document.body.appendChild(iframe);
    } catch (error) {
      console.error("Error printing with annotations:", error);
      window.print();
    }
  }

  async #save() {
    const docModel = this.wm.document;

    try {
      const pdfData = await docModel.saveWithAnnotations();
      const blob = new Blob([pdfData], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = document.title.replace(" - Hover PDF", "") + ".pdf";
      link.click();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error("Error saving PDF:", error);
      const pdfUrl = docModel.pdfDoc?.loadingTask?.source?.url;
      if (pdfUrl) {
        const link = document.createElement("a");
        link.href = pdfUrl;
        link.download = document.title.replace(" - Hover PDF", "") + ".pdf";
        link.click();
      }
    }
  }

  async #showCitation() {
    const pdfDoc = this.wm.document.pdfDoc;
    if (!pdfDoc) {
      this.#showToast("No document loaded");
      return;
    }

    try {
      const metadata = await pdfDoc.getMetadata();
      const info = metadata.info || {};
      const title = info.Title?.trim();

      if (!title) {
        this.#showToast("Cannot determine document title for citation");
        return;
      }

      this.#showToast("Fetching citation data...");

      const citationData = await this.#fetchCitation(title);

      if (citationData) {
        this.#showCitationModal(citationData, title);
      } else {
        this.#showToast("No citation found on Google Scholar");
      }
    } catch (error) {
      console.error("Citation fetch error:", error);
      this.#showToast(error.message || "Error fetching citation");
    }
  }

  /**
   * Send message to background script
   * @param {Object} message
   * @returns {Promise<Object>}
   */
  #sendMessage(message) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        reject(new Error("Chrome runtime not available"));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Fetch citation data from Google Scholar
   * @param {string} title - Document title to search
   * @returns {Promise<Object|null>} Citation data or null if not found
   */
  async #fetchCitation(title) {
    const searchResponse = await this.#sendMessage({
      type: "FETCH_SCHOLAR",
      query: title,
    });
    if (!searchResponse?.success || !searchResponse?.data?.html) {
      throw new Error("Failed to search Google Scholar");
    }
    const paperId = this.#extractPaperId(searchResponse.data.html);
    if (!paperId) {
      return null;
    }
    const citeResponse = await this.#sendMessage({
      type: "FETCH_CITE",
      query: paperId,
    });
    if (!citeResponse?.success || !citeResponse?.data?.html) {
      throw new Error("Failed to fetch citation page");
    }
    return await this.#parseCitationPage(citeResponse.data.html);
  }

  /**
   * Extract paper ID from Google Scholar search results HTML
   * @param {string} html - Search results HTML
   * @returns {string|null} Paper ID or null if not found
   */
  #extractPaperId(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Google Scholar results have data-cid attribute on result containers
    // or we can find it in the cite link
    const firstResult = doc.querySelector(".gs_r[data-cid]");
    if (firstResult) {
      return firstResult.getAttribute("data-cid");
    }

    // Fallback: look for cite link with cluster ID
    // Format: /scholar?cites=PAPER_ID or onclick with data-cid
    const citeLink = doc.querySelector('a[href*="cites="]');
    if (citeLink) {
      const match = citeLink.href.match(/cites=([^&]+)/);
      if (match) return match[1];
    }

    // Another fallback: look in the cite button's onclick or data attribute
    const citeBtn = doc.querySelector(".gs_or_cit[data-cid]");
    if (citeBtn) {
      return citeBtn.getAttribute("data-cid");
    }

    return null;
  }

  /**
   * Parse citation page HTML to extract formatted citations and BibTeX
   * @param {string} html - Citation popup HTML
   * @returns {Promise<Object>} Parsed citation data
   */
  async #parseCitationPage(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Extract citation formats (MLA, APA, Chicago, Harvard, Vancouver)
    const formatElements = doc.querySelectorAll(".gs_cith");
    const citeElements = doc.querySelectorAll(".gs_citr");

    const citations = [];
    const formats = Array.from(formatElements);
    const cites = Array.from(citeElements);

    for (let i = 0; i < formats.length; i++) {
      const format = formats[i]?.textContent?.trim();
      const citation = cites[i]?.textContent?.trim();
      if (format && citation) {
        citations.push({ format, citation });
      }
    }

    // Extract BibTeX link and fetch it
    let bibtex = null;
    const linksContainer = doc.querySelector("#gs_citi");
    if (linksContainer) {
      const bibtexLink = linksContainer.querySelector('a[href*="bib"]');
      if (bibtexLink) {
        const bibtexHref = bibtexLink.getAttribute("href");
        const fullUrl = bibtexHref.startsWith("https")
          ? bibtexHref
          : `https://scholar.google.com${bibtexHref}`;

        try {
          const bibtexResponse = await this.#sendMessage({
            type: "FETCH_WEB",
            query: fullUrl,
          });

          if (bibtexResponse?.success && bibtexResponse?.data) {
            bibtex = bibtexResponse.data.html.trim();
          }
        } catch (error) {
          console.warn("Failed to fetch BibTeX:", error);
        }
      }
    }

    return { citations, bibtex };
  }

  /**
   * Show citation modal with citation formats
   * @param {Object} data - Citation data { citations: [{format, citation}], bibtex: string }
   * @param {string} query - Original search query (document title)
   */
  #showCitationModal(data, query) {
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";

    const { citations, bibtex } = data;

    let citationsHtml = "";

    if (citations.length === 0 && !bibtex) {
      citationsHtml = `
        <div class="citation-no-results">
          <p>No citation formats found</p>
          <p>Try searching directly on <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(query)}" target="_blank">Google Scholar</a></p>
        </div>
      `;
    } else {
      citationsHtml = citations
        .map(
          ({ format, citation }) => `
        <div class="citation-format-card">
          <div class="citation-format-header">
            <span class="citation-format-name">${this.#escapeHtml(format)}</span>
            <button class="citation-copy-btn" data-citation="${this.#escapeHtml(citation)}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              <span>Copy</span>
            </button>
          </div>
          <div class="citation-text">${this.#escapeHtml(citation)}</div>
        </div>
      `,
        )
        .join("");

      if (bibtex) {
        citationsHtml += `
          <div class="citation-format-card bibtex-card">
            <div class="citation-format-header">
              <span class="citation-format-name">BibTeX</span>
              <button class="citation-copy-btn" data-citation="${this.#escapeHtml(bibtex)}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span>Copy</span>
              </button>
            </div>
            <pre class="bibtex-text">${this.#escapeHtml(bibtex)}</pre>
          </div>
        `;
      }
    }

    overlay.innerHTML = `
      <div class="file-menu-modal citation-modal">
        <div class="file-menu-modal-header">
          <h2>Cite This Document</h2>
          <button class="file-menu-modal-close">✕</button>
        </div>
        <div class="file-menu-modal-content">
          <div class="citation-search-info">
            <span class="citation-query-text" title="${this.#escapeHtml(query)}">${this.#escapeHtml(this.#truncateText(query, 50))}</span>
            <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(query)}" target="_blank" class="citation-scholar-link">
              Open in Scholar →
            </a>
          </div>
          <div class="citation-formats">
            ${citationsHtml}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add("visible");
    });

    // Close handler
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

    // Escape key to close
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", handleEscape);
      }
    };
    document.addEventListener("keydown", handleEscape);

    // Copy button handlers
    overlay.querySelectorAll(".citation-copy-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const citation = btn.dataset.citation;
        const spanEl = btn.querySelector("span");

        try {
          await navigator.clipboard.writeText(citation);
          spanEl.textContent = "Copied!";
          btn.classList.add("copied");
          setTimeout(() => {
            spanEl.textContent = "Copy";
            btn.classList.remove("copied");
          }, 1500);
        } catch (err) {
          console.error("Failed to copy:", err);
          spanEl.textContent = "Failed";
          setTimeout(() => {
            spanEl.textContent = "Copy";
          }, 1500);
        }
      });
    });
  }

  /**
   * Truncate text with ellipsis
   * @param {string} text
   * @param {number} maxLength
   * @returns {string}
   */
  #truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }

  /**
   * Escape HTML special characters
   * @param {string} str
   * @returns {string}
   */
  #escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
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
          <button class="file-menu-modal-close">✕</button>
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
