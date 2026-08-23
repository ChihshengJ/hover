/**
 * BallEditor - Manages the floating ball's gradient style,
 * page-number color, and the interactive gradient editor UI.
 */

import { Config } from "./config.js";
import { onPointerDrag } from "../pointer_gesture.js";

export class BallEditor {
  /** @type {number} Max gradient stops */
  static MAX_STOPS = 3;

  /** @type {number} Window for reading two marker presses as a double-click */
  static DOUBLE_CLICK_MS = 400;

  /**
   * Default ball style matching the CSS variables in _variables.css.
   * Authoritative copy lives in Config.DEFAULTS.ball_style.
   */
  static get DEFAULT_BALL_STYLE() {
    return Config.DEFAULTS.ball_style;
  }

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
    /** @type {{idx: number, at: number}|null} Last marker press, for double-click */
    this._lastStopDown = null;
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
    return this._mergeBallStyle(fallback, Config.get("ball_style") || {});
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
      persistInNight: saved.persistInNight ?? fallback.persistInNight,
      useThemeButtons: saved.useThemeButtons ?? fallback.useThemeButtons,
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
    await Config.set("ball_style", style);
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

  /**
   * Pick the gradient stop with the largest coverage along the axis.
   * Coverage = midpoint-to-midpoint span (edges clamped to 0/100).
   * @param {Array<{color: string, position: number}>} stops
   * @returns {{color: string, position: number}}
   */
  _dominantStop(stops) {
    const sorted = [...stops].sort((a, b) => a.position - b.position);
    let best = sorted[0];
    let bestSpan = -1;
    for (let i = 0; i < sorted.length; i++) {
      const left =
        i === 0 ? 0 : (sorted[i - 1].position + sorted[i].position) / 2;
      const right =
        i === sorted.length - 1
          ? 100
          : (sorted[i].position + sorted[i + 1].position) / 2;
      const span = right - left;
      if (span > bestSpan) {
        bestSpan = span;
        best = sorted[i];
      }
    }
    return best;
  }

