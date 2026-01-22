/**
 * Loading overlay component for PDF initial load
 * Shows a glassy loading bar at center of screen with blur backdrop
 */
export class LoadingOverlay {
  constructor() {
    /** @type {HTMLElement} */
    this.overlay = null;
    /** @type {HTMLElement} */
    this.loadingBar = null;
    /** @type {HTMLElement} */
    this.progressFill = null;
    /** @type {HTMLElement} */
    this.progressGlow = null;
    /** @type {HTMLElement} */
    this.percentText = null;

    this.progress = 0;
    this.isVisible = false;
    this.#createDOM();
  }

  #createDOM() {
    this.overlay = document.createElement("div");
    this.overlay.className = "loading-overlay";
    this.loadingBar = document.createElement("div");
    this.loadingBar.className = "loading-bar";
    const track = document.createElement("div");
    track.className = "loading-bar-track";
    this.progressFill = document.createElement("div");
    this.progressFill.className = "loading-bar-fill";
    this.progressGlow = document.createElement("div");
    this.progressGlow.className = "loading-bar-glow";
    this.progressIndicator = document.createElement("div");
    this.progressIndicator.className = "loading-bar-indicator";
    this.progressIndicator.innerHTML = `
      <div class="loading-indicator-core"></div>
      <div class="loading-indicator-glow"></div>
      <div class="loading-indicator-pulse"></div>
    `;
    this.percentText = document.createElement("div");
    this.percentText.className = "loading-percent";
    this.percentText.textContent = "0%";
    this.statusText = document.createElement("div");
    this.statusText.className = "loading-status";
    this.statusText.textContent = "Loading document...";
    track.appendChild(this.progressFill);
    track.appendChild(this.progressGlow);
    track.appendChild(this.progressIndicator);
    this.loadingBar.appendChild(track);
    this.loadingBar.appendChild(this.percentText);
    this.loadingBar.appendChild(this.statusText);
    this.overlay.appendChild(this.loadingBar);
    document.body.appendChild(this.overlay);
  }

  /**
   * Show the loading overlay
   */
  show() {
    if (this.isVisible) return;
    this.isVisible = true;

    // Add body class to indicate loading state
    document.body.classList.add("pdf-loading");

    // Trigger animation
    requestAnimationFrame(() => {
      this.overlay.classList.add("visible");
    });
  }

  /**
   * Update loading progress
   * @param {number} progress - Progress value 0-1
   * @param {string} [status] - Optional status message
   */
  setProgress(progress, status) {
    this.progress = Math.max(0, Math.min(1, progress));
    const percent = Math.round(this.progress * 100);

    // Update fill width
    this.progressFill.style.width = `${percent}%`;
    this.progressGlow.style.width = `${percent}%`;

    // Update indicator position
    this.progressIndicator.style.left = `${percent}%`;

    // Update text
    this.percentText.textContent = `${percent}%`;

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
    this.percentText.textContent = "";
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
        // Start dissolve animation
        this.overlay.classList.add("dissolving");
        this.overlay.classList.remove("visible");

        // Wait for animation to complete
        setTimeout(() => {
          this.isVisible = false;
          document.body.classList.remove("pdf-loading");
          this.overlay.classList.remove("dissolving", "indeterminate");

          // Remove from DOM
          this.overlay.remove();
          resolve();
        }, 200);
      }, 100);
    });
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    document.body.classList.remove("pdf-loading");
    this.overlay?.remove();
    this.overlay = null;
  }
}
