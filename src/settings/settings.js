/**
 * WallpaperSettings - Manages wallpaper selection, storage, and application
 *
 * Storage strategy:
 *   - Full images stored in IndexedDB as Blobs (binary, no base64 inflation)
 *   - Metadata + thumbnails stored in chrome.storage.local (extension) or localStorage (dev) - Preset wallpapers referenced by URL, fetched on demand
 *   - Active custom wallpaper applied via Object URL (tiny pointer, not data URL)
 *
 * @typedef {import('./window_manager.js').SplitWindowManager} SplitWindowManager
 */

export class WallpaperSettings {
  /** @type {string} */
  static DB_NAME = "HoverWallpaperDB";
  /** @type {number} */
  static DB_VERSION = 1;
  /** @type {string} */
  static STORE_NAME = "wallpapers";
  /** @type {string} */
  static META_KEY = "hover_wallpaper_meta";
  /** @type {string} */
  static PROGRESS_BAR_KEY = "hover_progress_bar_enabled";
  /** @type {string} */
  static BALL_STYLE_KEY = "hover_ball_style";
  /** @type {number} Max dimension for stored wallpaper (px) */
  static MAX_IMAGE_DIM = 3840;
  /** @type {number} Thumbnail max width (px) */
  static THUMB_W = 240;
  /** @type {number} Thumbnail max height (px) */
  static THUMB_H = 150;
  /** @type {number} JPEG quality for stored images */
  static IMAGE_QUALITY = 0.85;
  /** @type {number} JPEG quality for thumbnails */
  static THUMB_QUALITY = 0.5;
  /** @type {number} Max custom wallpapers allowed */
  static MAX_CUSTOM = 10;
  /** @type {number} Max gradient stops */
  static MAX_STOPS = 3;

  /** @type {string[]} Supported MIME types */
  static SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

  /**
   * Default ball style matching the CSS variables in _variables.css
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
   * Preset wallpapers hosted on GitHub.
   * Each entry: { id, name, url }
   */
  static PRESETS = [
    {
      id: "preset_tiger",
      name: "Tiger - Antoine Louis Barye",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Antoine_Louis_Barye_Tiger.jpg",
    },
    {
      id: "preset_dance",
      name: "The Country Dance - Claude Lorrain",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Claude_Lorrain_The_Country_Dance.jpg",
    },
    {
      id: "preset_river",
      name: "River - Pierre Puvis",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Pierre_Puvis_River.jpg",
    },
    {
      id: "preset_carpet_1",
      name: "Persian Carpet",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Persian_Carpet.jpg",
    },
    {
      id: "preset_carpet_2",
      name: "Avocado Carpet",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Texture_Carpet.jpg",
    },
    {
      id: "preset_hudson",
      name: "Hudson River - Photography",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Photography_Hudson.jpeg",
    },
    {
      id: "preset_bike",
      name: "Bike - Photography",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Photography_Bike.jpeg",
    },
    // {
    //   id: "preset_Chicago",
    //   name: "Chicago - Photography",
    //   url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Photography_Chicago.jpeg",
    // },
  ];

  /**
   * @param {SplitWindowManager} wm
   * @param {Function} showToast - toast function from FileMenu
   */
  constructor(wm, showToast) {
    this.wm = wm;
    this.showToast = showToast;

    /** @type {IDBDatabase|null} */
    this._db = null;
    /** @type {Object|null} cached metadata */
    this._meta = null;
    /** @type {HTMLElement|null} */
    this._overlay = null;
    /** @type {boolean} */
    this._editMode = false;
    /** @type {Set<string>} IDs selected for deletion */
    this._deleteSet = new Set();

    this._fileInput = null;

    /** @type {string|null} Currently active Object URL (for custom wallpapers) */
    this._activeObjectUrl = null;

    /**
     * Tracks which preset thumbnails are currently being generated,
     * so we don't kick off duplicate fetches for the same preset.
     * @type {Set<string>}
     */
    this._pendingPresetThumbs = new Set();

    // ── Ball Style Editor state ──
    /** @type {Object|null} Current ball style config */
    this._ballStyle = null;
    /** @type {number} Index of the currently selected gradient stop */
    this._selectedStopIndex = 0;
    /** @type {boolean} Whether a stop is being dragged */
    this._isDraggingStop = false;
    /** @type {number} Debounce timer for saving ball style */
    this._ballSaveTimer = null;
  }

  // ═══ Public API ═══════════════════════════════════════════

