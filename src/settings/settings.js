/**
 * WallpaperSettings - Manages wallpaper selection, storage, and application
 *
 * Storage strategy:
 *   - Full images stored in IndexedDB as Blobs (binary, no base64 inflation)
 *   - Metadata + thumbnails stored in chrome.storage.local (extension) or localStorage (dev)
 *   - Preset wallpapers referenced by URL, fetched on demand
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

  /** @type {string[]} Supported MIME types */
  static SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

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
  }

  // ─── Public API ──────────────────────────────────────────

  /** Open the settings modal */
  async open() {
    try {
      await this._ensureDB();
      this._meta = await this._loadMeta();
      this._editMode = false;
      this._deleteSet.clear();
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

  // ─── IndexedDB Helpers ───────────────────────────────────

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

  // ─── Metadata (chrome.storage.local / localStorage) ──────

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

  // ─── Image Processing ────────────────────────────────────

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
   * Memory flow:
   *   File → Object URL → HTMLImageElement (decoded bitmap)
   *         → canvas.toBlob() → Blob (binary, stored in IDB)
   *         → canvas.toDataURL() → small thumbnail string
   *         → img.src = "" → hint GC to free decoded bitmap
   *
   * @param {string} src - original data URL, object URL, or remote URL
   * @returns {Promise<{full: Blob, thumb: string}>}
   */
  async _processImage(src) {
    const img = await this._loadImage(src);

    // Full image → Blob (stored in IndexedDB, never inflated to base64)
    const full = await this._resizeToBlob(
      img,
      WallpaperSettings.MAX_IMAGE_DIM,
      WallpaperSettings.MAX_IMAGE_DIM,
      WallpaperSettings.IMAGE_QUALITY,
    );

    // Thumbnail → small data URL (stored in metadata, ~5-15 KB)
    const thumb = this._resizeToDataUrl(
      img,
      WallpaperSettings.THUMB_W,
      WallpaperSettings.THUMB_H,
      WallpaperSettings.THUMB_QUALITY,
    );

    // Dereference the HTMLImageElement so GC can collect the decoded bitmap
    img.src = "";

    return { full, thumb };
  }

  /**
   * Generate a thumbnail for a preset URL.
   * Falls back to the URL itself if image loading fails.
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
   * Ensure a preset has a cached thumbnail. If not, generate one in the
   * background and update the card's <img> when ready.
   *
   * Downloads the full image once, resizes to a tiny thumbnail (~5-15 KB),
   * immediately releases the full bitmap, and caches the thumbnail in
   * metadata so subsequent opens never re-download.
   *
   * @param {Object} preset - { id, name, url }
   * @param {HTMLElement} card - the card DOM element to update
   */
  async _ensurePresetThumbnail(preset, card) {
    // Already cached?
    if (this._meta.presetThumbs?.[preset.id]) return;

    // Already being generated?
    if (this._pendingPresetThumbs.has(preset.id)) return;
    this._pendingPresetThumbs.add(preset.id);

    try {
      const thumb = await this._generatePresetThumbnail(preset.url);
      if (!thumb) return;

      // Cache in metadata
      if (!this._meta.presetThumbs) this._meta.presetThumbs = {};
      this._meta.presetThumbs[preset.id] = thumb;
      await this._saveMeta(this._meta);

      // Update the card's img if it's still in the DOM
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

  // ─── Wallpaper Application ───────────────────────────────

  /** Revoke the currently held Object URL (if any) to free memory */
  _revokeActiveObjectUrl() {
    if (this._activeObjectUrl) {
      URL.revokeObjectURL(this._activeObjectUrl);
      this._activeObjectUrl = null;
    }
  }

  /** Apply shared background styles */
  _applyBackgroundStyles() {
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundRepeat = "no-repeat";
    document.body.style.backgroundAttachment = "fixed";
  }

  /** Apply a wallpaper from a URL (presets). Revokes any prior Object URL. */
  _applyWallpaperUrl(url) {
    this._revokeActiveObjectUrl();
    document.body.style.backgroundImage = `url("${url}")`;
    this._applyBackgroundStyles();
  }

  /**
   * Apply a wallpaper from a Blob (custom).
   * Creates an Object URL — a lightweight pointer (~60 bytes) that lets
   * the browser reference the Blob directly in native memory, without
   * copying it into the JS heap as a multi-MB base64 string.
   * @param {Blob} blob
   */
  _applyWallpaperBlob(blob) {
    this._revokeActiveObjectUrl();
    this._activeObjectUrl = URL.createObjectURL(blob);
    document.body.style.backgroundImage = `url("${this._activeObjectUrl}")`;
    this._applyBackgroundStyles();
  }

  /** Remove any applied wallpaper and free Object URL */
  _clearWallpaper() {
    this._revokeActiveObjectUrl();
    document.body.style.backgroundImage = "";
    document.body.style.backgroundSize = "";
    document.body.style.backgroundPosition = "";
    document.body.style.backgroundRepeat = "";
    document.body.style.backgroundAttachment = "";
  }

  // ─── Add / Remove Custom Wallpapers ──────────────────────

  /**
   * Add a custom wallpaper from a File object
   * @param {File} file
   */
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

  /**
   * Add a custom wallpaper from a URL
   * @param {string} url
   */
  async _addFromUrl(url) {
    if (this._meta.custom.length >= WallpaperSettings.MAX_CUSTOM) {
      this.showToast(
        `Maximum of ${WallpaperSettings.MAX_CUSTOM} custom wallpapers reached.`,
      );
      return;
    }

    // Basic URL validation
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

      // Try fetching via background script (handles CORS in extension context)
      let imgSrc = url;
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          const response = await new Promise((resolve, reject) => {
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

          // Background returns HTML; for images we need a different approach
          // Instead, we'll try loading the image directly with crossOrigin
        } catch {
          // Fallback to direct load
        }
      }

      // Attempt direct image load (works for CORS-enabled sources)
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

  /**
   * Delete custom wallpapers by IDs
   * @param {Set<string>} ids
   */
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

  /**
   * Select a wallpaper as active
   * @param {string|null} id - null to clear wallpaper
   */
  async _selectWallpaper(id) {
    if (this._editMode) return; // don't select in edit mode

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

  // ─── UI Rendering ────────────────────────────────────────

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

            <div class="wallpaper-grid" id="wallpaper-grid">
            </div>

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

    // Populate the grid
    this._refreshGrid();
  }

  _setupModalEvents(overlay) {
    // Close
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
      if (e.key === "Enter") {
        urlConfirm.click();
      }
    });

    urlCancel.addEventListener("click", () => {
      urlInput.value = "";
      urlArea.style.display = "none";
    });
  }

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

    // 1. "None" card
    const noneCard = this._createCardNone(activeId === null);
    grid.appendChild(noneCard);

    // 2. Preset cards — use cached thumbnails, generate lazily if missing
    for (const preset of WallpaperSettings.PRESETS) {
      const card = this._createCardPreset(preset, activeId === preset.id);
      grid.appendChild(card);

      if (!this._meta.presetThumbs?.[preset.id]) {
        this._ensurePresetThumbnail(preset, card);
      }
    }

    // 3. Custom cards
    for (const entry of this._meta?.custom || []) {
      const card = this._createCardCustom(entry, activeId === entry.id);
      grid.appendChild(card);
    }

    // 4. Add button (only if not in edit mode)
    if (!this._editMode) {
      const addCard = this._createCardAdd();
      grid.appendChild(addCard);
    }

    // Update delete count
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

  /**
   * Create a preset card.
   */
  _createCardPreset(preset, isActive) {
    const card = document.createElement("div");
    card.className = "wallpaper-card" + (isActive ? " selected" : "");
    card.dataset.id = preset.id;

    // Use cached thumbnail if available, otherwise show spinner
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

    // Hide spinner and show the thumbnail
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
        // Toggle delete selection
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

    // Click shows a small popover with two options
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showAddPopover(card);
    });

    return card;
  }

  _showAddPopover(anchorCard) {
    // Remove existing popover
    const existing = this._overlay?.querySelector(".wallpaper-add-popover");
    if (existing) {
      existing.remove();
      return; // toggle off
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

    // Position relative to the add card
    anchorCard.style.position = "relative";
    anchorCard.appendChild(popover);

    // Animate in
    requestAnimationFrame(() => popover.classList.add("visible"));

    // Handle choices
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

    // Close popover on outside click
    const closePopover = (e) => {
      if (!popover.contains(e.target) && e.target !== anchorCard) {
        popover.remove();
        document.removeEventListener("click", closePopover);
      }
    };
    // Delay to avoid catching the current click
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

  // ─── Utilities ───────────────────────────────────────────

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