  /**
   * WCAG relative luminance of a hex color, 0..1.
   * @param {string} hex
   * @returns {number}
   */
  _relativeLuminance(hex) {
    const h = hex.replace("#", "");
    const toLin = (v) => {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const r = toLin(parseInt(h.slice(0, 2), 16) || 0);
    const g = toLin(parseInt(h.slice(2, 4), 16) || 0);
    const b = toLin(parseInt(h.slice(4, 6), 16) || 0);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

    const dominant = this._dominantStop(style.gradient.stops);
    const dominantColor = dominant?.color || "#ffffff";
    root.style.setProperty("--goo-body", this._hexToRgbTriplet(dominantColor));
    root.style.setProperty("--theme-btn-color", dominantColor);

    root.style.setProperty("--page-color", style.pageColor);
    root.style.setProperty("--page-weight", String(style.pageWeight));

    const body = document.body;
    body.classList.toggle("ball-night-persist", !!style.persistInNight);
    body.classList.toggle("theme-buttons", !!style.useThemeButtons);
    body.classList.toggle(
      "theme-buttons-dark-icon",
      !!style.useThemeButtons && this._relativeLuminance(dominantColor) < 0.5,
    );
  }

  /**
   * Apply ball style to the preview ball in the settings modal.
   * @param {Object} style
   */
  _applyBallStyleToPreview(style) {
    const preview = /** @type {HTMLElement} */ (this._overlay?.querySelector(".ball-preview-container"));
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
    const barInner = /** @type {HTMLElement} */ (this._overlay?.querySelector(".gradient-bar-inner"));
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
    const dirSlider = /** @type {HTMLInputElement} */ (overlay.querySelector("#gradient-direction"));
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
    const pageColorInput = /** @type {HTMLInputElement} */ (overlay.querySelector("#page-color-input"));
    const pageColorSwatch = /** @type {HTMLElement} */ (overlay.querySelector("#page-color-swatch"));
    const pageColorHex = /** @type {HTMLInputElement} */ (overlay.querySelector("#page-color-hex"));

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

    // ── Night-mode persist toggle ──
    const persistToggle = /** @type {HTMLInputElement} */ (overlay.querySelector(".ball-night-persist-toggle"));
    if (persistToggle) {
      persistToggle.addEventListener("change", () => {
        this._ballStyle.persistInNight = persistToggle.checked;
        this._onBallStyleChanged();
      });
    }

    // ── Use theme color for buttons toggle ──
    const themeBtnsToggle = /** @type {HTMLInputElement} */ (overlay.querySelector(".ball-theme-buttons-toggle"));
    if (themeBtnsToggle) {
      themeBtnsToggle.addEventListener("change", () => {
        this._ballStyle.useThemeButtons = themeBtnsToggle.checked;
        this._onBallStyleChanged();
      });
    }

    // ── Gradient bar click to add stop ──
    const gradientBar = /** @type {HTMLElement} */ (overlay.querySelector("#gradient-bar"));
    gradientBar.addEventListener("click", (e) => {
      if (/** @type {Element} */ (e.target).closest(".gradient-stop")) return;

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
   * Reflect liquid-glass state in the editor by locking the two controls it
   * takes over. Glass is its own material: it samples the page behind the ball
   * for the number color, and it ignores the theme tint entirely in favour of
   * the frost. Both controls keep their saved values — they are only disabled,
   * so switching glass back off restores what the user had.
   * @param {boolean} on
   */
  setGlassActive(on) {
    if (!this._overlay) return;

    // Page-number color: sampled from the content behind the ball.
    const group = this._overlay.querySelector("#page-color-group");
    if (group) group.classList.toggle("adaptive", on);
    const input = /** @type {HTMLInputElement} */ (this._overlay.querySelector("#page-color-input"));
    const hex = /** @type {HTMLInputElement} */ (this._overlay.querySelector("#page-color-hex"));
    if (input) input.disabled = on;
    if (hex) hex.disabled = on;

    // Theme-colored buttons: glass outranks the classic-mode tint.
    const themeBtns = /** @type {HTMLInputElement} */ (this._overlay.querySelector(".ball-theme-buttons-toggle"));
    if (themeBtns) {
      themeBtns.disabled = on;
      themeBtns
        .closest(".settings-toggle-row")
        ?.classList.toggle("glass-locked", on);
    }
  }

  /**
   * Full refresh of the ball editor UI from current state.
   */
  refreshEditor() {
    if (!this._overlay || !this._ballStyle) return;

    const style = this._ballStyle;

    // Direction slider
    const dirSlider = /** @type {HTMLInputElement} */ (this._overlay.querySelector("#gradient-direction"));
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
    const pageColorInput = /** @type {HTMLInputElement} */ (this._overlay.querySelector("#page-color-input"));
    const pageColorSwatch = /** @type {HTMLElement} */ (this._overlay.querySelector("#page-color-swatch"));
    const pageColorHex = /** @type {HTMLInputElement} */ (this._overlay.querySelector("#page-color-hex"));
    if (pageColorInput) {
      pageColorInput.value = style.pageColor;
      pageColorSwatch.style.backgroundColor = style.pageColor;
      pageColorHex.value = style.pageColor;
    }

    // Liquid glass takes over the page-number color and overrides the theme
    // tint, so both of those controls are locked while it's on.
    this.setGlassActive(Config.get("liquid_glass_enabled"));

    // Toggle states
    const persistToggle = /** @type {HTMLInputElement} */ (this._overlay.querySelector(
      ".ball-night-persist-toggle",
    ));
    if (persistToggle) persistToggle.checked = !!style.persistInNight;

    const themeBtnsToggle = /** @type {HTMLInputElement} */ (this._overlay.querySelector(
      ".ball-theme-buttons-toggle",
    ));
    if (themeBtnsToggle) themeBtnsToggle.checked = !!style.useThemeButtons;

    // Add stop button state
    this._updateAddStopButton();
  }

  _updateAddStopButton() {
    const btn = /** @type {HTMLButtonElement} */ (this._overlay?.querySelector("#gradient-add-stop"));
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
    const bar = /** @type {HTMLElement} */ (this._overlay?.querySelector("#gradient-bar"));
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

      // Selection, double-click and drag all start from pointerdown.
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
    /** Set while the current press is the second half of a double-click. */
    let pickerPending = false;

    const onMove = (e) => {
      e.preventDefault();
      const rect = bar.getBoundingClientRect();
      const clamped = Math.max(
        0,
        Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)),
      );

      // A press that moved the stop is a drag, not half of a double-click.
      if (this._ballStyle.gradient.stops[idx].position !== clamped) {
        this._lastStopDown = null;
        pickerPending = false;
      }

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
      this._refreshStopDetail();

      if (pickerPending) {
        pickerPending = false;
        this._openStopColorPicker();
      }
    };

    const onDown = (e) => {
      if (/** @type {Element} */ (e.target).closest(".gradient-stop-remove")) return;

      e.preventDefault();
      e.stopPropagation();

      // Double-click opens the picker, on release — a second press that turns
      // into a drag stays a drag. Tracked here rather than through a `dblclick`
      // listener: this handler suppresses the native gesture, and the marker is
      // rebuilt between clicks, so neither the event nor its target survives on
      // every engine.
      const now = performance.now();
      pickerPending =
        this._lastStopDown?.idx === idx &&
        now - this._lastStopDown.at < BallEditor.DOUBLE_CLICK_MS;
      this._lastStopDown = pickerPending ? null : { idx, at: now };

      // Select this stop — update classes directly instead of rebuilding
      this._selectedStopIndex = idx;
      bar.querySelectorAll(".gradient-stop").forEach((el) => {
        el.classList.toggle("selected", el.dataset.index === String(idx));
      });
      this._refreshStopDetail();

      this._isDraggingStop = true;
      marker.classList.add("dragging");

      onPointerDrag(e, { onMove, onEnd: onUp });
    };

    marker.addEventListener("pointerdown", onDown);
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
   * Open the native picker for the selected stop's color input.
   *
   * WebKit only opens a color picker for an input the user clicked directly,
   * or one `showPicker()` names — and in both cases the input must be laid out
   * and hit-testable. A synthetic `.click()` on an off-screen input, which is
   * what the stop markers used to carry, is silently ignored there while
   * Blink and Gecko honour it. The detail row's input is a real box under the
   * swatch, so it works as a picker anchor on every engine.
   */
  _openStopColorPicker() {
    const input = /** @type {HTMLInputElement} */ (this._overlay?.querySelector("#stop-detail-color"));
    if (!input) return;

    // The input was just re-created by _refreshStopDetail; WebKit needs it
    // laid out before it can anchor a picker to it.
    void input.offsetWidth;

    try {
      input.showPicker();
    } catch {
      // No showPicker (or it refused): the plain activation path still works
      // where the input is rendered.
      input.click();
    }
  }

  /**
   * Render the selected stop detail row (swatch + hex + position).
   */
  _refreshStopDetail() {
    const container = this._overlay?.querySelector("#gradient-stop-detail");
    if (!container) return;

    const idx = this._selectedStopIndex;
    const stops = this._ballStyle.gradient.stops;
    const stop = stops[idx];

    if (!stop) {
      container.innerHTML = `<span class="empty">No stop selected</span>`;
      container.classList.add("empty");
      return;
    }

    container.classList.remove("empty");
    container.innerHTML = `
      <div class="stop-color-swatch" id="stop-detail-swatch"
           style="background-color: ${stop.color}" title="Click to change color">
        <input type="color" class="stop-color-native-input" id="stop-detail-color"
               value="${stop.color}">
      </div>
      <input type="text" class="stop-hex-input" id="stop-detail-hex"
             value="${stop.color}" spellcheck="false" maxlength="7">
      <span class="stop-position-label">${stop.position}%</span>
    `;

    const swatch = /** @type {HTMLElement} */ (container.querySelector("#stop-detail-swatch"));
    const colorInput = /** @type {HTMLInputElement} */ (container.querySelector("#stop-detail-color"));
    const hexInput = /** @type {HTMLInputElement} */ (container.querySelector("#stop-detail-hex"));

    /** Push a new color everywhere without rebuilding the live picker's input. */
    const setColor = (val) => {
      stop.color = val;
      swatch.style.backgroundColor = val;
      const marker = /** @type {HTMLElement} */ (
        this._overlay?.querySelector(`.gradient-stop[data-index="${idx}"]`)
      );
      if (marker) marker.style.backgroundColor = val;
      this._onBallStyleChanged();
    };

    colorInput.addEventListener("input", () => {
      hexInput.value = colorInput.value;
      setColor(colorInput.value);
    });

    hexInput.addEventListener("input", () => {
      let val = hexInput.value.trim();
      if (!val.startsWith("#")) val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        colorInput.value = val;
        setColor(val);
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
