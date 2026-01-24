/**
 * Onboarding Walkthrough for Hover PDF Viewer
 *
 * @typedef {import('./window_manager.js').SplitWindowManager} SplitWindowManager
 * @typedef {import('./controls/floating_toolbar.js').FloatingToolbar} FloatingToolbar
 * @typedef {import('./controls/file_menu.js').FileMenu} FileMenu
 */

/**
 * @typedef {Object} SpotlightConfig
 * @property {number} x - X coordinate (left edge)
 * @property {number} y - Y coordinate (top edge)
 * @property {number} width - Width of spotlight area
 * @property {number} height - Height of spotlight area
 * @property {number} [borderRadius=8] - Border radius for rounded corners
 */

/**
 * @typedef {Object} TooltipConfig
 * @property {string} text - Main tooltip text
 * @property {string} [subtext] - Secondary smaller text
 * @property {'top'|'bottom'|'left'|'right'|'center'} [position='bottom'] - Position relative to spotlight
 * @property {number} [offsetX=0] - X offset from default position
 * @property {number} [offsetY=0] - Y offset from default position
 * @property {boolean} [showNextButton=false] - Show a "Next" button
 * @property {boolean} [showSkipButton=true] - Show skip button
 * @property {string} [nextButtonText='Next'] - Custom text for next button
 */

/**
 * @typedef {Object} StepConfig
 * @property {string} id - Unique step identifier
 * @property {string} type - Step type: 'message' | 'highlight' | 'action' | 'interactive'
 * @property {SpotlightConfig} [spotlight] - Spotlight configuration (null for full overlay or no overlay)
 * @property {TooltipConfig} tooltip - Tooltip configuration
 * @property {string} [waitFor] - Event/state to wait for before auto-advancing
 * @property {Function} [onEnter] - Callback when entering this step
 * @property {Function} [onExit] - Callback when exiting this step
 * @property {number} [autoAdvanceDelay] - Auto-advance after delay (ms)
 * @property {boolean} [noOverlay=false] - If true, hide the overlay for this step
 */

const STORAGE_KEY = "hover_onboarding_completed";
const INTENDED_URL_KEY = "hover_onboarding_intended_url";
const DEFAULT_PAPER_URL = "https://arxiv.org/pdf/2501.19393";

