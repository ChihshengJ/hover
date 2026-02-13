/**
 * Loading overlay component for PDF initial load.
 * Minimalist design matching the content.js interception overlay
 * for a seamless two-stage loading experience.
 */
export class LoadingOverlay {
  constructor() {
    /** @type {HTMLElement} */
    this.overlay = null;
    /** @type {HTMLElement} */
    this.loadingBar = null;
    /** @type {HTMLElement} */
    this.spinner = null;
    /** @type {HTMLElement} */
    this.titleText = null;
    /** @type {HTMLElement} */
    this.statusText = null;
    /** @type {HTMLElement} */
    this.progressFill = null;

    this.progress = 0;
    this.isVisible = false;
    this.#createDOM();
  }

  #createDOM() {
    // Main overlay — full-screen dark background
    this.overlay = document.createElement("div");
    this.overlay.className = "loading-overlay";

    // Card container
    this.loadingBar = document.createElement("div");
    this.loadingBar.className = "loading-bar";

    // Spinner
    this.spinner = document.createElement("div");
    this.spinner.className = "loading-spinner";

    // Title
    this.titleText = document.createElement("div");
    this.titleText.className = "loading-title";
    this.titleText.textContent = "Hover";

    // Status text
    this.statusText = document.createElement("div");
    this.statusText.className = "loading-status";
    this.statusText.textContent = "Preparing document…";

    // Progress track
    const track = document.createElement("div");
    track.className = "loading-bar-track";

    // Progress fill
    this.progressFill = document.createElement("div");
    this.progressFill.className = "loading-bar-fill";

    // Assemble
    track.appendChild(this.progressFill);

    this.loadingBar.appendChild(this.spinner);
    this.loadingBar.appendChild(this.titleText);
    this.loadingBar.appendChild(this.statusText);
    this.loadingBar.appendChild(track);

    this.overlay.appendChild(this.loadingBar);

    document.body.appendChild(this.overlay);
  }

  /**
   * Show the loading overlay
   */
  show() {
    if (this.isVisible) return;
    this.isVisible = true;

    document.body.classList.add("pdf-loading");

    requestAnimationFrame(() => {
      this.overlay.classList.add("visible");
    });
  }

  /**
   * Update loading progress
   * @param {number} progress - Progress value 0–1
   * @param {string} [status] - Optional status message
   */
  setProgress(progress, status) {
    this.progress = Math.max(0, Math.min(1, progress));
    const percent = Math.round(this.progress * 100);

    // Remove indeterminate if previously set
    this.overlay.classList.remove("indeterminate");

    this.progressFill.style.width = `${percent}%`;

    if (status) {
      this.statusText.textContent = status;
    }
  }

  /**
   * Set indeterminate loading state (when total size unknown)
   * @param {string} [status] - Optional status message
   */
  setIndeterminate(status) {
    this.overlay.classList.add("indeterminate");
    if (status) {
      this.statusText.textContent = status;
    }
  }

  /**
   * Hide the loading overlay with dissolve animation
   * @returns {Promise} Resolves when animation completes
   */
  hide() {
    return new Promise((resolve) => {
      if (!this.isVisible) {
        resolve();
        return;
      }

      // Complete the progress visually before hiding
      this.setProgress(1, "Complete");

      // Brief pause at 100%
      setTimeout(() => {
        this.overlay.classList.add("dissolving");
        this.overlay.classList.remove("visible");

        setTimeout(() => {
          this.isVisible = false;
          document.body.classList.remove("pdf-loading");
          this.overlay.classList.remove("dissolving", "indeterminate");
          this.overlay.remove();
          resolve();
        }, 300);
      }, 100);
    });
  }

  /**
   * Destroy and cleanup immediately (no animation)
   */
  destroy() {
    document.body.classList.remove("pdf-loading");
    this.overlay?.remove();
    this.overlay = null;
  }
}
