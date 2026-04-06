/**
 * Trail Linker — connects citation link clicks to trail creation/extension.
 *
 * Step A: Captures clicks on outbound links in the citation popup.
 * Step B: Matches newly opened PDFs against pending connections.
 */

import {
  TrailStore,
  normalizeTitle,
  extractUrlFragment,
} from "./trail_store.js";

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MIN_TITLE_LEN = 15;

/**
 * Check if two normalized titles match, accounting for truncated/multi-line titles.
 * Returns true if the shorter title is a prefix of the longer (min 15 chars),
 * or if they share at least 50% of their words.
 * @param {string} a - normalized title
 * @param {string} b - normalized title
 * @returns {boolean}
 */
function titlesMatch(a, b) {
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  // Prefix check: detected title is often just the first line
  if (shorter.length >= MIN_TITLE_LEN && longer.startsWith(shorter)) {
    return true;
  }

  // Word overlap: handles reordering or partial extraction
  const wordsA = a.split(" ");
  const wordsB = new Set(b.split(" "));
  if (wordsA.length < 3) return false;
  const overlap = wordsA.filter((w) => wordsB.has(w)).length;
  return overlap / wordsA.length >= 0.5;
}

export class TrailLinker {
  /**
   * @param {import('../doc.js').PDFDocumentModel} pdfmodel
   * @param {TrailStore} trailStore
   * @param {string|null} originalUrl — the URL this PDF was opened from
   */
  constructor(pdfmodel, trailStore, originalUrl) {
    this.pdfmodel = pdfmodel;
    this.trailStore = trailStore;
    this.originalUrl = originalUrl;
  }

  /**
   * Set up the delegated click listener for citation popup links.
   * Must be called once after construction.
   */
  initialize() {
    document.body.addEventListener(
      "click",
      (e) => {
        const link = e.target.closest("a");
        if (!link) return;

        // Only capture clicks inside the citation popup
        const popup = link.closest(".citation-popup");
        if (!popup) return;

        // Must be an outbound link (scholar-title or URL/arXiv in reference text)
        const isScholarTitle = link.classList.contains("scholar-title");
        const isRefLink =
          link.closest(".citation-popup-text") ||
          link.closest(".citation-popup-content");

        if (!isScholarTitle && !isRefLink) return;
        if (!link.href || link.href.startsWith("#")) return;

        // Grab the destination paper title from the scholar-title link text,
        // or from the scholar-title sibling if this is a ref link
        let destinationTitle = "";
        if (isScholarTitle) {
          destinationTitle = link.textContent.trim();
        } else {
          const scholarEl = popup.querySelector(".scholar-title");
          if (scholarEl) destinationTitle = scholarEl.textContent.trim();
        }

        // Do NOT preventDefault — the link opens normally
        this.#captureClick(link.href, popup, destinationTitle);
      },
      true, // capture phase
    );
  }