export class OnboardingWalkthrough {
  /**
   * @param {SplitWindowManager} wm - Window manager instance
   * @param {FileMenu} fileMenu - File menu instance
   */
  constructor(wm, fileMenu) {
    /** @type {SplitWindowManager} */
    this.wm = wm;

    /** @type {FileMenu} */
    this.fileMenu = fileMenu;

    /** @type {FloatingToolbar} */
    this.toolbar = wm.toolbar;

    /** @type {number} */
    this.currentStepIndex = -1;

    /** @type {boolean} */
    this.isActive = false;

    /** @type {StepConfig[]} */
    this.steps = this.#defineSteps();

    // DOM Elements
    /** @type {HTMLElement} */
    this.overlayContainer = null;

    /** @type {HTMLElement} */
    this.spotlight = null;

    /** @type {HTMLElement} */
    this.fullOverlay = null;

    /** @type {HTMLElement} */
    this.tooltip = null;

    /** @type {HTMLElement} */
    this.skipButton = null;

    /** @type {HTMLElement} */
    this.indicatorContainer = null;

    // State tracking
    /** @type {Map<string, Function>} */
    this.activeListeners = new Map();

    /** @type {number|null} */
    this.autoAdvanceTimer = null;

    /** @type {HTMLElement[]} */
    this.#toolLabels = [];

    /** @type {HTMLElement|null} */
    this.#circleIndicator = null;

    /** @type {MutationObserver|null} */
    this.#mutationObserver = null;

    // Bound methods for event listeners
    this.#boundHandlers = {
      onResize: this.#handleResize.bind(this),
      onKeyDown: this.#handleKeyDown.bind(this),
    };
  }

  /** @type {Object} */
  #boundHandlers = {};

  /** @type {HTMLElement[]} */
  #toolLabels = [];

  /** @type {HTMLElement|null} */
  #circleIndicator = null;

  /** @type {MutationObserver|null} */
  #mutationObserver = null;

  /** @type {Function|null} */
  #searchRangeFocusCleanup = null;

  // Static Methods - Storage & First Launch Detection

  /**
   * Check if this is the first launch (onboarding not yet completed)
   * @returns {Promise<boolean>}
   */
  static async isFirstLaunch() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        // Fallback for development (use localStorage)
        const completed = localStorage.getItem(STORAGE_KEY);
        resolve(!completed);
        return;
      }

      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          // Fallback to localStorage
          const completed = localStorage.getItem(STORAGE_KEY);
          resolve(!completed);
          return;
        }
        resolve(!result[STORAGE_KEY]);
      });
    });
  }

  /**
   * Mark onboarding as completed
   * @returns {Promise<void>}
   */
  static async markCompleted() {
    return new Promise((resolve) => {
      // Always set localStorage as backup
      localStorage.setItem(STORAGE_KEY, "true");

      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve();
        return;
      }

      chrome.storage.local.set({ [STORAGE_KEY]: true }, () => {
        resolve();
      });
    });
  }

  /**
   * Reset onboarding state (for testing or re-showing tutorial)
   * @returns {Promise<void>}
   */
  static async reset() {
    return new Promise((resolve) => {
      localStorage.removeItem(STORAGE_KEY);

      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve();
        return;
      }

      chrome.storage.local.remove([STORAGE_KEY], () => {
        resolve();
      });
    });
  }

  /**
   * Save the user's intended URL before forcing default paper
   * @param {string} url
   */
  static saveIntendedUrl(url) {
    if (url && url !== DEFAULT_PAPER_URL) {
      sessionStorage.setItem(INTENDED_URL_KEY, url);
    }
  }

  /**
   * Get and clear the saved intended URL
   * @returns {string|null}
   */
  static getAndClearIntendedUrl() {
    const url = sessionStorage.getItem(INTENDED_URL_KEY);
    sessionStorage.removeItem(INTENDED_URL_KEY);
    return url;
  }

  /**
   * Get the default paper URL for onboarding
   * @returns {string}
   */
  static getDefaultPaperUrl() {
    return DEFAULT_PAPER_URL;
  }

  // Step Definitions

  /**
   * Define all onboarding steps
   * @returns {StepConfig[]}
   */
  #defineSteps() {
    return [
      // Step 0: Welcome message (full overlay)
      {
        id: "welcome",
        type: "message",
        spotlight: null,
        tooltip: {
          text: "Hello, welcome to Hover!",
          subtext: "Let's take a quick tour of the features",
          position: "center",
          showNextButton: true,
          nextButtonText: "Get Started",
        },
        onEnter: () => this.#onWelcomeEnter(),
        onExit: () => this.#onWelcomeExit(),
      },

      // Step 1: Progress bar highlight
      {
        id: "progress-bar",
        type: "highlight",
        spotlight: null,
        tooltip: {
          text: "This is the progress bar",
          subtext: "The ticks show the sections of this paper.",
          position: "right",
          showNextButton: true,
        },
        onEnter: () => this.#onProgressBarEnter(),
        onExit: () => this.#onProgressBarExit(),
      },

      // Step 2: File menu button highlight
      {
        id: "file-menu-button",
        type: "action",
        spotlight: null,
        tooltip: {
          text: "This is the file menu",
          subtext: "Click to open it",
          position: "top",
        },
        waitFor: "fileMenuOpened",
        onEnter: () => this.#onFileMenuButtonEnter(),
        onExit: () => this.#onFileMenuButtonExit(),
      },

      // Step 3: File menu expanded
      {
        id: "file-menu-expanded",
        type: "highlight",
        spotlight: null,
        tooltip: {
          text: "Access file management tools like import, print, save, and more",
          subtext: "You can also find this tutorial here anytime",
          position: "top",
          showNextButton: true,
        },
        onEnter: () => this.#onFileMenuExpandedEnter(),
        onExit: () => this.#onFileMenuExpandedExit(),
      },

      // Step 4: Citation link highlight
      {
        id: "citation-link",
        type: "action",
        spotlight: null,
        tooltip: {
          text: "Hover over citation links",
          subtext: "Try hovering on this citation",
          position: "top",
        },
        waitFor: "citationPopupShown",
        onEnter: () => this.#onCitationLinkEnter(),
        onExit: () => this.#onCitationLinkExit(),
      },

      // Step 5: Citation popup - reference tab
      {
        id: "citation-reference",
        type: "action",
        spotlight: null,
        tooltip: {
          text: "The extracted reference appears here",
          subtext:
            "Click the Abstract button to see the abstract from Google Scholar",
          position: "left",
        },
        waitFor: "abstractTabClicked",
        onEnter: () => this.#onCitationReferenceEnter(),
        onExit: () => this.#onCitationReferenceExit(),
      },

      // Step 6: Citation popup - abstract tab
      {
        id: "citation-abstract",
        type: "highlight",
        spotlight: null,
        tooltip: {
          text: "Google Scholar abstract loaded",
          subtext:
            "Now you can preview paper abstracts without leaving the paper",
          position: "left",
          showNextButton: true,
        },
        onEnter: () => this.#onCitationAbstractEnter(),
        onExit: () => this.#onCitationAbstractExit(),
      },

      // Step 7: Floating ball - vertical drag instruction
      {
        id: "ball-vertical-drag",
        type: "action",
        spotlight: null,
        tooltip: {
          text: "This is the floating control ball",
          subtext: "Drag it vertically to scroll the document",
          position: "left",
        },
        waitFor: "ballDraggedVertically",
        autoAdvanceDelay: 10000,
        onEnter: () => this.#onBallVerticalDragEnter(),
        onExit: () => this.#onBallVerticalDragExit(),
      },

      // Step 8: Jump indicators
      {
        id: "jump-indicators",
        type: "highlight",
        spotlight: null,
        tooltip: {
          text: "Drag the ball to the bottom arrow",
          subtext:
            "These two arrows help you jump to the top and bottom quickly",
          position: "left",
          showNextButton: true,
        },
        onEnter: () => this.#onJumpIndicatorsEnter(),
        onExit: () => this.#onJumpIndicatorsExit(),
      },

      // Step 9: Drag ball left to open outline (NO OVERLAY from here)
      {
        id: "ball-drag-left",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Drag the ball to the left",
          subtext: "This opens the paper outline",
          position: "left",
        },
        waitFor: "outlineOpened",
        onEnter: () => this.#onBallDragLeftEnter(),
        onExit: () => this.#onBallDragLeftExit(),
      },

      // Step 10: Outline explanation with pin indicator
      {
        id: "outline-explanation",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Hover over the sections and click arrows to pin expansions",
          subtext:
            "This is the outline of the paper, you can also use it for quick navigation",
          position: "right",
        },
        waitFor: "outlinePinClicked",
        onEnter: () => this.#onOutlineExplanationEnter(),
        onExit: () => this.#onOutlineExplanationExit(),
      },

      // Step 11: Drag ball right to close outline
      {
        id: "ball-drag-right",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Now let's drag the ball to the right",
          subtext: "This closes the outline",
          position: "left",
        },
        waitFor: "outlineClosed",
        onEnter: () => this.#onBallDragRightEnter(),
        onExit: () => this.#onBallDragRightExit(),
      },

      // Step 12: Double-click ball
      {
        id: "ball-double-click",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Double click the ball",
          subtext: "This scrolls the paper to the top",
          position: "left",
        },
        waitFor: "ballDoubleClicked",
        onEnter: () => setTimeout(() => this.#onBallDoubleClickEnter(), 300),
        onExit: () => this.#onBallDoubleClickExit(),
      },

      // Step 13: Right-click ball to expand tools
      {
        id: "ball-expand-tools",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Right-click the ball",
          subtext: "This expands the tool buttons",
          position: "left",
        },
        waitFor: "toolsExpanded",
        onEnter: () => this.#onBallExpandToolsEnter(),
        onExit: () => this.#onBallExpandToolsExit(),
      },

      // Step 14: Tool buttons explanation (all at once)
      {
        id: "tool-buttons",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Tool Buttons",
          subtext: "Click the split button to try split view",
          position: "left",
        },
        waitFor: "splitModeEntered",
        onEnter: () => this.#onToolButtonsEnter(),
        onExit: () => this.#onToolButtonsExit(),
      },

      // Step 15: Exit split mode
      {
        id: "exit-split-mode",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "You're now in split view!",
          subtext:
            "Expand the toolbar and click the split button again to exit",
          position: "left",
        },
        waitFor: "splitModeExited",
        onEnter: () => this.#onExitSplitModeEnter(),
        onExit: () => this.#onExitSplitModeExit(),
      },

      // Step 16: Open search mode
      {
        id: "open-search",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: this.#isMac() ? "Press ⌘F" : "Press Ctrl+F",
          subtext: "This opens the search bar, try to type some words in it",
          position: "bottom",
        },
        waitFor: "searchOpened",
        onEnter: () => this.#onOpenSearchEnter(),
        onExit: () => this.#onOpenSearchExit(),
      },

      // Step 17: Search range explanation
      {
        id: "search-range",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Search Range",
          subtext:
            'Use these fields to limit search. Try "+2" in the "to" field for next 2 pages.',
          position: "top",
          showNextButton: true,
        },
        onEnter: () => this.#onSearchRangeEnter(),
        onExit: () => this.#onSearchRangeExit(),
      },

      //step 18: Close search
      {
        id: "close-search",
        type: "interactive",
        spotlight: null,
        noOverlay: true,
        tooltip: {
          text: "Press ESC to quit search mode",
          subtext: "This is the last step of the tutorial.",
          position: "top",
        },
        waitFor: "searchClosed",
        onEnter: () => this.#onCloseSearchEnter(),
        onExit: () => this.#onCloseSearchExit(),
      },

      // Step 19: Finale - thank you message
      {
        id: "finale",
        type: "message",
        spotlight: null,
        noOverlay: false,
        tooltip: {
          text: "Thank you for choosing Hover",
          subtext: "Hope it helps you enjoy reading papers more.",
          position: "center",
          showNextButton: true,
          nextButtonText: "Start Reading",
          showSkipButton: false,
        },
        onEnter: () => this.#onFinaleEnter(),
        onExit: () => this.#onFinaleExit(),
      },
    ];
  }

  // Public API

  /**
   * Start the onboarding walkthrough
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isActive) return;

    this.isActive = true;
    this.currentStepIndex = -1;

    this.#createDOM();
    this.#attachGlobalListeners();

    await this.#goToStep(0);
  }

  /**
   * Skip/end the onboarding
   * @returns {Promise<void>}
   */
  async skip() {
    await this.#cleanup();
    await OnboardingWalkthrough.markCompleted();
    this.#handlePostOnboarding();
  }

  /**
   * Advance to the next step
   * @returns {Promise<void>}
   */
  async nextStep() {
    if (!this.isActive) return;

    const nextIndex = this.currentStepIndex + 1;
    if (nextIndex >= this.steps.length) {
      await this.#complete();
    } else {
      await this.#goToStep(nextIndex);
    }
  }

  /**
   * Set custom spotlight coordinates for a specific step
   * @param {string} stepId
   * @param {SpotlightConfig} config
   */
  setStepSpotlight(stepId, config) {
    const step = this.steps.find((s) => s.id === stepId);
    if (step) {
      step.spotlight = config;
    }
  }

  /**
   * Set citation link coordinates (convenience method)
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  setCitationLinkPosition(x, y, width, height) {
    this.setStepSpotlight("citation-link", {
      x,
      y,
      width,
      height,
      borderRadius: 4,
    });
  }

  // DOM Creation

  /**
   * Create all DOM elements for the onboarding UI
   */
  #createDOM() {
    // Container for all onboarding elements
    this.overlayContainer = document.createElement("div");
    this.overlayContainer.className = "onboarding-container";
    this.overlayContainer.style.cssText =
      "position:fixed;inset:0;z-index:10000;pointer-events:none;";

    // Full overlay (for message steps)
    this.#createFullOverlay();

    // Spotlight (for highlight/action steps)
    this.#createSpotlight();

    // Tooltip
    this.#createTooltip();

    // Skip button
    this.#createSkipButton();

    // Indicator container
    this.indicatorContainer = document.createElement("div");
    this.indicatorContainer.className = "onboarding-indicators";
    this.overlayContainer.appendChild(this.indicatorContainer);

    document.body.appendChild(this.overlayContainer);
  }

  /**
   * Create the full overlay for message steps
   */
  #createFullOverlay() {
    this.fullOverlay = document.createElement("div");
    this.fullOverlay.className = "onboarding-full-overlay";
    this.overlayContainer.appendChild(this.fullOverlay);
  }

  /**
   * Create the spotlight element
   */
  #createSpotlight() {
    this.spotlight = document.createElement("div");
    this.spotlight.className = "onboarding-spotlight";
    this.overlayContainer.appendChild(this.spotlight);
  }

  /**
   * Create the tooltip element
   */
  #createTooltip() {
    this.tooltip = document.createElement("div");
    this.tooltip.className = "onboarding-tooltip";
    this.tooltip.innerHTML = `
      <p class="onboarding-tooltip-text"></p>
      <p class="onboarding-tooltip-subtext"></p>
      <div class="onboarding-tooltip-buttons"></div>
    `;
    this.overlayContainer.appendChild(this.tooltip);
  }

  /**
   * Create the skip button
   */
  #createSkipButton() {
    this.skipButton = document.createElement("button");
    this.skipButton.className = "onboarding-skip-btn";
    this.skipButton.textContent = "Skip Tutorial";
    this.skipButton.addEventListener("click", () => this.skip());
    this.overlayContainer.appendChild(this.skipButton);
  }

  // Step Navigation

  /**
   * Navigate to a specific step
   * @param {number} index
   */
  async #goToStep(index) {
    // Exit current step
    const currentStep = this.steps[this.currentStepIndex];
    if (currentStep) {
      if (currentStep.waitFor) {
        this.#removeWaitForListener(currentStep.waitFor);
      }
      if (currentStep.onExit) {
        await currentStep.onExit();
      }
    }

    // Clear timers
    if (this.autoAdvanceTimer) {
      clearTimeout(this.autoAdvanceTimer);
      this.autoAdvanceTimer = null;
    }

    // this.tooltip.classList.remove("visible");

    // Update index
    this.currentStepIndex = index;
    const step = this.steps[index];

    // Handle overlay visibility
    if (step.noOverlay) {
      this.#hideOverlay();
    } else if (step.type === "message" || !step.spotlight) {
      this.#showFullOverlay();
    } else {
      this.#showSpotlightOverlay(step.spotlight);
    }

    // Update tooltip content and position (will show if spotlight is available)
    this.#updateTooltip(step.tooltip, step.spotlight, step.noOverlay);

    if (step.tooltip.showSkipButton === false) {
      this.skipButton.classList.remove("visible");
    } else {
      this.skipButton.classList.add("visible");
    }

    if (step.waitFor) {
      this.#setupWaitForListener(step.waitFor);
    }

    // Setup auto-advance timer
    if (step.autoAdvanceDelay) {
      this.autoAdvanceTimer = setTimeout(() => {
        this.nextStep();
      }, step.autoAdvanceDelay);
    }

    // Call onEnter - this may position and show the tooltip if spotlight was null
    if (step.onEnter) {
      await step.onEnter();
    }
  }

  /**
   * Complete the onboarding
   */
  async #complete() {
    const currentStep = this.steps[this.currentStepIndex];
    if (currentStep?.onExit) {
      await currentStep.onExit();
    }

    await this.#cleanup();
    await OnboardingWalkthrough.markCompleted();
    this.#handlePostOnboarding();
  }

  /**
   * Handle post-onboarding (reload with intended URL if exists)
   */
  #handlePostOnboarding() {
    const intendedUrl = OnboardingWalkthrough.getAndClearIntendedUrl();
    if (intendedUrl) {
      // Reload with the user's intended URL
      window.location.href =
        window.location.pathname + "?file=" + encodeURIComponent(intendedUrl);
    }
  }

  /**
   * Cleanup all onboarding elements
   */
  async #cleanup() {
    this.isActive = false;

    // Clear timers
    if (this.autoAdvanceTimer) {
      clearTimeout(this.autoAdvanceTimer);
      this.autoAdvanceTimer = null;
    }

    // Remove listeners
    this.#removeGlobalListeners();
    this.activeListeners.forEach((_, key) => {
      this.#removeWaitForListener(key);
    });

    // Remove mutation observer
    if (this.#mutationObserver) {
      this.#mutationObserver.disconnect();
      this.#mutationObserver = null;
    }

    // Animate out
    this.fullOverlay?.classList.remove("visible");
    this.spotlight?.classList.remove("visible");
    this.tooltip?.classList.remove("visible");
    this.skipButton?.classList.remove("visible");

    // Remove DOM after animation
    await new Promise((resolve) => setTimeout(resolve, 400));
    this.overlayContainer?.remove();
  }

  // Overlay Control

  /**
   * Show full overlay (no spotlight)
   */
  #showFullOverlay() {
    this.spotlight.classList.remove("visible");
    this.fullOverlay.classList.add("visible");
    this.overlayContainer.style.pointerEvents = "auto";
  }

  /**
   * Show spotlight overlay
   * @param {SpotlightConfig} config
   */
  #showSpotlightOverlay(config) {
    this.fullOverlay.classList.remove("visible");
    this.#updateSpotlight(config);
    this.spotlight.classList.add("visible");
    this.spotlight.style.pointerEvents = "none";
    // Allow clicks to pass through to elements below the spotlight
    this.overlayContainer.style.pointerEvents = "none";
  }

  /**
   * Hide all overlays (for interactive steps)
   */
  #hideOverlay() {
    this.fullOverlay.classList.remove("visible");
    this.spotlight.classList.remove("visible");
    this.overlayContainer.style.pointerEvents = "none";
  }

  /**
   * Update spotlight position and size
   * @param {SpotlightConfig} config
   */
  #updateSpotlight(config) {
    if (!config) return;

    const padding = 8;
    this.spotlight.style.left = `${config.x - padding}px`;
    this.spotlight.style.top = `${config.y - padding}px`;
    this.spotlight.style.width = `${config.width + padding * 2}px`;
    this.spotlight.style.height = `${config.height + padding * 2}px`;
    this.spotlight.style.borderRadius = `${config.borderRadius || 8}px`;
  }

  /**
   * Get spotlight config from an element
   * @param {HTMLElement} element
   * @param {number} [padding=0]
   * @returns {SpotlightConfig}
   */
  #getSpotlightFromElement(element, padding = 0) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left - padding,
      y: rect.top - padding,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
      borderRadius: 8,
    };
  }

  // Tooltip Management

  /**
   * Update tooltip content and position
   * @param {TooltipConfig} config
   * @param {SpotlightConfig|null} spotlightConfig
   * @param {boolean} isFloating
   */
  #updateTooltip(config, spotlightConfig, isFloating = false) {
    // Update content
    const textEl = this.tooltip.querySelector(".onboarding-tooltip-text");
    const subtextEl = this.tooltip.querySelector(".onboarding-tooltip-subtext");
    const buttonsEl = this.tooltip.querySelector(".onboarding-tooltip-buttons");

    textEl.textContent = config.text;
    subtextEl.textContent = config.subtext || "";
    subtextEl.style.display = config.subtext ? "block" : "none";

    // Update buttons
    buttonsEl.innerHTML = "";
    if (config.showNextButton) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "onboarding-btn-primary";
      nextBtn.textContent = config.nextButtonText || "Next";
      nextBtn.addEventListener("click", () => this.nextStep());
      buttonsEl.appendChild(nextBtn);
    }

    // Update classes
    this.tooltip.classList.toggle("floating", isFloating);
    this.tooltip.classList.toggle("centered", config.position === "center");

    // If no spotlight config and not centered, onEnter will handle positioning and visibility
    if (!spotlightConfig && config.position !== "center") {
      return;
    }

    // Position the tooltip
    if (config.position === "center") {
      this.tooltip.style.left = "50%";
      this.tooltip.style.top = "50%";
    } else {
      this.#positionTooltip(
        config.position,
        spotlightConfig,
        config.offsetX || 0,
        config.offsetY || 0,
      );
    }

    this.tooltip.classList.add("visible");
  }

  /**
   * Position tooltip relative to spotlight or element
   * @param {'top'|'bottom'|'left'|'right'} position
   * @param {SpotlightConfig|null} spotlightConfig
   * @param {number} offsetX
   * @param {number} offsetY
   */
  #positionTooltip(position, spotlightConfig, offsetX = 0, offsetY = 0) {
    // If no spotlight config provided, don't position - let onEnter handle it
    if (!spotlightConfig) {
      return;
    }

    const tooltipRect = this.tooltip.getBoundingClientRect();
    const gap = 16;

    let x, y;

    const spotX = spotlightConfig.x;
    const spotY = spotlightConfig.y;
    const spotW = spotlightConfig.width;
    const spotH = spotlightConfig.height;

    switch (position) {
      case "top":
        x = spotX + spotW / 2 - tooltipRect.width / 2;
        y = spotY - tooltipRect.height - gap;
        break;
      case "bottom":
        x = spotX + spotW / 2 - tooltipRect.width / 2;
        y = spotY + spotH + gap;
        break;
      case "left":
        x = spotX - tooltipRect.width - gap;
        y = spotY + spotH / 2 - tooltipRect.height / 2;
        break;
      case "right":
        x = spotX + spotW + gap;
        y = spotY + spotH / 2 - tooltipRect.height / 2;
        break;
      default:
        x = spotX + spotW / 2 - tooltipRect.width / 2;
        y = spotY + spotH + gap;
    }

    // Apply offsets
    x += offsetX;
    y += offsetY;

    // Keep within viewport
    x = Math.max(16, Math.min(x, window.innerWidth - tooltipRect.width - 16));
    y = Math.max(16, Math.min(y, window.innerHeight - tooltipRect.height - 16));

    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
  }

  // Event Listeners

  /**
   * Attach global event listeners
   */
  #attachGlobalListeners() {
    window.addEventListener("resize", this.#boundHandlers.onResize);
    document.addEventListener("keydown", this.#boundHandlers.onKeyDown);
  }

  /**
   * Remove global event listeners
   */
  #removeGlobalListeners() {
    window.removeEventListener("resize", this.#boundHandlers.onResize);
    document.removeEventListener("keydown", this.#boundHandlers.onKeyDown);
  }

  /**
   * Handle resize
   */
  #handleResize() {
    const step = this.steps[this.currentStepIndex];
    if (step?.spotlight) {
      this.#updateSpotlight(step.spotlight);
    }
    if (step?.tooltip) {
      this.#positionTooltip(
        step.tooltip.position,
        step.spotlight,
        step.tooltip.offsetX || 0,
        step.tooltip.offsetY || 0,
      );
    }
  }

  /**
   * Handle keydown (but NOT ESC - that's for search)
   * @param {KeyboardEvent} e
   */
  #handleKeyDown(e) {
    // Enter to advance if next button is shown
    if (e.key === "Enter") {
      const step = this.steps[this.currentStepIndex];
      if (step?.tooltip.showNextButton) {
        e.preventDefault();
        this.nextStep();
      }
    }
  }

  /**
   * Setup listener for waitFor event
   * @param {string} eventName
   */
  #setupWaitForListener(eventName) {
    const advance = () => this.nextStep();

    switch (eventName) {
      case "fileMenuOpened": {
        // Watch for file menu open state
        const checkOpen = () => {
          if (this.fileMenu.isOpen) {
            advance();
          }
        };
        const observer = new MutationObserver(() => checkOpen());
        observer.observe(this.fileMenu.container, {
          attributes: true,
          attributeFilter: ["class"],
        });
        this.activeListeners.set(eventName, () => observer.disconnect());
        break;
      }

      case "citationPopupShown": {
        // Watch for citation popup
        const observer = new MutationObserver((mutations) => {
          const popup = document.querySelector(".citation-popup");
          if (
            popup &&
            popup.style.display !== "none" &&
            popup.style.opacity !== "0"
          ) {
            advance();
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        this.activeListeners.set(eventName, () => observer.disconnect());
        break;
      }

      case "abstractTabClicked": {
        // Watch for abstract tab click
        const handler = (e) => {
          if (
            e.target.closest('[data-tab="abstract"]') ||
            e.target.textContent?.includes("Abstract")
          ) {
            document.removeEventListener("click", handler, true);
            // Small delay to let abstract load
            setTimeout(advance, 500);
          }
        };
        document.addEventListener("click", handler, true);
        this.activeListeners.set(eventName, () =>
          document.removeEventListener("click", handler, true),
        );
        break;
      }

      case "ballDraggedVertically": {
        // Watch for ball drag
        let hasDragged = false;
        const mousedownHandler = () => {
          const moveHandler = () => {
            if (
              this.toolbar.isDragging &&
              this.toolbar.dragMode === "vertical" &&
              !hasDragged
            ) {
              hasDragged = true;
              document.removeEventListener("mousemove", moveHandler);
              advance();
            }
          };
          document.addEventListener("mousemove", moveHandler);

          const mouseupHandler = () => {
            document.removeEventListener("mousemove", moveHandler);
            document.removeEventListener("mouseup", mouseupHandler);
          };
          document.addEventListener("mouseup", mouseupHandler);
        };

        this.toolbar.ball.addEventListener("mousedown", mousedownHandler);
        this.activeListeners.set(eventName, () => {
          this.toolbar.ball.removeEventListener("mousedown", mousedownHandler);
        });
        break;
      }

      case "outlineOpened": {
        // Watch for navigation tree visibility
        const check = () => {
          if (
            this.toolbar.isTreeOpen ||
            this.toolbar.navigationTree?.isVisible
          ) {
            clearInterval(interval);
            advance();
          }
        };
        const interval = setInterval(check, 100);
        this.activeListeners.set(eventName, () => clearInterval(interval));
        break;
      }

      case "outlinePinClicked": {
        // Watch for pin/arrow click in outline
        const handler = (e) => {
          if (
            e.target.closest(".nav-tree-toggle") ||
            e.target.closest(".tree-toggle") ||
            e.target.closest(".nav-node-toggle") ||
            e.target.tagName === "svg" ||
            e.target.closest("svg")
          ) {
            document.removeEventListener("click", handler, true);
            advance();
          }
        };
        document.addEventListener("click", handler, true);
        this.activeListeners.set(eventName, () =>
          document.removeEventListener("click", handler, true),
        );
        break;
      }

      case "outlineClosed": {
        // Watch for tree close - start checking after brief delay
        let started = false;
        const startCheck = () => {
          if (started) return;
          started = true;

          const check = () => {
            if (
              !this.toolbar.isTreeOpen &&
              !this.toolbar.navigationTree?.isVisible
            ) {
              clearInterval(interval);
              advance();
            }
          };
          const interval = setInterval(check, 100);
          this.activeListeners.set(eventName, () => clearInterval(interval));
        };

        setTimeout(startCheck, 500);
        break;
      }

      case "ballDoubleClicked": {
        // Watch for double-click on ball
        const handler = () => {
          this.toolbar.ball.removeEventListener("dblclick", handler);
          advance();
        };
        this.toolbar.ball.addEventListener("dblclick", handler);
        this.activeListeners.set(eventName, () =>
          this.toolbar.ball.removeEventListener("dblclick", handler),
        );
        break;
      }

      case "toolsExpanded": {
        // Watch for toolbar expansion
        const check = () => {
          if (this.toolbar.isExpanded) {
            clearInterval(interval);
            advance();
          }
        };
        const interval = setInterval(check, 100);
        this.activeListeners.set(eventName, () => clearInterval(interval));
        break;
      }

      case "splitModeEntered": {
        // Watch for split mode
        const check = () => {
          if (this.wm.isSplit) {
            clearInterval(interval);
            advance();
          }
        };
        const interval = setInterval(check, 100);
        this.activeListeners.set(eventName, () => clearInterval(interval));
        break;
      }

      case "splitModeExited": {
        // Watch for split mode exit - start after brief delay
        let started = false;
        const startCheck = () => {
          if (started) return;
          started = true;

          const check = () => {
            if (!this.wm.isSplit) {
              clearInterval(interval);
              advance();
            }
          };
          const interval = setInterval(check, 100);
          this.activeListeners.set(eventName, () => clearInterval(interval));
        };

        setTimeout(startCheck, 300);
        break;
      }

      case "searchOpened": {
        // Watch for search bar
        const check = () => {
          const searchBar = document.querySelector(".search-bar.visible");
          if (searchBar) {
            clearInterval(interval);
            advance();
          }
        };
        const interval = setInterval(check, 100);
        this.activeListeners.set(eventName, () => clearInterval(interval));
        break;
      }

      case "searchClosed": {
        // Watch for search bar close - start after delay
        let started = false;
        const startCheck = () => {
          if (started) return;
          started = true;

          const check = () => {
            const searchBar = document.querySelector(".search-bar.visible");
            if (!searchBar) {
              clearInterval(interval);
              advance();
            }
          };
          const interval = setInterval(check, 100);
          this.activeListeners.set(eventName, () => clearInterval(interval));
        };

        setTimeout(startCheck, 500);
        break;
      }
    }
  }

  /**
   * Remove waitFor listener
   * @param {string} eventName
   */
  #removeWaitForListener(eventName) {
    const cleanup = this.activeListeners.get(eventName);
    if (cleanup) {
      cleanup();
      this.activeListeners.delete(eventName);
    }
  }

  // Indicator Helpers

  /**
   * Show a pulsing circle indicator on an element
   * @param {HTMLElement} element
   * @returns {HTMLElement}
   */
  #showCircleIndicator(element) {
    const rect = element.getBoundingClientRect();

    const indicator = document.createElement("div");
    indicator.className = "onboarding-indicator onboarding-circle-indicator";
    indicator.style.left = `${rect.left + rect.width / 2 - 15}px`;
    indicator.style.top = `${rect.top + rect.height / 2 - 20}px`;

    this.indicatorContainer.appendChild(indicator);
    this.#circleIndicator = indicator;

    return indicator;
  }

  /**
   * Remove circle indicator
   */
  #removeCircleIndicator() {
    if (this.#circleIndicator) {
      this.#circleIndicator.remove();
      this.#circleIndicator = null;
    }
  }

  /**
   * Show labels for all tool buttons
   * @returns {HTMLElement[]}
   */
  #showToolButtonLabels() {
    const labels = [];
    const buttonConfigs = [
      { action: "horizontal-spread", text: "Spread Mode" },
      { action: "split-screen", text: "Split View" },
      { action: "night-mode", text: "Dark Mode" },
      { action: "fit-width", text: "Fit Width/Height" },
      { action: "zoom-in", text: "Zoom In" },
      { action: "zoom-out", text: "Zoom Out" },
    ];

    const wrapperRect = this.toolbar.wrapper.getBoundingClientRect();
    const gap = 12;

    buttonConfigs.forEach((item, index) => {
      const btn = this.toolbar.wrapper.querySelector(
        `[data-action="${item.action}"]`,
      );
      if (!btn) return;

      const rect = btn.getBoundingClientRect();

      const label = document.createElement("div");
      label.className = "onboarding-tool-label";
      label.textContent = item.text;
      // Position labels to the left of the wrapper, aligned by their right edge
      // For position:absolute elements, right is distance from right edge of positioned ancestor
      label.style.right = `${window.innerWidth - wrapperRect.left + gap}px`;
      label.style.top = `${rect.top + rect.height / 2 - 12}px`;

      this.indicatorContainer.appendChild(label);
      labels.push(label);

      // Stagger animation
      setTimeout(() => {
        label.classList.add("visible");
      }, index * 80);
    });

    this.#toolLabels = labels;
    return labels;
  }

  /**
   * Remove tool button labels
   */
  #removeToolButtonLabels() {
    this.#toolLabels.forEach((label) => {
      label.classList.remove("visible");
      setTimeout(() => label.remove(), 300);
    });
    this.#toolLabels = [];
  }

  // Utility

  /**
   * Check if running on Mac
   * @returns {boolean}
   */
  #isMac() {
    return navigator.platform.toLowerCase().includes("mac");
  }

  // Step-Specific Callbacks

  // --- Step 0: Welcome ---
  #onWelcomeEnter() {
    // Full overlay shown automatically
  }
  #onWelcomeExit() {
    // Nothing to clean up
  }

  // --- Step 1: Progress Bar ---
  #onProgressBarEnter() {
    const progressBar = this.wm.progressBar?.container;
    if (progressBar) {
      const config = this.#getSpotlightFromElement(progressBar, 8);
      this.steps[1].spotlight = config;
      this.#showSpotlightOverlay(config);
      this.#updateTooltip(this.steps[1].tooltip, config);
    }
  }
  #onProgressBarExit() {
    // Nothing to clean up
  }

  // --- Step 2: File Menu Button ---
  #onFileMenuButtonEnter() {
    const button = this.fileMenu.button;
    if (button) {
      const config = this.#getSpotlightFromElement(button, 8);
      this.steps[2].spotlight = config;
      this.#showSpotlightOverlay(config);
      this.#updateTooltip(this.steps[2].tooltip, config);
    }
  }
  #onFileMenuButtonExit() {
    // Nothing to clean up
  }

  // --- Step 3: File Menu Expanded ---
  #onFileMenuExpandedEnter() {
    const container = this.fileMenu.menuList;
    if (container) {
      // Wait a moment for menu to animate open
      setTimeout(() => {
        const config = this.#getSpotlightFromElement(container, 8);
        this.steps[3].spotlight = config;
        this.#showSpotlightOverlay(config);
        this.#updateTooltip(this.steps[3].tooltip, config);
      }, 150);
    }
  }
  #onFileMenuExpandedExit() {
    // Close file menu
    if (this.fileMenu.isOpen) {
      this.fileMenu.container.classList.remove("open");
      this.fileMenu.button.classList.remove("open");
      this.fileMenu.isOpen = false;
    }
  }

  // --- Step 4: Citation Link ---
  #onCitationLinkEnter() {
    const step = this.steps[4];
    const link = document.querySelectorAll("a")[9];
    link.scrollIntoView({
      top: link.style.top,
      block: "center",
      behavior: "instant",
    });
    step.spotlight = this.#getSpotlightFromElement(link, 4);
    if (step.spotlight) {
      this.#showSpotlightOverlay(step.spotlight);
      this.#updateTooltip(step.tooltip, step.spotlight);
    }
  }
  #onCitationLinkExit() {
    // Nothing to clean up
  }

  // --- Step 5: Citation Reference Tab ---
  #onCitationReferenceEnter() {
    this.overlayContainer.style.pointerEvents = "none";

    setTimeout(() => {
      const popup = document.querySelector(".citation-popup");
      if (popup) {
        const config = this.#getSpotlightFromElement(popup, 10);
        this.steps[5].spotlight = config;
        this.#showSpotlightOverlay(config);
        this.#updateTooltip(this.steps[5].tooltip, config);
      }
    }, 200);
  }
  #onCitationReferenceExit() {
    // Nothing to clean up
  }

  // --- Step 6: Citation Abstract Tab ---
  #onCitationAbstractEnter() {
    this.overlayContainer.style.pointerEvents = "none";

    setTimeout(() => {
      const popup = document.querySelector(".citation-popup");
      if (popup) {
        const config = this.#getSpotlightFromElement(popup, 10);
        this.steps[6].spotlight = config;
        this.#showSpotlightOverlay(config);
        this.#updateTooltip(this.steps[6].tooltip, config);
      }
    }, 500);
  }
  #onCitationAbstractExit() {
    // Hide citation popup
    const popup = document.querySelector(".citation-popup");
    if (popup) {
      popup.style.display = "none";
    }
  }

  // --- Step 7: Ball Vertical Drag ---
  #onBallVerticalDragEnter() {
    // Vertically expanded spotlight around the ball
    const wrapper = this.toolbar.wrapper;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const config = {
        x: rect.left - 20,
        y: rect.top - 150,
        width: rect.width + 40,
        height: 300 + rect.height,
        borderRadius: 40,
      };
      this.steps[7].spotlight = config;
      this.#showSpotlightOverlay(config);
      this.#updateTooltip(this.steps[7].tooltip, config);
    }
  }
  #onBallVerticalDragExit() {
    // Nothing to clean up
  }

  // --- Step 8: Jump Indicators ---
  #onJumpIndicatorsEnter() {
    // Focus on jump indicators area
    const wrapper = this.toolbar.wrapper;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      // Jump indicators are positioned around the ball
      const config = {
        x: rect.left - 20,
        y: rect.top - 225,
        width: rect.width + 60,
        height: 450 + rect.height,
        borderRadius: 20,
      };
      this.steps[8].spotlight = config;
      this.#showSpotlightOverlay(config);
      this.#updateTooltip(this.steps[8].tooltip, config);
    }
  }
  #onJumpIndicatorsExit() {
    // Nothing to clean up
  }

  // --- Step 9: Ball Drag Left  ---
  #onBallDragLeftEnter() {
    // Position tooltip near the ball
    const wrapper = this.toolbar.wrapper;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const tooltipConfig = {
        x: rect.left - 20,
        y: rect.top,
        width: rect.width + 20,
        height: rect.height,
      };
      this.#positionTooltip("left", tooltipConfig, -50, 0);
      this.tooltip.classList.add("visible");
    }
  }
  #onBallDragLeftExit() {
    // Nothing to clean up
  }

  // --- Step 10: Outline Explanation ---
  #onOutlineExplanationEnter() {
    // Show blue circle on first toggle arrow after a delay
    setTimeout(() => {
      const toggle = document.querySelector(
        ".nav-tree-toggle, .tree-toggle, .nav-node-toggle",
      );
      if (toggle) {
        this.#showCircleIndicator(toggle);
      }

      // Position tooltip to the right of the tree
      const tree = this.toolbar.navigationTree?.container;
      if (tree) {
        const rect = tree.getBoundingClientRect();
        const tooltipConfig = {
          x: rect.left - 450,
          y: rect.top - 200,
          width: rect.width - 20,
          height: rect.height,
        };
        this.#positionTooltip("right", tooltipConfig, 0, 0);
        this.tooltip.classList.add("visible");
      }
    }, 300);
  }
  #onOutlineExplanationExit() {
    this.#removeCircleIndicator();
  }

  // --- Step 11: Ball Drag Right ---
  #onBallDragRightEnter() {
    // Position tooltip near the ball
    const wrapper = this.toolbar.wrapper;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const tooltipConfig = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this.#positionTooltip("left", tooltipConfig, -50, 0);
      this.tooltip.classList.add("visible");
    }
  }
  #onBallDragRightExit() {
    // Nothing to clean up
  }

  // --- Step 12: Ball Double Click ---
  #onBallDoubleClickEnter() {
    // Show circle indicator on ball
    const ball = this.toolbar.ball;
    if (ball) {
      this.#showCircleIndicator(ball);

      const rect = ball.getBoundingClientRect();
      const tooltipConfig = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this.#positionTooltip("left", tooltipConfig, -50, 0);
      this.tooltip.classList.add("visible");
    }
  }
  #onBallDoubleClickExit() {
    this.#removeCircleIndicator();
  }

  // --- Step 13: Ball Expand Tools ---
  #onBallExpandToolsEnter() {
    // Position tooltip near ball
    const wrapper = this.toolbar.wrapper;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const tooltipConfig = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this.#positionTooltip("left", tooltipConfig, -50, 0);
      this.tooltip.classList.add("visible");
    }
  }
  #onBallExpandToolsExit() {
    // Nothing to clean up
  }

  // --- Step 14: Tool Buttons ---
  #onToolButtonsEnter() {
    // Show all tool button labels
    setTimeout(() => {
      this.#showToolButtonLabels();
    }, 300);

    // Position tooltip
    const wrapper = this.toolbar.wrapper;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const tooltipConfig = {
        x: rect.left,
        y: rect.top - 100,
        width: rect.width,
        height: rect.height + 200,
      };
      this.#positionTooltip("left", tooltipConfig, -50, 0);
      this.tooltip.classList.add("visible");
    }
  }
  #onToolButtonsExit() {
    this.#removeToolButtonLabels();
  }

  // --- Step 15: Exit Split Mode ---
  #onExitSplitModeEnter() {
    // Position tooltip - need to account for split view changing layout
    setTimeout(() => {
      const splitBtn = document.querySelector('[data-action="split-screen"]');
      if (splitBtn) {
        const rect = splitBtn.getBoundingClientRect();
        const tooltipConfig = {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
        this.#positionTooltip("left", tooltipConfig, -200, 0);
        this.tooltip.classList.add("visible");
      }
    }, 300);
  }
  #onExitSplitModeExit() {
    // Nothing to clean up
  }

  // --- Step 16: Open Search ---
  #onOpenSearchEnter() {
    // Position tooltip in center-bottom area
    this.tooltip.style.left = "50%";
    this.tooltip.style.top = "60%";
    this.tooltip.style.transform = "translateX(-50%)";
    this.tooltip.classList.add("visible");
  }
  #onOpenSearchExit() {
    this.tooltip.style.transform = "";
  }

  // --- Step 17: Search Range ---
  #onSearchRangeEnter() {
    setTimeout(() => {
      const rangeSection = document.querySelector(".search-range");
      const searchBar = document.querySelector(".search-bar");

      if (rangeSection) {
        const rect = rangeSection.getBoundingClientRect();
        const baseTooltipConfig = {
          x: rect.left,
          y: rect.top - 20,
          width: rect.width,
          height: rect.height,
        };
        this.#positionTooltip("top", baseTooltipConfig, 0, -10);
        this.tooltip.classList.add("visible");

        const fromInput = rangeSection.querySelector(
          ".search-range-field:first-child .search-range-input",
        );
        const toInput = rangeSection.querySelector(
          ".search-range-field:last-child .search-range-input",
        );

        const shiftTooltip = () => {
          this.#positionTooltip("top", baseTooltipConfig, -300, -10);
        };
        const resetTooltip = () => {
          this.#positionTooltip("top", baseTooltipConfig, 0, -10);
        };

        fromInput?.addEventListener("focus", shiftTooltip);
        fromInput?.addEventListener("blur", resetTooltip);
        toInput?.addEventListener("focus", shiftTooltip);
        toInput?.addEventListener("blur", resetTooltip);

        // Store cleanup function
        this.#searchRangeFocusCleanup = () => {
          fromInput?.removeEventListener("focus", shiftTooltip);
          fromInput?.removeEventListener("blur", resetTooltip);
          toInput?.removeEventListener("focus", shiftTooltip);
          toInput?.removeEventListener("blur", resetTooltip);
        };
      } else if (searchBar) {
        const rect = searchBar.getBoundingClientRect();
        this.tooltip.style.left = `${rect.left + rect.width / 2 - 150}px`;
        this.tooltip.style.top = `${rect.top - 120}px`;
        this.tooltip.classList.add("visible");
      }
    }, 200);
  }
  #onSearchRangeExit() {
    // Clean up focus listeners
    if (this.#searchRangeFocusCleanup) {
      this.#searchRangeFocusCleanup();
      this.#searchRangeFocusCleanup = null;
    }
  }

  // --- Step 18: Close Search ---
  #onCloseSearchEnter() {
    this.tooltip.style.left = "50%";
    this.tooltip.style.top = "60%";
    this.tooltip.style.transform = "translateX(-50%)";
    this.tooltip.classList.add("visible");
  }
  #onCloseSearchExit() {
    this.tooltip.style.transform = "";
  }

  // --- Step 19: Finale ---
  #onFinaleEnter() {
    // Full overlay returns for the finale message
  }
  #onFinaleExit() {
    // Nothing to clean up
  }
}
