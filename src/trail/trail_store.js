/**
 * Trail Store — data persistence, in-memory index, CRUD operations
 * for reading trail tracking across academic papers.
 */

const TRAIL_DB_NAME = "hover-trails";
const TRAIL_DB_STORE = "trails";
const PENDING_KEY = "hover-pending-connections";
const BROADCAST_CHANNEL = "hover-trail-sync";
const MAX_TRAILS = 8;
const MAX_PENDING = 5;
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ============================================
// Title Normalization & URL Fragment Extraction
// ============================================

/**
 * Normalize a paper title for dedup matching.
 * Lowercases, strips all punctuation, collapses whitespace, trims.
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (!title) return "";
  return title
    .replace(/[^a-z0-9\s]/gi, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Extract a meaningful identifier from a URL for matching.
 * - arXiv: extract paper ID (e.g. "2404.19178")
 * - DOI: extract DOI path (e.g. "10.1234/abcde")
 * - Fallback: hostname + pathname
 * @param {string} url
 * @returns {string}
 */
export function extractUrlFragment(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);

    // arXiv URLs: /abs/XXXX.XXXXX or /pdf/XXXX.XXXXX
    const arxivMatch = parsed.pathname.match(/\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/);
    if (arxivMatch) return arxivMatch[1];

    // DOI URLs: doi.org/10.XXXX/...
    if (parsed.hostname.includes("doi.org")) {
      const doiMatch = parsed.pathname.match(/\/(10\.\d{4,}\/\S+)/);
      if (doiMatch) return doiMatch[1];
    }

    return parsed.hostname + parsed.pathname;
  } catch {
    return url;
  }
}

// ============================================
// IndexedDB Helpers
// ============================================

/**
 * @returns {Promise<IDBDatabase>}
 */
function openTrailDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TRAIL_DB_NAME, 1);
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore(TRAIL_DB_STORE);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @returns {Promise<Object[]>}
 */
function dbGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_DB_STORE, "readonly");
    const req = tx.objectStore(TRAIL_DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {Object} value
 * @returns {Promise<void>}
 */
function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_DB_STORE, "readwrite");
    tx.objectStore(TRAIL_DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @returns {Promise<void>}
 */
function dbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_DB_STORE, "readwrite");
    tx.objectStore(TRAIL_DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ============================================
// Tree Traversal Helpers
// ============================================

/**
 * DFS walk all nodes in a trail tree, calling fn(node) for each.
 * @param {TrailNode} node
 * @param {(node: TrailNode) => void} fn
 */
function walkNodes(node, fn) {
  if (!node) return;
  fn(node);
  if (node.children) {
    for (const child of node.children) {
      walkNodes(child, fn);
    }
  }
}

/**
 * DFS search for a node by ID in a trail tree.
 * @param {TrailNode} node
 * @param {string} nodeId
 * @returns {TrailNode|null}
 */
function findNode(node, nodeId) {
  if (!node) return null;
  if (node.id === nodeId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, nodeId);
      if (found) return found;
    }
  }
  return null;
}

// ============================================
// TrailStore Class
// ============================================

/**
 * @typedef {Object} TrailNode
 * @property {string} id
 * @property {string} normalizedTitle
 * @property {string} displayTitle
 * @property {string} url
 * @property {string|null} referenceText
 * @property {number} openedAt
 * @property {number} lastPage
 * @property {TrailNode[]} children
 */

/**
 * @typedef {Object} Trail
 * @property {string} id
 * @property {TrailNode} rootNode
 * @property {number} createdAt
 * @property {number} lastAccessedAt
 * @property {boolean} starred
 */

/**
 * @typedef {Object} PendingConnection
 * @property {string} fromPaperTitle - normalized title of source paper
 * @property {string} fromPaperDisplayTitle - original title for display
 * @property {string} fromPaperUrl
 * @property {string} referenceText - the citation text
 * @property {string} destinationUrl - href from the clicked link
 * @property {string} destinationUrlFragment - extracted identifier
 * @property {number} timestamp
 */

export class TrailStore {
  constructor() {
    /** @type {IDBDatabase|null} */
    this.db = null;
    /** @type {Map<string, Trail>} trail ID → Trail */
    this.trails = new Map();
    /** @type {Map<string, Array<{trailId: string, nodeId: string}>>} normalized title → locations */
    this.titleIndex = new Map();

    /** @type {BroadcastChannel} */
    this.channel = new BroadcastChannel(BROADCAST_CHANNEL);
    /** @type {((event: string) => void)|null} */
    this.onSync = null;
    this.channel.onmessage = () => this.#handleSync();
  }

  async initialize() {
    this.db = await openTrailDb();
    const allTrails = await dbGetAll(this.db);
    this.trails.clear();
    for (const trail of allTrails) {
      this.trails.set(trail.id, trail);
    }
    this.#rebuildTitleIndex();
  }

