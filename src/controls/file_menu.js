/**
 * @typedef {import('./window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../settings/onboarding.js').OnboardingWalkThrough} OnboardingWalkThrough;
 */

import { OnboardingWalkthrough } from "../settings/onboarding.js";
import { WallpaperSettings } from "../settings/settings.js";
import { requestThrottle } from "./request_throttle.js";

const VERSION = "0.1.0 (Alpha)";

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

    /** @type {boolean} Guard against concurrent cite fetches */
    this.isFetchingCitation = false;

    /** @type {OnboardingWalkthrough|null} */
    this.onboarding = null;

    /** @type {WallpaperSettings} */
    this.wallpaperSettings = new WallpaperSettings(wm, (msg) =>
      this.#showToast(msg),
    );

    this.#createDOM();
    this.#setupEventListeners();

    // Apply saved wallpaper on startup
    this.wallpaperSettings.applyOnStartup();
  }

  #createDOM() {
    this.hitArea = document.createElement("div");
    this.hitArea.className = "file-menu-hit-area";

    this.container = document.createElement("div");
    this.container.className = "file-menu-container";

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

    this.menuList = document.createElement("div");
    this.menuList.className = "file-menu-list";
    this.menuList.innerHTML = `
      <button class="file-menu-item" data-action="import">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-upload" viewBox="0 0 16 16">
          <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/>
          <path d="M7.646 1.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 2.707V11.5a.5.5 0 0 1-1 0V2.707L5.354 4.854a.5.5 0 1 1-.708-.708z"/>
        </svg>
        <span>Import</span>
      </button>
      <input type="file" id="file-import" accept="application/pdf" hidden>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="print">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-printer" viewBox="0 0 16 16">
          <path d="M2.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1"/>
          <path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2zM4 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2H4zm1 5a2 2 0 0 0-2 2v1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v-1a2 2 0 0 0-2-2zm7 2v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1"/>
        </svg>
        <span>Print</span>
        <span class="shortcut">⌘P</span>
      </button>
      <button class="file-menu-item" data-action="save">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-download" viewBox="0 0 16 16">
          <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/>
          <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z"/>
        </svg>
        <span>Save PDF</span>
        <span class="shortcut">⌘S</span>
      </button>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="cite">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h6v6a6 6 0 0 1-6 6v-2a4 4 0 0 0 4-4H4z"/>
          <path d="M14 5h6v6a6 6 0 0 1-6 6v-2a4 4 0 0 0 4-4h-4z"/>
        </svg>
        <span>Cite</span>
      </button>
      <button class="file-menu-item" data-action="view-original">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <!-- <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"> -->
        <!--   <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/> -->
        <!--   <polyline points="15 3 21 3 21 9"/> -->
        <!--   <line x1="10" y1="14" x2="21" y2="3"/> -->
        <!-- </svg> -->
        <span>View Original</span>
      </button>
      <button class="file-menu-item" data-action="metadata">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        </svg>
        <span>Document Info</span>
      </button>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>Settings</span>
      </button>
      <button class="file-menu-item" data-action="tutorial">
        <!-- <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-question-circle" viewBox="0 0 16 16"> -->
        <!--   <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/> -->
        <!--   <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286m1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94"/> -->
        <!-- </svg> -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        </svg>
        <span>Tutorial</span>
      </button>
      <div class="file-menu-divider"></div>
      <button class="file-menu-item" data-action="about">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        </svg>
        <span>About</span>
      </button>
    `;

    this.container.appendChild(this.button);
    this.container.appendChild(this.menuList);

    document.body.appendChild(this.hitArea);
    document.body.appendChild(this.container);

    this.fileInput = document.getElementById("file-import");
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
      case "import":
        this.#triggerFileImport();
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
        this.#startTutorial();
        break;
      case "settings":
        this.#showSettings();
        break;
      case "about":
        this.#showAbout();
        break;
      case "view-original":
        this.#viewOriginal();
        break;
    }
    if (!["import"].includes(action)) {
      this.#closeMenu();
    }
  }

  #triggerFileImport() {
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
    // Guard against spamming the Cite button
    if (this.isFetchingCitation) return;

    const docModel = this.wm.document;
    if (!docModel?.pdfDoc) {
      this.#showToast("No document loaded");
      return;
    }

    try {
      const title = await docModel.getDocumentTitle();

      if (!title) {
        this.#showToast("Cannot determine document title for citation");
        return;
      }

      this.isFetchingCitation = true;
      this.#showToast("Fetching citation data...");

      const citationData = await requestThrottle.fetch(`cite:${title}`, () =>
        this.#fetchCitation(title),
      );

      if (citationData) {
        this.#showCitationModal(citationData, title);
      } else {
        this.#showToast("No citation found on Google Scholar");
      }
    } catch (error) {
      console.error("Citation fetch error:", error);
      this.#showToast(error.message || "Error fetching citation");
    } finally {
      this.isFetchingCitation = false;
    }
  }

  #showSettings() {
    this.wallpaperSettings.open();
  }

  #viewOriginal() {
    const url =
      document.documentElement.dataset.hoverOriginalUrl ||
      new URLSearchParams(window.location.search).get("url");

    if (!url) {
      this.#showToast("No source URL available for this document");
      return;
    }

    chrome.runtime.sendMessage({ type: "BYPASS_NEXT", url }, () => {
      window.open(url, "_blank");
    });
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
          <button class="file-menu-modal-close">×</button>
        </div>
        <div class="file-menu-modal-content">
          <div class="citation-search-info">
            <span class="citation-query-text" title="${this.#escapeHtml(query)}">${this.#escapeHtml(this.#truncateText(query, 50))}</span>
            <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(query)}" target="_blank" class="citation-scholar-link">
              Open in Google Scholar ->
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
   * @param {string} text
   * @param {number} maxLength
   * @returns {string}
   */
  #truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }

  /**
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
    const pdfDoc = this.wm.document;
    if (!pdfDoc) return;

    try {
      const info = await pdfDoc.getMetadata();

      this.#showMetadataModal({
        title: info.title || "Untitled",
        author: info.author || "Unknown",
        subject: info.subject || "",
        keywords: info.keywords || "",
        creator: info.creator || "",
        producer: info.producer || "",
        creationDate: this.#formatPDFDate(info.creationDate),
        modDate: this.#formatPDFDate(info.modificationDate),
        pages: pdfDoc.numPages,
        custom: info.custom,
      });
    } catch (error) {
      console.error("Failed to get metadata:", error);
    }
  }

  #formatPDFDate(dateStr) {
    if (!dateStr) return "Unknown";
    let dateObj;

    if (dateStr instanceof Date) {
      dateObj = dateStr;
    } else if (typeof dateStr === "string") {
      const pdfMatch = dateStr.match(
        /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/,
      );

      if (pdfMatch) {
        const [, year, month, day, hour = "00", min = "00"] = pdfMatch;
        return `${year}-${month}-${day} ${hour}:${min}`;
      }
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        dateObj = parsed;
      } else {
        return dateStr;
      }
    } else {
      return "Unknown";
    }

    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    const hour = String(dateObj.getHours()).padStart(2, "0");
    const min = String(dateObj.getMinutes()).padStart(2, "0");

    return `${year}-${month}-${day} ${hour}:${min}`;
  }

  #showMetadataModal(data) {
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";
    overlay.innerHTML = `
      <div class="file-menu-modal">
        <div class="file-menu-modal-header">
          <h2>Document Information</h2>
          <button class="file-menu-modal-close">×</button>
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
          ${data.custom.DOI
        ? `
            <div class="metadata-row">
              <span class="metadata-label">DOI</span>
              <span class="metadata-value">${data.custom.DOI}</span>
            </div>
          `
        : ""
      }
          ${data.custom.License
        ? `
            <div class="metadata-row">
              <span class="metadata-label">License</span>
              <span class="metadata-value">${data.custom.License}</span>
            </div>
          `
        : ""
      }
          ${data.custom.arXivID
        ? `
            <div class="metadata-row">
              <span class="metadata-label">arXiv</span>
              <span class="metadata-value">${data.custom.arXivID}</span>
            </div>
          `
        : ""
      }
          ${data.custom["PTEX.Fullbanner"]
        ? `
            <div class="metadata-row">
              <span class="metadata-label">PTEX</span>
              <span class="metadata-value">${data.custom["PTEX.Fullbanner"]}</span>
            </div>
          `
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

  #showAbout() {
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";
    overlay.innerHTML = `
      <div class="file-menu-modal">
        <div class="file-menu-modal-header">
          <h2>About</h2>
          <button class="file-menu-modal-close">×</button>
        </div>
        <div class="file-menu-modal-content">
          <div class="metadata-row">
            <span class="metadata-label">Version</span>
            <span class="metadata-value">${VERSION}</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-label">Author</span>
            <span class="metadata-value">
              <a href="https://chihshengj.github.io/">Chihsheng Jin</a>
            </span>
          </div>
          <div class="metadata-row">
            <span class="metadata-label">Feedback</span>
            <span class="metadata-value">If you have any issues or concerns while using this app, please feel free to raise an issue on <a href="https://github.com/ChihshengJ/hover">GitHub</a> or at the support hub.</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-label">Donate</span>
            <span class="metadata-value">
              This app is my first solo project, so if it makes your PDF reading experience any better, please consider donating through the link below. It means a ton to this project and to me! Thank you!
              <br><br>
              <a href="https://www.buymeacoffee.com/chihshengj" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="width: 120px !important;box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;-webkit-box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;" ></a>
            </span>
          </div>
        </div>
      </div>
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

  async #startTutorial() {
    this.#closeMenu();
    // Small delay for menu close animation
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.onboarding = new OnboardingWalkthrough(this.wm, this);
    await this.onboarding.start();
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
