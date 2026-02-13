const CACHE_TTL_MS = 300000;
const MIN_GAP_MS = 2_000;

class RequestThrottle {
  constructor() {
    /** @type {Map<string, { data: any, ts: number }>} */
    this.cache = new Map();

    /** @type {Map<string, Promise<any>>} */
    this.inFlight = new Map();

    /** Timestamp of the last network request that was actually sent */
    this.lastRequestTime = 0;
  }

  /**
   * Fetch with deduplication, caching, and rate-limiting.
   *
   * @param {string} key   Cache key (typically the search query or a
   *                        composite like `cite:${title}`)
   * @param {(key: string) => Promise<any>} fetchFn
   *        The actual async work. Only invoked when:
   *         - the result is not already cached, AND
   *         - there is no identical in-flight request.
   * @returns {Promise<any>}
   */
  async fetch(key, fetchFn) {
    // 1. Return from cache if still fresh
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.data;
    }

    // 2. Piggy-back on an existing in-flight request for the same key
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    // 3. Enforce minimum gap between actual network requests
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
    }

    // 4. Execute and track
    const promise = fetchFn(key)
      .then((result) => {
        this.cache.set(key, { data: result, ts: Date.now() });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    this.lastRequestTime = Date.now();

    return promise;
  }

  /** Manually invalidate a cached entry */
  invalidate(key) {
    this.cache.delete(key);
  }

  /** Clear all caches (useful on document change) */
  clear() {
    this.cache.clear();
    this.inFlight.clear();
  }
}

// A singleton for both fetch buttons (cite and abstract)
export const requestThrottle = new RequestThrottle();
