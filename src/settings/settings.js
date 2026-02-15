/**
 * @typedef {import('./window_manager.js').SplitWindowManager} SplitWindowManager
 */

import { WallpaperManager } from "./wallpaper.js";
import { BallEditor } from "./ball_editor.js";

export class Settings {
  /** @type {string} */
  static PROGRESS_BAR_KEY = "hover_progress_bar_enabled";

  /**
   * @param {SplitWindowManager} wm
   * @param {Function} showToast - toast function from FileMenu
   */
  constructor(wm, showToast) {
    this.wm = wm;
    this.showToast = showToast;

    /** @type {WallpaperManager} */
    this.wallpaper = new WallpaperManager(showToast);
    /** @type {BallEditor} */
    this.ballStyle = new BallEditor(showToast);

    /** @type {HTMLElement|null} */
    this._overlay = null;
    /** @type {boolean} */
    this._editMode = false;
    /** @type {Set<string>} IDs selected for deletion */
    this._deleteSet = new Set();
    /** @type {HTMLInputElement|null} */
    this._fileInput = null;
  }

  // ╍╍╍ Public API ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /** Open the settings modal */
  async open() {
    try {
      await this.wallpaper.init();
      await this.ballStyle.load();
      this._editMode = false;
      this._deleteSet.clear();
      this.ballStyle.resetSelection();
      this._renderModal();
    } catch (err) {
      console.error("[Settings] Failed to open:", err);
      this.showToast("Failed to open settings");
    }
  }

  /**
   * Apply saved wallpaper on app startup.
   * Call this once after the viewer is initialized.
   */
  async applyOnStartup() {
    await this.wallpaper.applyOnStartup();
  }

  /**
   * Apply saved ball style on app startup.
   * Call this once after the viewer is initialized.
   */
  async applyBallStyleOnStartup() {
    await this.ballStyle.applyOnStartup();
  }

  /**
   * Check if the progress bar is enabled.
   * @returns {boolean}
   */
  static isProgressBarEnabled() {
    try {
      const val = localStorage.getItem(Settings.PROGRESS_BAR_KEY);
      return val === null ? true : val === "true";
    } catch {
      return true;
    }
  }