  /** Notify other tabs that trails changed. */
  #broadcast() {
    this.channel.postMessage("changed");
  }

  /** Handle incoming sync from another tab. */
  async #handleSync() {
    try {
      await this.initialize();
      if (this.onSync) this.onSync();
    } catch (err) {
      console.warn("[Trail] Sync failed:", err);
    }
  }

  #rebuildTitleIndex() {
    this.titleIndex.clear();
    for (const [trailId, trail] of this.trails) {
      walkNodes(trail.rootNode, (node) => {
        if (!node.normalizedTitle) return;
        const entries = this.titleIndex.get(node.normalizedTitle) || [];
        entries.push({ trailId, nodeId: node.id });
        this.titleIndex.set(node.normalizedTitle, entries);
      });
    }
  }

  /**
   * @param {string} normalizedTitle
   * @returns {Array<{trailId: string, nodeId: string}>}
   */
  getTrailsForTitle(normalizedTitle) {
    return this.titleIndex.get(normalizedTitle) || [];
  }

  /** @returns {Trail[]} */
  getAllTrails() {
    return [...this.trails.values()];
  }

  /**
   * @param {string} trailId
   * @returns {Trail|undefined}
   */
  getTrail(trailId) {
    return this.trails.get(trailId);
  }

  /**
   * Create a new trail with the given root node data.
   * Prunes oldest non-starred trail if over cap.
   * @param {Omit<TrailNode, 'children'>} rootNodeData
   * @returns {Promise<Trail>}
   */
  async createTrail(rootNodeData) {
    const trail = {
      id: crypto.randomUUID(),
      rootNode: { ...rootNodeData, children: rootNodeData.children || [] },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      starred: false,
    };

    this.trails.set(trail.id, trail);
    await this.#pruneIfNeeded();
    await dbPut(this.db, trail.id, trail);
    this.#rebuildTitleIndex();
    this.#broadcast();
    return trail;
  }

  /**
   * Add a child node to an existing trail.
   * @param {string} trailId
   * @param {string} parentNodeId
   * @param {Omit<TrailNode, 'children'>} childNodeData
   * @returns {Promise<TrailNode|null>}
   */
  async addChildNode(trailId, parentNodeId, childNodeData) {
    const trail = this.trails.get(trailId);
    if (!trail) return null;

    const parent = findNode(trail.rootNode, parentNodeId);
    if (!parent) return null;

    // Dedup: skip if parent already has a child with the same normalized title
    if (childNodeData.normalizedTitle) {
      const existing = parent.children.find(
        (c) => c.normalizedTitle === childNodeData.normalizedTitle,
      );
      if (existing) {
        trail.lastAccessedAt = Date.now();
        await dbPut(this.db, trail.id, trail);
        return existing;
      }
    }

    const childNode = { ...childNodeData, children: [] };
    parent.children.push(childNode);
    trail.lastAccessedAt = Date.now();

    await dbPut(this.db, trail.id, trail);
    this.#rebuildTitleIndex();
    this.#broadcast();
    return childNode;
  }

  /**
   * @param {string} trailId
   * @param {boolean} starred
   */
  async starTrail(trailId, starred) {
    const trail = this.trails.get(trailId);
    if (!trail) return;

    trail.starred = starred;
    await dbPut(this.db, trail.id, trail);
    this.#broadcast();
  }

  /** @param {string} trailId */
  async deleteTrail(trailId) {
    this.trails.delete(trailId);
    await dbDelete(this.db, trailId);
    this.#rebuildTitleIndex();
    this.#broadcast();
  }

  /**
   * @param {string} trailId
   * @param {string} nodeId
   * @param {number} pageNumber
   */
  async updateLastPage(trailId, nodeId, pageNumber) {
    const trail = this.trails.get(trailId);
    if (!trail) return;

    const node = findNode(trail.rootNode, nodeId);
    if (!node) return;

    node.lastPage = pageNumber;
    trail.lastAccessedAt = Date.now();
    await dbPut(this.db, trail.id, trail);
  }

  async #pruneIfNeeded() {
    if (this.trails.size <= MAX_TRAILS) return;

    // Find oldest non-starred trail
    let oldest = null;
    for (const trail of this.trails.values()) {
      if (trail.starred) continue;
      if (!oldest || trail.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = trail;
      }
    }

    if (oldest) {
      this.trails.delete(oldest.id);
      await dbDelete(this.db, oldest.id);
    }
  }

  // ============================================
  // Pending Connection Helpers (chrome.storage.local)
  // ============================================

  /**
   * @returns {Promise<PendingConnection[]>}
   */
  static async getPendingConnections() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get(PENDING_KEY, (result) => {
        resolve(result[PENDING_KEY] || []);
      });
    });
  }

  /**
   * @param {PendingConnection[]} connections
   * @returns {Promise<void>}
   */
  static async setPendingConnections(connections) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [PENDING_KEY]: connections }, resolve);
    });
  }

  /**
   * Add a pending connection, maintaining FIFO max 5.
   * @param {PendingConnection} connection
   */
  static async addPendingConnection(connection) {
    const existing = await TrailStore.getPendingConnections();
    existing.push(connection);
    // Keep only the most recent MAX_PENDING entries
    const trimmed =
      existing.length > MAX_PENDING
        ? existing.slice(existing.length - MAX_PENDING)
        : existing;
    await TrailStore.setPendingConnections(trimmed);
  }

  /**
   * Remove a specific pending connection by timestamp.
   * @param {number} timestamp
   */
  static async removePendingConnection(timestamp) {
    const existing = await TrailStore.getPendingConnections();
    const filtered = existing.filter((c) => c.timestamp !== timestamp);
    await TrailStore.setPendingConnections(filtered);
  }

  /**
   * Purge pending connections older than TTL.
   */
  static async purgeStaleConnections() {
    const existing = await TrailStore.getPendingConnections();
    const cutoff = Date.now() - PENDING_TTL_MS;
    const fresh = existing.filter((c) => c.timestamp > cutoff);
    if (fresh.length !== existing.length) {
      await TrailStore.setPendingConnections(fresh);
    }
  }
}
