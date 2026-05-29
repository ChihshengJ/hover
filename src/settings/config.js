/**
 * Config — single source of truth for user preferences.
 *
 * Backs onto chrome.storage.local (when available) with a localStorage
 * mirror so settings survive across browser restarts in both extension
 * and dev contexts. Values are cached in memory after `load()` so
 * components can read synchronously.
 *
 *   await Config.load();              // once, at app startup
 *   Config.get('night_mode_startup'); // synchronous
 *   await Config.set('split_persist', true);
 *   const unsubscribe = Config.subscribe('night_mode_last', (v) => {...});
 */

const DEFAULT_WALLPAPER_META = {
  activeId: null,
  custom: [],
  presetThumbs: {},
  persistInNight: false,
};

const DEFAULT_BALL_STYLE = {
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
  persistInNight: false,
  useThemeButtons: false,
};

/**
 * Schema:
 *   key         — logical name used by components (Config.get('key'))
 *   storageKey  — actual key written to chrome.storage / localStorage
 *                 (preserved verbatim from pre-Config code so existing
 *                 stored values are not lost across upgrade)
 *   default     — value returned when the key has never been written
 */
const SCHEMA = {
  // Display
  progress_bar_enabled: {
    storageKey: "hover_progress_bar_enabled",
    default: true,
  },
  toolbar_auto_collapse: {
    storageKey: "hover_toolbar_auto_collapse",
    default: true,
  },
  default_tool: {
    storageKey: "hover_action_button_default_tool",
    default: "search",
  },

  // Compound blobs
  wallpaper_meta: {
    storageKey: "hover_wallpaper_meta",
    default: DEFAULT_WALLPAPER_META,
  },
  ball_style: {
    storageKey: "hover_ball_style",
    default: DEFAULT_BALL_STYLE,
  },

  // Night mode startup behavior
  // 'day'     — always launch in day mode (file-menu toggle still works at runtime, not persisted)
  // 'night'   — always launch in night mode (toggle works at runtime, not persisted)
  // 'persist' — remember the last toggled mode across launches
  night_mode_startup: {
    storageKey: "hover_night_mode_startup",
    default: "day",
  },
  night_mode_last: {
    storageKey: "hover_night_mode_last",
    default: false,
  },

  // Split window persistence
  split_persist: {
    storageKey: "hover_split_persist",
    default: false,
  },
  // { direction: 'horizontal'|'vertical', ratio: number } | null
  split_state: {
    storageKey: "hover_split_state",
    default: null,
  },
};

export class Config {
  /** @type {Record<string, any>|null} */
  static _cache = null;
  /** @type {Map<string, Set<Function>>} */
  static _listeners = new Map();

  static get SCHEMA() {
    return SCHEMA;
  }

  /** Defaults exported for callers that need to merge against them. */
  static get DEFAULTS() {
    return {
      wallpaper_meta: DEFAULT_WALLPAPER_META,
      ball_style: DEFAULT_BALL_STYLE,
    };
  }

  // ╍╍╍ Public API ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Read every known key into the in-memory cache.
   * Call once during app startup before constructing components that
   * read configuration synchronously.
   */
  static async load() {
    const storageKeys = Object.values(SCHEMA).map((s) => s.storageKey);
    const stored = await this._readAll(storageKeys);

    const cache = {};
    for (const [key, def] of Object.entries(SCHEMA)) {
      const raw = stored[def.storageKey];
      if (raw === undefined) {
        // Clone object/array defaults so callers can't accidentally
        // mutate the schema-level reference.
        cache[key] =
          def.default !== null && typeof def.default === "object"
            ? structuredClone(def.default)
            : def.default;
      } else {
        cache[key] = raw;
      }
    }
    this._cache = cache;
  }

  /**
   * @param {keyof typeof SCHEMA} key
   * @returns {any}
   */
  static get(key) {
    const def = SCHEMA[key];
    if (!def) {
      console.warn(`[Config] get('${key}') — unknown key`);
      return undefined;
    }
    if (!this._cache) {
      console.warn(
        `[Config] get('${key}') called before load() — returning default`,
      );
      return def.default;
    }
    return this._cache[key];
  }

  /**
   * @param {keyof typeof SCHEMA} key
   * @param {any} value
   */
  static async set(key, value) {
    const def = SCHEMA[key];
    if (!def) {
      throw new Error(`[Config] set('${key}') — unknown key`);
    }
    if (!this._cache) this._cache = {};
    this._cache[key] = value;
    await this._writeOne(def.storageKey, value);
    this._emit(key, value);
  }

  /**
   * Subscribe to changes for a key. Returns an unsubscribe function.
   * @param {keyof typeof SCHEMA} key
   * @param {(value: any) => void} cb
   * @returns {() => void}
   */
  static subscribe(key, cb) {
    let set = this._listeners.get(key);
    if (!set) {
      set = new Set();
      this._listeners.set(key, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  static _emit(key, value) {
    const set = this._listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(value);
      } catch (err) {
        console.error(`[Config] listener for '${key}' threw:`, err);
      }
    }
  }

  // ╍╍╍ Storage backend ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Read multiple keys. Prefers chrome.storage.local; falls back to
   * localStorage for any key not present there.
   * @param {string[]} storageKeys
   * @returns {Promise<Record<string, any>>}
   */
  static _readAll(storageKeys) {
    return new Promise((resolve) => {
      const ls = this._readAllLocalStorage(storageKeys);

      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve(ls);
        return;
      }

      chrome.storage.local.get(storageKeys, (result) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[Config] chrome.storage read error:",
            chrome.runtime.lastError,
          );
          resolve(ls);
          return;
        }
        const merged = { ...ls };
        for (const k of storageKeys) {
          if (result[k] !== undefined) merged[k] = result[k];
        }
        resolve(merged);
      });
    });
  }

  /**
   * Reads localStorage and parses each value. Tolerates pre-Config
   * writes that stored raw strings (e.g. 'search', 'true') as well as
   * JSON-encoded blobs.
   * @param {string[]} storageKeys
   */
  static _readAllLocalStorage(storageKeys) {
    const out = {};
    for (const k of storageKeys) {
      try {
        const raw = localStorage.getItem(k);
        if (raw === null) continue;
        try {
          out[k] = JSON.parse(raw);
        } catch {
          // Legacy non-JSON values (e.g. setItem(k, 'search'))
          if (raw === "true") out[k] = true;
          else if (raw === "false") out[k] = false;
          else out[k] = raw;
        }
      } catch {
        // localStorage unavailable (private mode, etc.) — skip
      }
    }
    return out;
  }

  /**
   * Mirror a write to both chrome.storage.local and localStorage.
   * @param {string} storageKey
   * @param {any} value
   */
  static _writeOne(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (err) {
      console.warn("[Config] localStorage write error:", err);
    }

    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [storageKey]: value }, () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[Config] chrome.storage write error:",
            chrome.runtime.lastError,
          );
        }
        resolve();
      });
    });
  }
}
