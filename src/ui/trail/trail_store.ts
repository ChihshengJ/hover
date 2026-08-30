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
 */
export function normalizeTitle(title: string): string {
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
 */
export function extractUrlFragment(url: string): string {
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

function openTrailDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TRAIL_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TRAIL_DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(db: IDBDatabase): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_DB_STORE, "readonly");
    const req = tx.objectStore(TRAIL_DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

function dbPut(
  db: IDBDatabase,
  key: string,
  value: Record<string, any>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_DB_STORE, "readwrite");
    tx.objectStore(TRAIL_DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_DB_STORE, "readwrite");
    tx.objectStore(TRAIL_DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Tree Traversal Helpers
// ============================================

/**
 * DFS walk all nodes in a trail tree, calling fn(node) for each.
 */
function walkNodes(node: TrailNode, fn: (node: TrailNode) => void) {
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
 */
function findNode(node: TrailNode, nodeId: string): TrailNode | null {
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

export interface TrailNode {
  id: string;
  normalizedTitle: string;
  displayTitle: string;
  url: string;
  referenceText: string | null;
  openedAt: number;
  lastPage: number;
  children: TrailNode[];
}

/** Where a given paper appears: which trail, and which node inside it. */
export interface TrailLocation {
  trailId: string;
  nodeId: string;
}

export interface Trail {
  id: string;
  rootNode: TrailNode;
  createdAt: number;
  lastAccessedAt: number;
  starred: boolean;
}

export interface PendingConnection {
  /** normalized title of source paper */
  fromPaperTitle: string;
  /** original title for display */
  fromPaperDisplayTitle: string;
  fromPaperUrl: string;
  /** the citation text */
  referenceText: string;
  /** href from the clicked link */
  destinationUrl: string;
  /** extracted identifier */
  destinationUrlFragment: string;
  /** link text of the clicked citation */
  destinationTitle: string;
  /** `destinationTitle`, normalized for matching */
  destinationTitleNormalized: string;
  timestamp: number;
}

export class TrailStore {
  db: IDBDatabase | null;
  trails: Map<any, any>;
  titleIndex: Map<any, any>;
  channel: BroadcastChannel;
  onSync: (() => void) | null;

  constructor() {
    this.db = null;
    /** @type {Map<string, Trail>} trail ID → Trail */
    this.trails = new Map();
    /** @type {Map<string, Array<{trailId: string, nodeId: string}>>} normalized title → locations */
    this.titleIndex = new Map();

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

  getTrailsForTitle(normalizedTitle: string): TrailLocation[] {
    return this.titleIndex.get(normalizedTitle) || [];
  }

  getAllTrails(): Trail[] {
    return [...this.trails.values()];
  }

  getTrail(trailId: string): Trail | undefined {
    return this.trails.get(trailId);
  }

  /**
   * Create a new trail with the given root node data.
   * Prunes oldest non-starred trail if over cap.
   */
  async createTrail(
    rootNodeData: Omit<TrailNode, "children"> & { children?: TrailNode[] },
  ): Promise<Trail> {
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
   */
  async addChildNode(
    trailId: string,
    parentNodeId: string,
    childNodeData: Omit<TrailNode, "children">,
  ): Promise<TrailNode | null> {
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

    const childNode: TrailNode = { ...childNodeData, children: [] };
    parent.children.push(childNode);
    trail.lastAccessedAt = Date.now();

    await dbPut(this.db, trail.id, trail);
    this.#rebuildTitleIndex();
    this.#broadcast();
    return childNode;
  }

  async starTrail(trailId: string, starred: boolean) {
    const trail = this.trails.get(trailId);
    if (!trail) return;

    trail.starred = starred;
    await dbPut(this.db, trail.id, trail);
    this.#broadcast();
  }

  async deleteTrail(trailId: string) {
    this.trails.delete(trailId);
    await dbDelete(this.db, trailId);
    this.#rebuildTitleIndex();
    this.#broadcast();
  }

  async updateLastPage(trailId: string, nodeId: string, pageNumber: number) {
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

  static async getPendingConnections(): Promise<PendingConnection[]> {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get(PENDING_KEY, (result) => {
        resolve((result[PENDING_KEY] as PendingConnection[]) || []);
      });
    });
  }

  static async setPendingConnections(
    connections: PendingConnection[],
  ): Promise<void> {
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
   */
  static async addPendingConnection(connection: PendingConnection) {
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
   */
  static async removePendingConnection(timestamp: number) {
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
