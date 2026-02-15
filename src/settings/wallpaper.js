/**
 * WallpaperManager - Handles wallpaper storage, image processing, and application
 *
 * Storage strategy:
 *   - Full images stored in IndexedDB as Blobs (binary, no base64 inflation)
 *   - Metadata + thumbnails stored in chrome.storage.local (extension) or localStorage (dev)
 *   - Preset wallpapers referenced by URL, fetched on demand
 *   - Active custom wallpaper applied via Object URL (tiny pointer, not data URL)
 */

export class WallpaperManager {
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
    {
      id: "preset_Chicago",
      name: "Chicago - Photography",
      url: "https://raw.githubusercontent.com/ChihshengJ/ChihshengJ.github.io/refs/heads/main/assets/wallpapers/Photography_Chicago.jpg",
    },
  ];

  /**
   * @param {Function} showToast - toast function from FileMenu
   */
  constructor(showToast) {
    this.showToast = showToast;

    /** @type {IDBDatabase|null} */
    this._db = null;
    /** @type {Object|null} cached metadata */
    this._meta = null;
    /** @type {string|null} Currently active Object URL (for custom wallpapers) */
    this._activeObjectUrl = null;

    /**
     * Tracks which preset thumbnails are currently being generated,
     * so we don't kick off duplicate fetches for the same preset.
     * @type {Set<string>}
     */
    this._pendingPresetThumbs = new Set();
  }

  // ╍╍╍ Public API ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /** @returns {Object} cached metadata */
  get meta() {
    return this._meta;
  }

  /**
   * Initialise the database and load metadata.
   * Call before any other operations.
   */
  async init() {
    await this._ensureDB();
    this._meta = await this._loadMeta();
  }

  /**
   * Apply the saved wallpaper on app startup.
   * Call this once after the viewer is initialized.
   */
  async applyOnStartup() {
    try {
      await this.init();
      const activeId = this._meta.activeId;
      if (!activeId) return;

      if (activeId.startsWith("preset_")) {
        const preset = WallpaperManager.PRESETS.find((p) => p.id === activeId);
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
        "[WallpaperManager] Failed to apply wallpaper on startup:",
        err,
      );
    }
  }

  /**
   * Select and apply a wallpaper by ID.
   * @param {string|null} id - wallpaper ID or null to clear
   */
  async selectWallpaper(id) {
    this._meta.activeId = id;
    await this._saveMeta(this._meta);

    if (!id) {
      this._clearWallpaper();
      this.showToast("Wallpaper removed");
    } else if (id.startsWith("preset_")) {
      const preset = WallpaperManager.PRESETS.find((p) => p.id === id);
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
          "[WallpaperManager] Error applying custom wallpaper:",
          err,
        );
        this.showToast("Failed to apply wallpaper");
      }
    }
  }

  /**
   * Add a custom wallpaper from a File object.
   * @param {File} file
   * @returns {Promise<boolean>} true if added successfully
   */
  async addFromFile(file) {
    if (!WallpaperManager.SUPPORTED_TYPES.includes(file.type)) {
      this.showToast(
        `Unsupported format: ${file.type}. Use JPG, PNG, or WebP.`,
      );
      return false;
    }

    if (this._meta.custom.length >= WallpaperManager.MAX_CUSTOM) {
      this.showToast(
        `Maximum of ${WallpaperManager.MAX_CUSTOM} custom wallpapers reached.`,
      );
      return false;
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

      this.showToast("Wallpaper added");
      return true;
    } catch (err) {
      console.error("[WallpaperManager] Error adding file:", err);
      this.showToast("Failed to process image");
      return false;
    }
  }

  /**
   * Add a custom wallpaper from a URL.
   * @param {string} url
   * @returns {Promise<boolean>} true if added successfully
   */
  async addFromUrl(url) {
    if (this._meta.custom.length >= WallpaperManager.MAX_CUSTOM) {
      this.showToast(
        `Maximum of ${WallpaperManager.MAX_CUSTOM} custom wallpapers reached.`,
      );
      return false;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      this.showToast("Invalid URL. Please enter a valid http/https image URL.");
      return false;
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

      this.showToast("Wallpaper added from URL");
      return true;
    } catch (err) {
      console.error("[WallpaperManager] Error adding from URL:", err);
      this.showToast(
        "Failed to fetch image. Check the URL or try downloading it first.",
      );
      return false;
    }
  }

  /**
   * Delete custom wallpapers by IDs.
   * @param {Set<string>} ids
   */
  async deleteCustom(ids) {
    for (const id of ids) {
      await this._deleteImage(id);
      this._meta.custom = this._meta.custom.filter((c) => c.id !== id);
    }

    if (ids.has(this._meta.activeId)) {
      this._meta.activeId = null;
      this._clearWallpaper();
    }

    await this._saveMeta(this._meta);
    this.showToast(`Deleted ${ids.size} wallpaper${ids.size > 1 ? "s" : ""}`);
  }

  /**
   * Ensure a preset has a cached thumbnail, generating one if needed.
   * @param {Object} preset - { id, name, url }
   * @param {HTMLElement} card - the card DOM element to update
   */
  async ensurePresetThumbnail(preset, card) {
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
        `[WallpaperManager] Failed to generate thumbnail for ${preset.id}:`,
        err,
      );
    } finally {
      this._pendingPresetThumbs.delete(preset.id);
    }
  }

  // ╍╍╍ IndexedDB Helpers ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /** @returns {Promise<IDBDatabase>} */
  _ensureDB() {
    if (this._db) return Promise.resolve(this._db);

    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(
          WallpaperManager.DB_NAME,
          WallpaperManager.DB_VERSION,
        );
      } catch (err) {
        reject(new Error("IndexedDB not available: " + err.message));
        return;
      }

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(WallpaperManager.STORE_NAME)) {
          db.createObjectStore(WallpaperManager.STORE_NAME, {
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
      const tx = this._db.transaction(WallpaperManager.STORE_NAME, "readwrite");
      const store = tx.objectStore(WallpaperManager.STORE_NAME);
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
      const tx = this._db.transaction(WallpaperManager.STORE_NAME, "readonly");
      const store = tx.objectStore(WallpaperManager.STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Delete an image from IndexedDB.
   * @param {string} id
   */
  _deleteImage(id) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(WallpaperManager.STORE_NAME, "readwrite");
      const store = tx.objectStore(WallpaperManager.STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ╍╍╍ Metadata (chrome.storage.local / localStorage) ╍╍╍╍╍╍

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

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(WallpaperManager.META_KEY, (result) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[WallpaperManager] chrome.storage read error:",
              chrome.runtime.lastError,
            );
            resolve(this._loadMetaLocalStorage(fallback));
            return;
          }
          const data = result[WallpaperManager.META_KEY];
          resolve(data ? { ...fallback, ...data } : fallback);
        });
      });
    }

    return this._loadMetaLocalStorage(fallback);
  }

  _loadMetaLocalStorage(fallback) {
    try {
      const raw = localStorage.getItem(WallpaperManager.META_KEY);
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
        chrome.storage.local.set({ [WallpaperManager.META_KEY]: meta }, () => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[WallpaperManager] chrome.storage write error:",
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
      localStorage.setItem(WallpaperManager.META_KEY, JSON.stringify(meta));
    } catch (err) {
      console.error("[WallpaperManager] localStorage write error:", err);
    }
  }

  // ╍╍╍ Image Processing ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Load an image element from a source.
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
      WallpaperManager.MAX_IMAGE_DIM,
      WallpaperManager.MAX_IMAGE_DIM,
      WallpaperManager.IMAGE_QUALITY,
    );

    const thumb = this._resizeToDataUrl(
      img,
      WallpaperManager.THUMB_W,
      WallpaperManager.THUMB_H,
      WallpaperManager.THUMB_QUALITY,
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
        WallpaperManager.THUMB_W,
        WallpaperManager.THUMB_H,
        WallpaperManager.THUMB_QUALITY,
      );
      img.src = "";
      return thumb;
    } catch {
      return "";
    }
  }

  // ╍╍╍ Wallpaper Application ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

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
}
