/**
 * Loading overlay component for PDF initial load
 * Shows a glassy loading bar at center of screen with blur backdrop
 * 
 * Supports multiple visual modes:
 * - determinate: normal progress bar
 * - indeterminate: sliding animation for unknown size
 * - processing: shimmer effect for active parsing/processing
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
    /** @type {HTMLElement} */
    this.shimmerEffect = null;

    this.progress = 0;
    this.displayedProgress = 0;
    this.targetProgress = 0;
    this.isVisible = false;
    this.animationFrame = null;
    this.currentPhase = null;
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
    // Shimmer effect for processing state
    this.shimmerEffect = document.createElement("div");
    this.shimmerEffect.className = "loading-bar-shimmer";

    track.appendChild(this.progressFill);
    track.appendChild(this.shimmerEffect);
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
   * Update loading progress with smooth animation
   * @param {number} progress - Progress value 0-1
   * @param {string} [status] - Optional status message
   */
  setProgress(progress, status) {
    // Exit indeterminate mode if we were in it
    this.overlay.classList.remove("indeterminate");
    
    this.targetProgress = Math.max(0, Math.min(1, progress));
    
    // Determine phase from status to apply appropriate styling
    const phase = this.#determinePhase(status);
    if (phase !== this.currentPhase) {
      this.currentPhase = phase;
      this.#applyPhaseStyle(phase);
    }

    if (status) {
      this.statusText.textContent = status;
    }

    // Start smooth animation if not already running
    if (!this.animationFrame) {
      this.#animateProgress();
    }
  }

  /**
   * Determine the loading phase from status message
   * @param {string} status
   * @returns {'download'|'parse'|'process'|'index'|'complete'}
   */
  #determinePhase(status) {
    if (!status) return 'download';
    const s = status.toLowerCase();
    if (s.includes('download')) return 'download';
    if (s.includes('pars')) return 'parse';
    if (s.includes('index') || s.includes('search') || s.includes('reference')) return 'index';
    if (s.includes('complete') || s.includes('ready')) return 'complete';
    return 'process';
  }

  /**
   * Apply visual styling based on current phase
   * @param {'download'|'parse'|'process'|'index'|'complete'} phase
   */
  #applyPhaseStyle(phase) {
    // Remove all phase classes
    this.overlay.classList.remove('phase-download', 'phase-parse', 'phase-process', 'phase-index', 'phase-complete');
    
    // Add current phase class
    this.overlay.classList.add(`phase-${phase}`);
  }

  /**
   * Animate progress smoothly towards target
   */
  #animateProgress() {
    const ease = 0.12; // Easing factor
    const threshold = 0.001;

    const diff = this.targetProgress - this.displayedProgress;
    
    if (Math.abs(diff) < threshold) {
      this.displayedProgress = this.targetProgress;
      this.#updateProgressDisplay();
      this.animationFrame = null;
      return;
    }

    this.displayedProgress += diff * ease;
    this.#updateProgressDisplay();

    this.animationFrame = requestAnimationFrame(() => this.#animateProgress());
  }

  /**
   * Update the visual display of progress
   */
  #updateProgressDisplay() {
    const percent = Math.round(this.displayedProgress * 100);
    const smoothPercent = this.displayedProgress * 100;

    // Update fill width
    this.progressFill.style.width = `${smoothPercent}%`;
    this.progressGlow.style.width = `${smoothPercent}%`;
    this.shimmerEffect.style.width = `${smoothPercent}%`;

    // Update indicator position
    this.progressIndicator.style.left = `${smoothPercent}%`;

    // Update text (use rounded for display)
    this.percentText.textContent = `${percent}%`;
  }

  /**
   * Set indeterminate loading state (when total size unknown)
   * @param {string} [status] - Optional status message
   */
  setIndeterminate(status) {
    this.overlay.classList.add("indeterminate");
    this.overlay.classList.remove('phase-download', 'phase-parse', 'phase-process', 'phase-index', 'phase-complete');
    this.currentPhase = null;
    this.percentText.textContent = "";
    if (status) {
      this.statusText.textContent = status;
    }
  }

  /**
   * Set processing state - shows shimmer effect indicating active work
   * Use this during parsing/indexing phases for visual feedback
   * @param {number} progress - Base progress value 0-1
   * @param {string} [status] - Status message
   */
  setProcessing(progress, status) {
    this.overlay.classList.remove("indeterminate");
    this.overlay.classList.add("processing");
    this.setProgress(progress, status);
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
          this.overlay.classList.remove("dissolving", "indeterminate", "processing");
          this.overlay.classList.remove('phase-download', 'phase-parse', 'phase-process', 'phase-index', 'phase-complete');

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
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    document.body.classList.remove("pdf-loading");
    this.overlay?.remove();
    this.overlay = null;
  }
}