  /**
   * Save progress bar enabled state.
   * @param {boolean} enabled
   */
  static setProgressBarEnabled(enabled) {
    try {
      localStorage.setItem(Settings.PROGRESS_BAR_KEY, String(enabled));
    } catch (err) {
      console.warn("[Settings] Failed to save progress bar setting:", err);
    }

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({
        [Settings.PROGRESS_BAR_KEY]: enabled,
      });
    }
  }

  // ╍╍╍ Modal Rendering ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  _renderModal() {
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";
    this._overlay = overlay;
    this.ballStyle.setOverlay(overlay);

    overlay.innerHTML = `
      <div class="file-menu-modal settings-modal">
        <div class="file-menu-modal-header">
          <h2>Settings</h2>
          <button class="file-menu-modal-close">×</button>
        </div>
        <div class="file-menu-modal-content settings-content">

          <!-- ─── Wallpaper Section ─── -->
          <div class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">Wallpaper</h3>
              <div class="settings-section-actions">
                <button class="settings-edit-btn" title="Edit wallpapers">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button class="settings-delete-confirm-btn" style="display:none" title="Delete selected">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                  <span class="delete-count"></span>
                </button>
              </div>
            </div>

            <div class="wallpaper-grid" id="wallpaper-grid"></div>

            <div class="wallpaper-url-input-area" id="wallpaper-url-area" style="display:none">
              <input type="text" class="wallpaper-url-input" id="wallpaper-url-input"
                     placeholder="Paste image URL (https://...)" spellcheck="false">
              <button class="wallpaper-url-confirm" id="wallpaper-url-confirm">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
              <button class="wallpaper-url-cancel" id="wallpaper-url-cancel">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- ─── Floating Ball Section ─── -->
          <div class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">Floating Ball</h3>
            </div>
            <div class="ball-style-editor" id="ball-style-editor">

              <!-- Preview Ball -->
              <div class="ball-style-editor-preview">
                <div class="ball-preview-container">
                  <div class="ball-preview-page-display">
                    <span class="ball-preview-current">42</span>
                    <span class="ball-preview-page-divider">—</span>
                    <span class="ball-preview-total">87</span>
                  </div>
                </div>
              </div>

              <!-- Controls -->
              <div class="ball-style-editor-controls">

                <!-- Gradient Editor -->
                <div class="ball-control-group">
                  <span class="ball-control-label">Ball Color</span>
                  <div class="gradient-editor" id="gradient-editor">

                    <!-- Gradient bar with stops -->
                    <div class="gradient-bar-wrapper">
                      <div class="gradient-bar" id="gradient-bar">
                        <div class="gradient-bar-inner"></div>
                        <!-- Stop markers inserted by JS -->
                      </div>
                    </div>

                    <!-- Actions -->
                    <div class="gradient-actions">
                      <!-- Selected stop detail -->
                      <div class="gradient-stop-detail" id="gradient-stop-detail">
                        <!-- Populated by JS -->
                      </div>
                      <button class="gradient-action-btn" id="gradient-add-stop" title="Add color stop">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="12" y1="5" x2="12" y2="19"/>
                          <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        Add Stop
                      </button>
                      <button class="gradient-action-btn" id="gradient-reset" title="Reset to default">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="1 4 1 10 7 10"/>
                          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                        </svg>
                        Reset
                      </button>
                    </div>


                    <!-- Direction slider -->
                    <div class="styled-slider-row">
                      <span class="styled-slider-label">Direction</span>
                      <input type="range" class="styled-slider" id="gradient-direction"
                             min="0" max="360" step="1">
                      <span class="styled-slider-value" id="gradient-direction-value">120°</span>
                    </div>


                  </div>
                </div>

                <!-- Page Number Color -->
                <div class="ball-control-group">
                  <span class="ball-control-label">Page Number Color</span>
                  <div class="page-color-row">
                    <div class="page-color-swatch" id="page-color-swatch">
                      <input type="color" class="page-color-native-input" id="page-color-input">
                    </div>
                    <input type="text" class="page-color-hex" id="page-color-hex"
                           placeholder="#000000" spellcheck="false" maxlength="7">
                  </div>
                </div>

              </div>
            </div>
          </div>

          <!-- ─── Display Section ─── -->
          <div class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">Display</h3>
            </div>
            <div class="settings-toggle-row">
              <div class="settings-toggle-info">
                <span class="settings-toggle-label">Progress Bar</span>
                <span class="settings-toggle-description">Show reading progress on the side</span>
              </div>
              <label class="settings-toggle-switch">
                <input type="checkbox" id="progress-bar-toggle">
                <div class="settings-toggle-slider">
                  <div class="settings-toggle-knob"></div>
                </div>
                <div class="settings-toggle-led"></div>
              </label>
            </div>
          </div>

        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    this._fileInput = document.createElement("input");
    this._fileInput.type = "file";
    this._fileInput.accept = "image/jpeg,image/png,image/webp";
    this._fileInput.style.display = "none";
    overlay.appendChild(this._fileInput);

    // Animate in
    requestAnimationFrame(() => overlay.classList.add("visible"));

    // Wire up events
    this._setupModalEvents(overlay);
    this.ballStyle.setupEvents(overlay);

    // Populate grids & previews
    this._refreshGrid();
    this.ballStyle.refreshEditor();
  }

  // ╍╍╍ Modal Events ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  _setupModalEvents(overlay) {
    const close = () => {
      overlay.classList.remove("visible");
      setTimeout(() => {
        overlay.remove();
        this._overlay = null;
        this.ballStyle.setOverlay(null);
      }, 300);
    };

    overlay
      .querySelector(".file-menu-modal-close")
      .addEventListener("click", close);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    const handleEscape = (e) => {
      if (e.key === "Escape") {
        if (this._editMode) {
          this._toggleEditMode();
        } else {
          close();
          document.removeEventListener("keydown", handleEscape);
        }
      }
    };
    document.addEventListener("keydown", handleEscape);

    // Edit button
    overlay
      .querySelector(".settings-edit-btn")
      .addEventListener("click", () => this._toggleEditMode());

    // Delete confirm button
    overlay
      .querySelector(".settings-delete-confirm-btn")
      .addEventListener("click", () => {
        if (this._deleteSet.size > 0) {
          this.wallpaper.deleteCustom(this._deleteSet).then(() => {
            this._deleteSet.clear();
            this._toggleEditMode();
            this._refreshGrid();
          });
        }
      });

    // File input change
    this._fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) {
        this.wallpaper.addFromFile(file).then(() => this._refreshGrid());
      }
      this._fileInput.value = "";
    });

    // URL input
    const urlArea = overlay.querySelector("#wallpaper-url-area");
    const urlInput = overlay.querySelector("#wallpaper-url-input");
    const urlConfirm = overlay.querySelector("#wallpaper-url-confirm");
    const urlCancel = overlay.querySelector("#wallpaper-url-cancel");

    urlConfirm.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (url) {
        this.wallpaper.addFromUrl(url).then(() => this._refreshGrid());
        urlInput.value = "";
        urlArea.style.display = "none";
      }
    });

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") urlConfirm.click();
    });

    urlCancel.addEventListener("click", () => {
      urlInput.value = "";
      urlArea.style.display = "none";
    });

    // Progress bar toggle
    const progressToggle = overlay.querySelector("#progress-bar-toggle");
    if (progressToggle) {
      progressToggle.checked = Settings.isProgressBarEnabled();
      progressToggle.addEventListener("change", () => {
        Settings.setProgressBarEnabled(progressToggle.checked);
        if (this.wm.progressBar) {
          if (progressToggle.checked) {
            this.wm.progressBar.show();
          } else {
            this.wm.progressBar.hide();
          }
        }
      });
    }
  }

  // ╍╍╍ Wallpaper Grid ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  _toggleEditMode() {
    this._editMode = !this._editMode;
    this._deleteSet.clear();

    if (!this._overlay) return;

    const editBtn = this._overlay.querySelector(".settings-edit-btn");
    const deleteBtn = this._overlay.querySelector(
      ".settings-delete-confirm-btn",
    );

    if (this._editMode) {
      editBtn.classList.add("active");
      deleteBtn.style.display = "";
    } else {
      editBtn.classList.remove("active");
      deleteBtn.style.display = "none";
    }

    this._refreshGrid();
  }

  _refreshGrid() {
    const grid = this._overlay?.querySelector("#wallpaper-grid");
    if (!grid) return;

    grid.innerHTML = "";
    const meta = this.wallpaper.meta;
    const activeId = meta?.activeId;

    const noneCard = this._createCardNone(activeId === null);
    grid.appendChild(noneCard);

    for (const preset of WallpaperManager.PRESETS) {
      const card = this._createCardPreset(preset, activeId === preset.id);
      grid.appendChild(card);

      if (!meta.presetThumbs?.[preset.id]) {
        this.wallpaper.ensurePresetThumbnail(preset, card);
      }
    }

    for (const entry of meta?.custom || []) {
      const card = this._createCardCustom(entry, activeId === entry.id);
      grid.appendChild(card);
    }

    if (!this._editMode) {
      const addCard = this._createCardAdd();
      grid.appendChild(addCard);
    }

    this._updateDeleteCount();
  }

  _selectWallpaper(id) {
    if (this._editMode) return;
    this.wallpaper.selectWallpaper(id).then(() => this._refreshGrid());
  }

  _createCardNone(isActive) {
    const card = document.createElement("div");
    card.className =
      "wallpaper-card wallpaper-card-none" + (isActive ? " selected" : "");
    card.innerHTML = `
      <div class="wallpaper-card-preview wallpaper-none-preview">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
      </div>
      <span class="wallpaper-card-label">None</span>
    `;
    card.addEventListener("click", () => this._selectWallpaper(null));
    return card;
  }

  _createCardPreset(preset, isActive) {
    const card = document.createElement("div");
    card.className = "wallpaper-card" + (isActive ? " selected" : "");
    card.dataset.id = preset.id;

    const meta = this.wallpaper.meta;
    const cachedThumb = meta.presetThumbs?.[preset.id] || "";

    card.innerHTML = `
      <div class="wallpaper-card-preview">
        <img src="${cachedThumb}"
             alt="${this._escapeHtml(preset.name)}"
             loading="lazy"
             style="${cachedThumb ? "" : "display:none"}">
        <div class="wallpaper-card-loading" style="${cachedThumb ? "display:none" : ""}">
          <div class="wallpaper-spinner"></div>
        </div>
      </div>
      <span class="wallpaper-card-label">${this._escapeHtml(preset.name)}</span>
    `;

    const img = card.querySelector("img");
    const loading = card.querySelector(".wallpaper-card-loading");

    img.addEventListener("load", () => {
      img.style.display = "";
      if (loading) loading.style.display = "none";
    });
    img.addEventListener("error", () => {
      if (loading) {
        loading.innerHTML = `
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        `;
      }
    });

    card.addEventListener("click", () => this._selectWallpaper(preset.id));
    return card;
  }

  _createCardCustom(entry, isActive) {
    const card = document.createElement("div");
    card.className =
      "wallpaper-card wallpaper-card-custom" +
      (isActive ? " selected" : "") +
      (this._editMode ? " edit-mode" : "") +
      (this._deleteSet.has(entry.id) ? " marked-delete" : "");
    card.dataset.id = entry.id;

    const thumbSrc = entry.thumbnail || "";

    card.innerHTML = `
      <div class="wallpaper-card-preview">
        ${thumbSrc
        ? `<img src="${thumbSrc}" alt="${this._escapeHtml(entry.name)}">`
        : `<div class="wallpaper-card-placeholder">
               <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                 <rect x="3" y="3" width="18" height="18" rx="2"/>
                 <circle cx="8.5" cy="8.5" r="1.5"/>
                 <polyline points="21 15 16 10 5 21"/>
               </svg>
             </div>`
      }
        ${this._editMode
        ? `<div class="wallpaper-delete-check ${this._deleteSet.has(entry.id) ? "checked" : ""}">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" stroke-width="3">
                 <polyline points="20 6 9 17 4 12"/>
               </svg>
             </div>`
        : ""
      }
      </div>
      <span class="wallpaper-card-label">${this._escapeHtml(this._truncate(entry.name, 14))}</span>
    `;

    card.addEventListener("click", () => {
      if (this._editMode) {
        if (this._deleteSet.has(entry.id)) {
          this._deleteSet.delete(entry.id);
          card.classList.remove("marked-delete");
          card
            .querySelector(".wallpaper-delete-check")
            ?.classList.remove("checked");
        } else {
          this._deleteSet.add(entry.id);
          card.classList.add("marked-delete");
          card
            .querySelector(".wallpaper-delete-check")
            ?.classList.add("checked");
        }
        this._updateDeleteCount();
      } else {
        this._selectWallpaper(entry.id);
      }
    });

    return card;
  }

  _createCardAdd() {
    const card = document.createElement("div");
    card.className = "wallpaper-card wallpaper-card-add";

    card.innerHTML = `
      <div class="wallpaper-card-preview wallpaper-add-preview">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <span class="wallpaper-card-label">Add</span>
    `;

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showAddPopover(card);
    });

    return card;
  }

  _showAddPopover(anchorCard) {
    const existing = this._overlay?.querySelector(".wallpaper-add-popover");
    if (existing) {
      existing.remove();
      return;
    }

    const popover = document.createElement("div");
    popover.className = "wallpaper-add-popover";
    popover.innerHTML = `
      <button class="wallpaper-add-option" data-type="file">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Upload File
      </button>
      <button class="wallpaper-add-option" data-type="url">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        From URL
      </button>
    `;

    anchorCard.style.position = "relative";
    anchorCard.appendChild(popover);

    requestAnimationFrame(() => popover.classList.add("visible"));

    popover
      .querySelector('[data-type="file"]')
      .addEventListener("click", (e) => {
        e.stopPropagation();
        popover.remove();
        this._fileInput?.click();
      });

    popover
      .querySelector('[data-type="url"]')
      .addEventListener("click", (e) => {
        e.stopPropagation();
        popover.remove();
        const urlArea = this._overlay?.querySelector("#wallpaper-url-area");
        if (urlArea) {
          urlArea.style.display = "flex";
          urlArea.querySelector("input")?.focus();
        }
      });

    const closePopover = (e) => {
      if (!popover.contains(e.target) && e.target !== anchorCard) {
        popover.remove();
        document.removeEventListener("click", closePopover);
      }
    };
    setTimeout(() => document.addEventListener("click", closePopover), 0);
  }

  _updateDeleteCount() {
    const btn = this._overlay?.querySelector(".settings-delete-confirm-btn");
    const span = btn?.querySelector(".delete-count");
    if (!btn || !span) return;

    const count = this._deleteSet.size;
    span.textContent = count > 0 ? `(${count})` : "";
    btn.style.opacity = count > 0 ? "1" : "0.4";
    btn.style.pointerEvents = count > 0 ? "auto" : "none";
  }

  // ╍╍╍ Utilities ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  _escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _truncate(str, max) {
    if (!str || str.length <= max) return str || "";
    return str.substring(0, max - 1) + "…";
  }
}