  /** Open the settings modal */
  async open() {
    try {
      await this._ensureDB();
      this._meta = await this._loadMeta();
      this._ballStyle = await this._loadBallStyle();
      this._editMode = false;
      this._deleteSet.clear();
      this._selectedStopIndex = 0;
      this._renderModal();
    } catch (err) {
      console.error("[WallpaperSettings] Failed to open:", err);
      this.showToast("Failed to open wallpaper settings");
    }
  }

  /**
   * Apply the saved wallpaper on app startup.
   * Call this once after the viewer is initialized.
   */
  async applyOnStartup() {
    try {
      await this._ensureDB();
      this._meta = await this._loadMeta();
      const activeId = this._meta.activeId;
      if (!activeId) return; // no wallpaper set

      if (activeId.startsWith("preset_")) {
        const preset = WallpaperSettings.PRESETS.find((p) => p.id === activeId);
        if (preset) {
          this._applyWallpaperUrl(preset.url);
        }
      } else {
        const blob = await this._getImage(activeId);
        if (blob) {
          this._applyWallpaperBlob(blob);
        }
      }
    } catch (err) {
      console.warn(
        "[WallpaperSettings] Failed to apply wallpaper on startup:",
        err,
      );
    }
  }

  /**
   * Apply the saved ball style on app startup.
   * Call this once after the viewer is initialized.
   */
  async applyBallStyleOnStartup() {
    try {
      this._ballStyle = await this._loadBallStyle();
      this._applyBallStyleToDOM(this._ballStyle);
    } catch (err) {
      console.warn(
        "[WallpaperSettings] Failed to apply ball style on startup:",
        err,
      );
    }
  }