  /**
   * Record a pending connection from the current paper to a destination URL.
   * @param {string} destinationUrl
   * @param {HTMLElement} popupEl
   * @param {string} destinationTitle — title of the destination paper from Scholar
   */
  async #captureClick(destinationUrl, popupEl, destinationTitle) {
    try {
      const displayTitle = await this.pdfmodel.getDocumentTitle();
      if (!displayTitle) return;

      const referenceText = popupEl.dataset.reference || "";
      const fromPaperUrl =
        this.originalUrl ||
        new URLSearchParams(window.location.search).get("url") ||
        "";

      /** @type {import('./trail_store.js').PendingConnection} */
      const connection = {
        fromPaperTitle: normalizeTitle(displayTitle),
        fromPaperDisplayTitle: displayTitle,
        fromPaperUrl,
        referenceText,
        destinationUrl,
        destinationUrlFragment: extractUrlFragment(destinationUrl),
        destinationTitle: destinationTitle || "",
        destinationTitleNormalized: normalizeTitle(destinationTitle || ""),
        timestamp: Date.now(),
      };

      console.log("[Trail] Citation click captured:", {
        fromTitle: displayTitle,
        destinationTitle,
        destinationUrl,
        fragment: connection.destinationUrlFragment,
      });
      await TrailStore.addPendingConnection(connection);
    } catch (err) {
      console.warn("[Trail] Failed to capture click:", err);
    }
  }

  /**
   * Check pending connections against the current PDF.
   * Called once after buildIndex() completes and title is available.
   * @param {string|null} detectedTitle
   * @returns {Promise<{trail: Object, node: Object}|null>} the matched trail/node, or null
   */
  async matchOnOpen(detectedTitle) {
    try {
      const pending = await TrailStore.getPendingConnections();
      if (!pending.length) return null;

      const now = Date.now();
      const currentUrlFragment = extractUrlFragment(this.originalUrl || "");
      const currentNormalizedTitle = normalizeTitle(detectedTitle || "");

      let matched = null;

      for (const conn of pending) {
        // Discard stale connections
        if (now - conn.timestamp > PENDING_TTL_MS) continue;

        let isMatch = false;

        // Primary match: normalized title — exact or substring for truncated titles
        if (currentNormalizedTitle && conn.destinationTitleNormalized) {
          if (currentNormalizedTitle === conn.destinationTitleNormalized) {
            isMatch = true;
          } else {
            isMatch = titlesMatch(
              currentNormalizedTitle,
              conn.destinationTitleNormalized,
            );
          }
        }

        // Secondary match: URL fragment (reliable for arXiv, DOI)
        if (
          !isMatch &&
          currentUrlFragment &&
          conn.destinationUrlFragment &&
          currentUrlFragment.includes(conn.destinationUrlFragment)
        ) {
          isMatch = true;
        }

        if (!isMatch) continue;

        matched = conn;
        break;
      }

      if (!matched) return null;

      console.log("[Trail] Matched pending connection:", {
        from: matched.fromPaperDisplayTitle,
        destinationTitle: matched.destinationTitle,
        detectedTitle,
      });

      // Remove the matched connection
      await TrailStore.removePendingConnection(matched.timestamp);

      // Connect to an existing trail or create a new one
      return await this.#connectToTrail(matched, detectedTitle);
    } catch (err) {
      console.warn("[Trail] Failed to match on open:", err);
      return null;
    }
  }

  /**
   * Add the current paper to an existing trail or create a new one.
   * @param {import('./trail_store.js').PendingConnection} connection
   * @param {string|null} detectedTitle
   * @returns {Promise<{trail: Object, node: Object}|null>}
   */
  async #connectToTrail(connection, detectedTitle) {
    const sourceNormalized = connection.fromPaperTitle;
    const existingLocations =
      this.trailStore.getTrailsForTitle(sourceNormalized);

    const childNodeData = {
      id: crypto.randomUUID(),
      normalizedTitle: normalizeTitle(detectedTitle || ""),
      displayTitle: detectedTitle || "Untitled",
      url:
        this.originalUrl ||
        new URLSearchParams(window.location.search).get("url") ||
        "",
      referenceText: connection.referenceText || null,
      openedAt: Date.now(),
      lastPage: 0,
    };

    if (existingLocations.length > 0) {
      // Add as child of the source paper's node in the first matching trail
      const { trailId, nodeId } = existingLocations[0];
      const node = await this.trailStore.addChildNode(
        trailId,
        nodeId,
        childNodeData,
      );
      if (node) {
        const trail = this.trailStore.getTrail(trailId);
        console.log(
          "[Trail] Extended trail:",
          trail.rootNode.displayTitle,
          "→",
          childNodeData.displayTitle,
        );
        return { trail, node };
      }
    }

    // No existing trail contains the source paper — create a new trail
    const rootNodeData = {
      id: crypto.randomUUID(),
      normalizedTitle: sourceNormalized,
      displayTitle: connection.fromPaperDisplayTitle,
      url: connection.fromPaperUrl,
      referenceText: null,
      openedAt: connection.timestamp,
      lastPage: 0,
    };

    const trail = await this.trailStore.createTrail(rootNodeData);

    // Add current paper as the first child
    await this.trailStore.addChildNode(
      trail.id,
      trail.rootNode.id,
      childNodeData,
    );

    console.log(
      "[Trail] New trail:",
      rootNodeData.displayTitle,
      "→",
      childNodeData.displayTitle,
    );
    return { trail, node: childNodeData };
  }
}
