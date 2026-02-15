/**
 * BallEditor - Manages the floating ball's gradient style,
 * page-number color, and the interactive gradient editor UI.
 */

export class BallEditor {
  /** @type {string} */
  static BALL_STYLE_KEY = "hover_ball_style";
  /** @type {number} Max gradient stops */
  static MAX_STOPS = 3;

  /**
   * Default ball style matching the CSS variables in _variables.css.
   */
  static DEFAULT_BALL_STYLE = {
    gradient: {
      direction: 120,
      stops: [
        { color: "#ffffff", position: 10 },
        { color: "#fafafa", position: 25 },
        { color: "#bebebe", position: 85 },
      ],
    },
    pageColor: "#000000",
    pageWeight: 300,
  };

  /**
   * @param {Function} showToast - toast function from FileMenu
   */
  constructor(showToast) {
    this.showToast = showToast;

    /** @type {Object|null} Current ball style config */
    this._ballStyle = null;
    /** @type {number} Index of the currently selected gradient stop */
    this._selectedStopIndex = 0;
    /** @type {boolean} Whether a stop is being dragged */
    this._isDraggingStop = false;
    /** @type {number} Debounce timer for saving ball style */
    this._ballSaveTimer = null;
    /** @type {HTMLElement|null} Reference to the settings overlay */
    this._overlay = null;
  }

  // ╍╍╍ Public API ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /** @returns {Object} current ball style */
  get style() {
    return this._ballStyle;
  }

  /**
   * Load ball style from storage.
   * @returns {Promise<Object>}
   */
  async load() {
    this._ballStyle = await this._loadBallStyle();
    return this._ballStyle;
  }

  /**
   * Apply the saved ball style on app startup.
   * Call this once after the viewer is initialized.
   */
  async applyOnStartup() {
    try {
      this._ballStyle = await this._loadBallStyle();
      this._applyBallStyleToDOM(this._ballStyle);
    } catch (err) {
      console.warn("[BallEditor] Failed to apply ball style on startup:", err);
    }
  }

  /**
   * Set the overlay reference so editor methods can find DOM elements.
   * @param {HTMLElement} overlay
   */
  setOverlay(overlay) {
    this._overlay = overlay;
  }

  /**
   * Reset the selected stop index (e.g. when re-opening the modal).
   */
  resetSelection() {
    this._selectedStopIndex = 0;
  }