  /**
   * Check if the progress bar is enabled.
   * @returns {boolean}
   */
  static isProgressBarEnabled() {
    try {
      const val = localStorage.getItem(WallpaperSettings.PROGRESS_BAR_KEY);
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
      localStorage.setItem(WallpaperSettings.PROGRESS_BAR_KEY, String(enabled));
    } catch (err) {
      console.warn(
        "[WallpaperSettings] Failed to save progress bar setting:",
        err,
      );
    }

    // Also save to chrome.storage if available
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({
        [WallpaperSettings.PROGRESS_BAR_KEY]: enabled,
      });
    }
  }

  // ═══ IndexedDB Helpers ════════════════════════════════════

  /** @returns {Promise<IDBDatabase>} */
  _ensureDB() {
    if (this._db) return Promise.resolve(this._db);

    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(
          WallpaperSettings.DB_NAME,
          WallpaperSettings.DB_VERSION,
        );
      } catch (err) {
        reject(new Error("IndexedDB not available: " + err.message));
        return;
      }

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(WallpaperSettings.STORE_NAME)) {
          db.createObjectStore(WallpaperSettings.STORE_NAME, {
            keyPath: "id",
          });
        }
      };

      request.onsuccess = (e) => {
        this._db = e.target.result;
        resolve(this._db);
      };

      request.onerror = (e) => {
        reject(new Error("IndexedDB open failed: " + e.target.error?.message));
      };
    });
  }

  /**
   * Store a full-resolution image in IndexedDB as a Blob.
   * @param {string} id
   * @param {Blob} blob  image Blob
   */
  _putImage(id, blob) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(
        WallpaperSettings.STORE_NAME,
        "readwrite",
      );
      const store = tx.objectStore(WallpaperSettings.STORE_NAME);
      store.put({ id, data: blob });
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Get a full-resolution image Blob from IndexedDB.
   * @param {string} id
   * @returns {Promise<Blob|null>} image Blob or null
   */
  _getImage(id) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(WallpaperSettings.STORE_NAME, "readonly");
      const store = tx.objectStore(WallpaperSettings.STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Delete an image from IndexedDB
   * @param {string} id
   */
  _deleteImage(id) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(
        WallpaperSettings.STORE_NAME,
        "readwrite",
      );
      const store = tx.objectStore(WallpaperSettings.STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ═══ Metadata (chrome.storage.local / localStorage) ══════

  /**
   * Metadata shape:
   * {
   *   activeId: string | null,
   *   custom: [ { id, name, thumbnail } ],
   *   presetThumbs: { [presetId]: thumbnailDataUrl }
   * }
   */

  /** @returns {Promise<Object>} */
  async _loadMeta() {
    const fallback = { activeId: null, custom: [], presetThumbs: {} };

    // Try chrome.storage.local first
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(WallpaperSettings.META_KEY, (result) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[WallpaperSettings] chrome.storage read error:",
              chrome.runtime.lastError,
            );
            resolve(this._loadMetaLocalStorage(fallback));
            return;
          }
          const data = result[WallpaperSettings.META_KEY];
          resolve(data ? { ...fallback, ...data } : fallback);
        });
      });
    }

    return this._loadMetaLocalStorage(fallback);
  }

  _loadMetaLocalStorage(fallback) {
    try {
      const raw = localStorage.getItem(WallpaperSettings.META_KEY);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  }

  /** @param {Object} meta */
  async _saveMeta(meta) {
    this._meta = meta;

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [WallpaperSettings.META_KEY]: meta }, () => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[WallpaperSettings] chrome.storage write error:",
              chrome.runtime.lastError,
            );
            this._saveMetaLocalStorage(meta);
          }
          resolve();
        });
      });
    }

    this._saveMetaLocalStorage(meta);
  }

  _saveMetaLocalStorage(meta) {
    try {
      localStorage.setItem(WallpaperSettings.META_KEY, JSON.stringify(meta));
    } catch (err) {
      console.error("[WallpaperSettings] localStorage write error:", err);
    }
  }

  // ═══ Ball Style Storage ══════════════════════════════════

  /**
   * Load ball style from storage, falling back to defaults.
   * @returns {Promise<Object>}
   */
  async _loadBallStyle() {
    const fallback = structuredClone(WallpaperSettings.DEFAULT_BALL_STYLE);

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(WallpaperSettings.BALL_STYLE_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve(this._loadBallStyleLocalStorage(fallback));
            return;
          }
          const data = result[WallpaperSettings.BALL_STYLE_KEY];
          resolve(data ? this._mergeBallStyle(fallback, data) : fallback);
        });
      });
    }

    return this._loadBallStyleLocalStorage(fallback);
  }

  _loadBallStyleLocalStorage(fallback) {
    try {
      const raw = localStorage.getItem(WallpaperSettings.BALL_STYLE_KEY);
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

    // Debounce saves during rapid slider/drag changes
    clearTimeout(this._ballSaveTimer);
    this._ballSaveTimer = setTimeout(() => {
      this._persistBallStyle(style);
    }, 300);
  }

  async _persistBallStyle(style) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.set(
          { [WallpaperSettings.BALL_STYLE_KEY]: style },
          () => {
            if (chrome.runtime.lastError) {
              this._saveBallStyleLocalStorage(style);
            }
            resolve();
          },
        );
      });
    }
    this._saveBallStyleLocalStorage(style);
  }

  _saveBallStyleLocalStorage(style) {
    try {
      localStorage.setItem(
        WallpaperSettings.BALL_STYLE_KEY,
        JSON.stringify(style),
      );
    } catch (err) {
      console.error("[WallpaperSettings] localStorage write error:", err);
    }
  }

  // ═══ Ball Style Application ══════════════════════════════

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
   * Apply ball style to :root CSS custom properties.
   * @param {Object} style
   */
  _applyBallStyleToDOM(style) {
    const root = document.documentElement;
    root.style.setProperty(
      "--ball-body",
      this._buildGradientCSS(style.gradient),
    );

    // Use middle stop for goo color
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

  // ═══ Image Processing ════════════════════════════════════

  /**
   * Load an image element from a source
   * @param {string} src - data URL, blob URL, or remote URL
   * @returns {Promise<HTMLImageElement>}
   */
  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = src;
    });
  }

  /**
   * Resize image via offscreen canvas and return as Blob.
   * @param {HTMLImageElement} img
   * @param {number} maxW
   * @param {number} maxH
   * @param {number} quality
   * @returns {Promise<Blob>} JPEG Blob
   */
  _resizeToBlob(img, maxW, maxH, quality) {
    let w = img.naturalWidth;
    let h = img.naturalHeight;

    if (w > maxW) {
      h = Math.round(h * (maxW / w));
      w = maxW;
    }
    if (h > maxH) {
      w = Math.round(w * (maxH / h));
      h = maxH;
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          canvas.width = 0;
          canvas.height = 0;

          if (blob) resolve(blob);
          else reject(new Error("Canvas toBlob returned null"));
        },
        "image/jpeg",
        quality,
      );
    });
  }

  /**
   * Resize image via canvas and return as a data URL.
   * @param {HTMLImageElement} img
   * @param {number} maxW
   * @param {number} maxH
   * @param {number} quality
   * @returns {string} JPEG data URL
   */
  _resizeToDataUrl(img, maxW, maxH, quality) {
    let w = img.naturalWidth;
    let h = img.naturalHeight;

    if (w > maxW) {
      h = Math.round(h * (maxW / w));
      w = maxW;
    }
    if (h > maxH) {
      w = Math.round(w * (maxH / h));
      h = maxH;
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);

    canvas.width = 0;
    canvas.height = 0;

    return dataUrl;
  }

  /**
   * Process a raw image source into a Blob (for IndexedDB) and a
   * small data-URL thumbnail (for metadata).
   *
   * @param {string} src - original data URL, object URL, or remote URL
   * @returns {Promise<{full: Blob, thumb: string}>}
   */
  async _processImage(src) {
    const img = await this._loadImage(src);

    const full = await this._resizeToBlob(
      img,
      WallpaperSettings.MAX_IMAGE_DIM,
      WallpaperSettings.MAX_IMAGE_DIM,
      WallpaperSettings.IMAGE_QUALITY,
    );

    const thumb = this._resizeToDataUrl(
      img,
      WallpaperSettings.THUMB_W,
      WallpaperSettings.THUMB_H,
      WallpaperSettings.THUMB_QUALITY,
    );

    img.src = "";
    return { full, thumb };
  }

  /**
   * Generate a thumbnail for a preset URL.
   * @param {string} url
   * @returns {Promise<string>} thumbnail data URL
   */
  async _generatePresetThumbnail(url) {
    try {
      const img = await this._loadImage(url);
      const thumb = this._resizeToDataUrl(
        img,
        WallpaperSettings.THUMB_W,
        WallpaperSettings.THUMB_H,
        WallpaperSettings.THUMB_QUALITY,
      );
      img.src = "";
      return thumb;
    } catch {
      return "";
    }
  }

  /**
   * Ensure a preset has a cached thumbnail.
   * @param {Object} preset - { id, name, url }
   * @param {HTMLElement} card - the card DOM element to update
   */
  async _ensurePresetThumbnail(preset, card) {
    if (this._meta.presetThumbs?.[preset.id]) return;
    if (this._pendingPresetThumbs.has(preset.id)) return;
    this._pendingPresetThumbs.add(preset.id);

    try {
      const thumb = await this._generatePresetThumbnail(preset.url);
      if (!thumb) return;

      if (!this._meta.presetThumbs) this._meta.presetThumbs = {};
      this._meta.presetThumbs[preset.id] = thumb;
      await this._saveMeta(this._meta);

      const img = card.querySelector("img");
      const loading = card.querySelector(".wallpaper-card-loading");
      if (img) {
        img.src = thumb;
        img.style.display = "";
      }
      if (loading) {
        loading.style.display = "none";
      }
    } catch (err) {
      console.warn(
        `[WallpaperSettings] Failed to generate thumbnail for ${preset.id}:`,
        err,
      );
    } finally {
      this._pendingPresetThumbs.delete(preset.id);
    }
  }

  // ═══ Wallpaper Application ═══════════════════════════════

  _revokeActiveObjectUrl() {
    if (this._activeObjectUrl) {
      URL.revokeObjectURL(this._activeObjectUrl);
      this._activeObjectUrl = null;
    }
  }

  _applyBackgroundStyles() {
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundRepeat = "no-repeat";
    document.body.style.backgroundAttachment = "fixed";
  }

  _applyWallpaperUrl(url) {
    this._revokeActiveObjectUrl();
    document.body.style.backgroundImage = `url("${url}")`;
    this._applyBackgroundStyles();
  }

  _applyWallpaperBlob(blob) {
    this._revokeActiveObjectUrl();
    this._activeObjectUrl = URL.createObjectURL(blob);
    document.body.style.backgroundImage = `url("${this._activeObjectUrl}")`;
    this._applyBackgroundStyles();
  }

  _clearWallpaper() {
    this._revokeActiveObjectUrl();
    document.body.style.backgroundImage = "";
    document.body.style.backgroundSize = "";
    document.body.style.backgroundPosition = "";
    document.body.style.backgroundRepeat = "";
    document.body.style.backgroundAttachment = "";
  }

  // ═══ Add / Remove Custom Wallpapers ═════════════════════

  async _addFromFile(file) {
    if (!WallpaperSettings.SUPPORTED_TYPES.includes(file.type)) {
      this.showToast(
        `Unsupported format: ${file.type}. Use JPG, PNG, or WebP.`,
      );
      return;
    }

    if (this._meta.custom.length >= WallpaperSettings.MAX_CUSTOM) {
      this.showToast(
        `Maximum of ${WallpaperSettings.MAX_CUSTOM} custom wallpapers reached.`,
      );
      return;
    }

    try {
      this.showToast("Processing image...");
      const objectUrl = URL.createObjectURL(file);
      const { full, thumb } = await this._processImage(objectUrl);
      URL.revokeObjectURL(objectUrl);

      const id =
        "custom_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      await this._putImage(id, full);

      this._meta.custom.push({
        id,
        name: file.name,
        thumbnail: thumb,
      });
      await this._saveMeta(this._meta);

      this._refreshGrid();
      this.showToast("Wallpaper added");
    } catch (err) {
      console.error("[WallpaperSettings] Error adding file:", err);
      this.showToast("Failed to process image");
    }
  }

  async _addFromUrl(url) {
    if (this._meta.custom.length >= WallpaperSettings.MAX_CUSTOM) {
      this.showToast(
        `Maximum of ${WallpaperSettings.MAX_CUSTOM} custom wallpapers reached.`,
      );
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      this.showToast("Invalid URL. Please enter a valid http/https image URL.");
      return;
    }

    try {
      this.showToast("Fetching image...");

      let imgSrc = url;
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { type: "FETCH_WEB", query: url },
              (resp) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                  return;
                }
                resolve(resp);
              },
            );
          });
        } catch {
          // Fallback to direct load
        }
      }

      const { full, thumb } = await this._processImage(imgSrc);

      const id =
        "custom_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      await this._putImage(id, full);

      const filename = parsedUrl.pathname.split("/").pop() || "url_wallpaper";
      this._meta.custom.push({
        id,
        name: filename,
        thumbnail: thumb,
      });
      await this._saveMeta(this._meta);

      this._refreshGrid();
      this.showToast("Wallpaper added from URL");
    } catch (err) {
      console.error("[WallpaperSettings] Error adding from URL:", err);
      this.showToast(
        "Failed to fetch image. Check the URL or try downloading it first.",
      );
    }
  }

  async _deleteCustom(ids) {
    for (const id of ids) {
      await this._deleteImage(id);
      this._meta.custom = this._meta.custom.filter((c) => c.id !== id);
    }

    if (ids.has(this._meta.activeId)) {
      this._meta.activeId = null;
      this._clearWallpaper();
    }

    await this._saveMeta(this._meta);
    this._refreshGrid();
    this.showToast(`Deleted ${ids.size} wallpaper${ids.size > 1 ? "s" : ""}`);
  }

  async _selectWallpaper(id) {
    if (this._editMode) return;

    this._meta.activeId = id;
    await this._saveMeta(this._meta);

    if (!id) {
      this._clearWallpaper();
      this.showToast("Wallpaper removed");
    } else if (id.startsWith("preset_")) {
      const preset = WallpaperSettings.PRESETS.find((p) => p.id === id);
      if (preset) {
        this._applyWallpaperUrl(preset.url);
        this.showToast(`Applied: ${preset.name}`);
      }
    } else {
      try {
        const blob = await this._getImage(id);
        if (blob) {
          this._applyWallpaperBlob(blob);
          const entry = this._meta.custom.find((c) => c.id === id);
          this.showToast(`Applied: ${entry?.name || "Custom wallpaper"}`);
        }
      } catch (err) {
        console.error(
          "[WallpaperSettings] Error applying custom wallpaper:",
          err,
        );
        this.showToast("Failed to apply wallpaper");
      }
    }

    this._refreshGrid();
  }

  // ═══ UI Rendering ════════════════════════════════════════

  _renderModal() {
    const existing = document.querySelector(".file-menu-modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "file-menu-modal-overlay";
    this._overlay = overlay;

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
    this._setupBallStyleEvents(overlay);

    // Populate grids & previews
    this._refreshGrid();
    this._refreshBallEditor();
  }

  _setupModalEvents(overlay) {
    const close = () => {
      overlay.classList.remove("visible");
      setTimeout(() => {
        overlay.remove();
        this._overlay = null;
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
          this._deleteCustom(this._deleteSet).then(() => {
            this._deleteSet.clear();
            this._toggleEditMode();
          });
        }
      });

    // File input change
    this._fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) this._addFromFile(file);
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
        this._addFromUrl(url);
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

    const progressToggle = overlay.querySelector("#progress-bar-toggle");
    if (progressToggle) {
      progressToggle.checked = WallpaperSettings.isProgressBarEnabled();
      progressToggle.addEventListener("change", () => {
        WallpaperSettings.setProgressBarEnabled(progressToggle.checked);
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

  // ═══ Ball Style Editor Events ════════════════════════════

  _setupBallStyleEvents(overlay) {
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
        if (stops.length >= WallpaperSettings.MAX_STOPS) {
          this.showToast(`Maximum ${WallpaperSettings.MAX_STOPS} color stops`);
          return;
        }

        // Insert a new stop at the midpoint of the largest gap
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
        // Also consider edges
        if (sorted[0].position > maxGap) {
          gapMid = Math.round(sorted[0].position / 2);
        }
        if (100 - sorted[sorted.length - 1].position > maxGap) {
          gapMid = Math.round((sorted[sorted.length - 1].position + 100) / 2);
        }

        stops.push({ color: "#999999", position: gapMid });
        this._selectedStopIndex = stops.length - 1;
        this._onBallStyleChanged();
        this._refreshBallEditor();
      });

    // ── Reset button ──
    overlay.querySelector("#gradient-reset").addEventListener("click", () => {
      this._ballStyle = structuredClone(WallpaperSettings.DEFAULT_BALL_STYLE);
      this._selectedStopIndex = 0;
      this._onBallStyleChanged();
      this._refreshBallEditor();
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
      // Normalize on blur
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
      // Only if clicking the bar itself, not a stop
      if (e.target.closest(".gradient-stop")) return;

      const stops = this._ballStyle.gradient.stops;
      if (stops.length >= WallpaperSettings.MAX_STOPS) return;

      const rect = gradientBar.getBoundingClientRect();
      const pos = Math.round(((e.clientX - rect.left) / rect.width) * 100);

      stops.push({
        color: "#999999",
        position: Math.max(0, Math.min(100, pos)),
      });
      this._selectedStopIndex = stops.length - 1;
      this._onBallStyleChanged();
      this._refreshBallEditor();
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

  /**
   * Full refresh of the ball editor UI from current state.
   */
  _refreshBallEditor() {
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
    const atMax =
      this._ballStyle.gradient.stops.length >= WallpaperSettings.MAX_STOPS;
    btn.disabled = atMax;
    btn.title = atMax
      ? `Maximum ${WallpaperSettings.MAX_STOPS} color stops`
      : "Add color stop";
  }

  /**
   * Render stop markers on the gradient bar.
   */
  _refreshStopMarkers() {
    const bar = this._overlay?.querySelector("#gradient-bar");
    if (!bar) return;

    // Remove existing stops
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

      // Final detail refresh now that drag is done
      this._refreshStopDetail();
    };

    const onDown = (e) => {
      // Don't start drag on the remove button or color input
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

    // Adjust selected index
    if (this._selectedStopIndex >= stops.length) {
      this._selectedStopIndex = stops.length - 1;
    }
    if (this._selectedStopIndex === idx) {
      this._selectedStopIndex = Math.max(0, idx - 1);
    }

    this._onBallStyleChanged();
    this._refreshBallEditor();
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

    // Hidden color input for the swatch
    const swatch = container.querySelector("#stop-detail-swatch");
    const hexInput = container.querySelector("#stop-detail-hex");

    swatch.addEventListener("click", () => {
      // Find the stop marker's color input and click it
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

  // ═══ Wallpaper Grid (unchanged logic) ════════════════════

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
    const activeId = this._meta?.activeId;

    const noneCard = this._createCardNone(activeId === null);
    grid.appendChild(noneCard);

    for (const preset of WallpaperSettings.PRESETS) {
      const card = this._createCardPreset(preset, activeId === preset.id);
      grid.appendChild(card);

      if (!this._meta.presetThumbs?.[preset.id]) {
        this._ensurePresetThumbnail(preset, card);
      }
    }

    for (const entry of this._meta?.custom || []) {
      const card = this._createCardCustom(entry, activeId === entry.id);
      grid.appendChild(card);
    }

    if (!this._editMode) {
      const addCard = this._createCardAdd();
      grid.appendChild(addCard);
    }

    this._updateDeleteCount();
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

    const cachedThumb = this._meta.presetThumbs?.[preset.id] || "";

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

  // ═══ Utilities ═══════════════════════════════════════════

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