  // ╍╍╍ Ball Style Storage ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Load ball style from storage, falling back to defaults.
   * @returns {Promise<Object>}
   */
  async _loadBallStyle() {
    const fallback = structuredClone(BallEditor.DEFAULT_BALL_STYLE);

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(BallEditor.BALL_STYLE_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve(this._loadBallStyleLocalStorage(fallback));
            return;
          }
          const data = result[BallEditor.BALL_STYLE_KEY];
          resolve(data ? this._mergeBallStyle(fallback, data) : fallback);
        });
      });
    }

    return this._loadBallStyleLocalStorage(fallback);
  }

  _loadBallStyleLocalStorage(fallback) {
    try {
      const raw = localStorage.getItem(BallEditor.BALL_STYLE_KEY);
      return raw ? this._mergeBallStyle(fallback, JSON.parse(raw)) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Merge saved data with defaults to handle missing/new fields.
   */
  _mergeBallStyle(fallback, saved) {
    return {
      gradient: {
        direction: saved.gradient?.direction ?? fallback.gradient.direction,
        stops:
          Array.isArray(saved.gradient?.stops) &&
            saved.gradient.stops.length > 0
            ? saved.gradient.stops.map((s) => ({
              color: s.color || "#ffffff",
              position: typeof s.position === "number" ? s.position : 50,
            }))
            : fallback.gradient.stops,
      },
      pageColor: saved.pageColor || fallback.pageColor,
      pageWeight: saved.pageWeight || fallback.pageWeight,
    };
  }

  /**
   * Save ball style to storage (debounced for live editing).
   * @param {Object} style
   */
  async _saveBallStyle(style) {
    this._ballStyle = style;

    clearTimeout(this._ballSaveTimer);
    this._ballSaveTimer = setTimeout(() => {
      this._persistBallStyle(style);
    }, 300);
  }

  async _persistBallStyle(style) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [BallEditor.BALL_STYLE_KEY]: style }, () => {
          if (chrome.runtime.lastError) {
            this._saveBallStyleLocalStorage(style);
          }
          resolve();
        });
      });
    }
    this._saveBallStyleLocalStorage(style);
  }

  _saveBallStyleLocalStorage(style) {
    try {
      localStorage.setItem(BallEditor.BALL_STYLE_KEY, JSON.stringify(style));
    } catch (err) {
      console.error("[BallEditor] localStorage write error:", err);
    }
  }

  // ╍╍╍ CSS Helpers ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Build CSS linear-gradient string from ball style config.
   * @param {Object} gradient - { direction, stops }
   * @returns {string}
   */
  _buildGradientCSS(gradient) {
    const sorted = [...gradient.stops].sort((a, b) => a.position - b.position);
    const stopStr = sorted.map((s) => `${s.color} ${s.position}%`).join(", ");
    return `linear-gradient(${gradient.direction}deg, ${stopStr})`;
  }

  /**
   * Convert hex color to "R, G, B" triplet string for --goo-body.
   * @param {string} hex
   * @returns {string}
   */
  _hexToRgbTriplet(hex) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    return `${r}, ${g}, ${b}`;
  }

  // ╍╍╍ Ball Style Application ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Apply ball style to :root CSS custom properties.
   * @param {Object} style
   */
  _applyBallStyleToDOM(style) {
    const root = document.documentElement;
    root.style.setProperty(
      "--ball-body",
      this._buildGradientCSS(style.gradient),
    );

    const midIdx = Math.floor(style.gradient.stops.length / 2);
    const gooColor = style.gradient.stops[midIdx]?.color || "#ffffff";
    root.style.setProperty("--goo-body", this._hexToRgbTriplet(gooColor));

    root.style.setProperty("--page-color", style.pageColor);
    root.style.setProperty("--page-weight", String(style.pageWeight));
  }

  /**
   * Apply ball style to the preview ball in the settings modal.
   * @param {Object} style
   */
  _applyBallStyleToPreview(style) {
    const preview = this._overlay?.querySelector(".ball-preview-container");
    if (!preview) return;

    preview.style.setProperty(
      "--preview-ball-body",
      this._buildGradientCSS(style.gradient),
    );
    preview.style.setProperty("--preview-page-color", style.pageColor);
    preview.style.setProperty(
      "--preview-page-weight",
      String(style.pageWeight),
    );
  }

  /**
   * Update the gradient bar preview.
   */
  _updateGradientBarPreview() {
    const barInner = this._overlay?.querySelector(".gradient-bar-inner");
    if (!barInner) return;
    barInner.style.background = this._buildGradientCSS(
      this._ballStyle.gradient,
    );
  }

  // ╍╍╍ Editor Events ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Set up all event listeners for the ball style editor section.
   * @param {HTMLElement} overlay
   */
  setupEvents(overlay) {
    // ── Direction slider ──
    const dirSlider = overlay.querySelector("#gradient-direction");
    const dirValue = overlay.querySelector("#gradient-direction-value");

    dirSlider.addEventListener("input", () => {
      const deg = parseInt(dirSlider.value, 10);
      dirValue.textContent = `${deg}°`;
      this._ballStyle.gradient.direction = deg;
      this._onBallStyleChanged();
    });

    // ── Add stop button ──
    overlay
      .querySelector("#gradient-add-stop")
      .addEventListener("click", () => {
        const stops = this._ballStyle.gradient.stops;
        if (stops.length >= BallEditor.MAX_STOPS) {
          this.showToast(`Maximum ${BallEditor.MAX_STOPS} color stops`);
          return;
        }

        const sorted = [...stops].sort((a, b) => a.position - b.position);
        let maxGap = 0;
        let gapMid = 50;
        for (let i = 0; i < sorted.length - 1; i++) {
          const gap = sorted[i + 1].position - sorted[i].position;
          if (gap > maxGap) {
            maxGap = gap;
            gapMid = Math.round(
              (sorted[i].position + sorted[i + 1].position) / 2,
            );
          }
        }
        if (sorted[0].position > maxGap) {
          gapMid = Math.round(sorted[0].position / 2);
        }
        if (100 - sorted[sorted.length - 1].position > maxGap) {
          gapMid = Math.round((sorted[sorted.length - 1].position + 100) / 2);
        }

        stops.push({ color: "#999999", position: gapMid });
        this._selectedStopIndex = stops.length - 1;
        this._onBallStyleChanged();
        this.refreshEditor();
      });

    // ── Reset button ──
    overlay.querySelector("#gradient-reset").addEventListener("click", () => {
      this._ballStyle = structuredClone(BallEditor.DEFAULT_BALL_STYLE);
      this._selectedStopIndex = 0;
      this._onBallStyleChanged();
      this.refreshEditor();
      this.showToast("Ball style reset to default");
    });

    // ── Page color native input ──
    const pageColorInput = overlay.querySelector("#page-color-input");
    const pageColorSwatch = overlay.querySelector("#page-color-swatch");
    const pageColorHex = overlay.querySelector("#page-color-hex");

    pageColorInput.addEventListener("input", () => {
      const color = pageColorInput.value;
      pageColorSwatch.style.backgroundColor = color;
      pageColorHex.value = color;
      this._ballStyle.pageColor = color;
      this._onBallStyleChanged();
    });

    pageColorHex.addEventListener("input", () => {
      let val = pageColorHex.value.trim();
      if (!val.startsWith("#")) val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        pageColorInput.value = val;
        pageColorSwatch.style.backgroundColor = val;
        this._ballStyle.pageColor = val;
        this._onBallStyleChanged();
      }
    });

    pageColorHex.addEventListener("change", () => {
      let val = pageColorHex.value.trim();
      if (!val.startsWith("#")) val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        pageColorHex.value = val;
      } else {
        pageColorHex.value = this._ballStyle.pageColor;
      }
    });

    // ── Gradient bar click to add stop ──
    const gradientBar = overlay.querySelector("#gradient-bar");
    gradientBar.addEventListener("click", (e) => {
      if (e.target.closest(".gradient-stop")) return;

      const stops = this._ballStyle.gradient.stops;
      if (stops.length >= BallEditor.MAX_STOPS) return;

      const rect = gradientBar.getBoundingClientRect();
      const pos = Math.round(((e.clientX - rect.left) / rect.width) * 100);

      stops.push({
        color: "#999999",
        position: Math.max(0, Math.min(100, pos)),
      });
      this._selectedStopIndex = stops.length - 1;
      this._onBallStyleChanged();
      this.refreshEditor();
    });
  }

  /**
   * Called whenever any ball style property changes.
   * Updates preview, live DOM, and debounce-saves.
   */
  _onBallStyleChanged() {
    this._applyBallStyleToPreview(this._ballStyle);
    this._applyBallStyleToDOM(this._ballStyle);
    this._updateGradientBarPreview();
    this._saveBallStyle(this._ballStyle);
    this._updateAddStopButton();
  }

  // ╍╍╍ Editor UI Refresh ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Full refresh of the ball editor UI from current state.
   */
  refreshEditor() {
    if (!this._overlay || !this._ballStyle) return;

    const style = this._ballStyle;

    // Direction slider
    const dirSlider = this._overlay.querySelector("#gradient-direction");
    const dirValue = this._overlay.querySelector("#gradient-direction-value");
    if (dirSlider) {
      dirSlider.value = style.gradient.direction;
      dirValue.textContent = `${style.gradient.direction}°`;
    }

    // Gradient bar preview
    this._updateGradientBarPreview();

    // Stop markers
    this._refreshStopMarkers();

    // Stop detail row
    this._refreshStopDetail();

    // Preview ball
    this._applyBallStyleToPreview(style);

    // Page color
    const pageColorInput = this._overlay.querySelector("#page-color-input");
    const pageColorSwatch = this._overlay.querySelector("#page-color-swatch");
    const pageColorHex = this._overlay.querySelector("#page-color-hex");
    if (pageColorInput) {
      pageColorInput.value = style.pageColor;
      pageColorSwatch.style.backgroundColor = style.pageColor;
      pageColorHex.value = style.pageColor;
    }

    // Add stop button state
    this._updateAddStopButton();
  }

  _updateAddStopButton() {
    const btn = this._overlay?.querySelector("#gradient-add-stop");
    if (!btn) return;
    const atMax = this._ballStyle.gradient.stops.length >= BallEditor.MAX_STOPS;
    btn.disabled = atMax;
    btn.title = atMax
      ? `Maximum ${BallEditor.MAX_STOPS} color stops`
      : "Add color stop";
  }

  /**
   * Render stop markers on the gradient bar.
   */
  _refreshStopMarkers() {
    const bar = this._overlay?.querySelector("#gradient-bar");
    if (!bar) return;

    bar.querySelectorAll(".gradient-stop").forEach((el) => el.remove());

    const stops = this._ballStyle.gradient.stops;

    stops.forEach((stop, idx) => {
      const marker = document.createElement("div");
      marker.className =
        "gradient-stop" + (idx === this._selectedStopIndex ? " selected" : "");
      marker.style.left = `${stop.position}%`;
      marker.style.backgroundColor = stop.color;
      marker.dataset.index = idx;

      // Remove button (only shown when selected, and only if >1 stop)
      if (stops.length > 1) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "gradient-stop-remove";
        removeBtn.innerHTML = "×";
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._removeStop(idx);
        });
        marker.appendChild(removeBtn);
      }

      // Hidden color input for this stop
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.className = "gradient-stop-color-input";
      colorInput.value = stop.color;
      colorInput.addEventListener("input", () => {
        stop.color = colorInput.value;
        marker.style.backgroundColor = colorInput.value;
        this._onBallStyleChanged();
        this._refreshStopDetail();
      });
      marker.appendChild(colorInput);

      // Click to select
      marker.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectedStopIndex = idx;
        this._refreshStopMarkers();
        this._refreshStopDetail();
      });

      // Double-click to open color picker
      marker.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        colorInput.click();
      });

      // Drag handling
      this._setupStopDrag(marker, idx, bar);

      bar.appendChild(marker);
    });
  }

  /**
   * Set up drag behavior for a gradient stop marker.
   * Avoids any DOM rebuild during drag — only mutates style.left
   * on the existing marker and updates the data model + previews.
   */
  _setupStopDrag(marker, idx, bar) {
    const onMove = (e) => {
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const rect = bar.getBoundingClientRect();
      const clamped = Math.max(
        0,
        Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)),
      );

      this._ballStyle.gradient.stops[idx].position = clamped;
      marker.style.left = `${clamped}%`;

      // Live-update previews & gradient bar without rebuilding stop markers
      this._applyBallStyleToPreview(this._ballStyle);
      this._applyBallStyleToDOM(this._ballStyle);
      this._updateGradientBarPreview();
      this._saveBallStyle(this._ballStyle);

      // Update the detail row position readout if this stop is selected
      const posLabel = this._overlay?.querySelector(".stop-position-label");
      if (posLabel && this._selectedStopIndex === idx) {
        posLabel.textContent = `${clamped}%`;
      }
    };

    const onUp = () => {
      marker.classList.remove("dragging");
      this._isDraggingStop = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);

      this._refreshStopDetail();
    };

    const onDown = (e) => {
      if (e.target.closest(".gradient-stop-remove")) return;
      if (e.target.closest(".gradient-stop-color-input")) return;

      e.preventDefault();
      e.stopPropagation();

      // Select this stop — update classes directly instead of rebuilding
      this._selectedStopIndex = idx;
      bar.querySelectorAll(".gradient-stop").forEach((el) => {
        el.classList.toggle("selected", el.dataset.index === String(idx));
      });
      this._refreshStopDetail();

      this._isDraggingStop = true;
      marker.classList.add("dragging");

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    };

    marker.addEventListener("mousedown", onDown);
    marker.addEventListener("touchstart", onDown, { passive: false });
  }

  /**
   * Remove a gradient stop.
   */
  _removeStop(idx) {
    const stops = this._ballStyle.gradient.stops;
    if (stops.length <= 1) return;

    stops.splice(idx, 1);

    if (this._selectedStopIndex >= stops.length) {
      this._selectedStopIndex = stops.length - 1;
    }
    if (this._selectedStopIndex === idx) {
      this._selectedStopIndex = Math.max(0, idx - 1);
    }

    this._onBallStyleChanged();
    this.refreshEditor();
  }

  /**
   * Render the selected stop detail row (swatch + hex + position).
   */
  _refreshStopDetail() {
    const container = this._overlay?.querySelector("#gradient-stop-detail");
    if (!container) return;

    const stops = this._ballStyle.gradient.stops;
    const stop = stops[this._selectedStopIndex];

    if (!stop) {
      container.innerHTML = `<span class="empty">No stop selected</span>`;
      container.classList.add("empty");
      return;
    }

    container.classList.remove("empty");
    container.innerHTML = `
      <div class="stop-color-swatch" id="stop-detail-swatch"
           style="background-color: ${stop.color}" title="Click to change color"></div>
      <input type="text" class="stop-hex-input" id="stop-detail-hex"
             value="${stop.color}" spellcheck="false" maxlength="7">
      <span class="stop-position-label">${stop.position}%</span>
    `;

    const swatch = container.querySelector("#stop-detail-swatch");
    const hexInput = container.querySelector("#stop-detail-hex");

    swatch.addEventListener("click", () => {
      const marker = this._overlay?.querySelector(
        `.gradient-stop[data-index="${this._selectedStopIndex}"] .gradient-stop-color-input`,
      );
      if (marker) marker.click();
    });

    hexInput.addEventListener("input", () => {
      let val = hexInput.value.trim();
      if (!val.startsWith("#")) val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        stop.color = val;
        swatch.style.backgroundColor = val;
        this._onBallStyleChanged();
        this._refreshStopMarkers();
      }
    });

    hexInput.addEventListener("change", () => {
      let val = hexInput.value.trim();
      if (!val.startsWith("#")) val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        hexInput.value = val;
      } else {
        hexInput.value = stop.color;
      }
    });
  }
}
