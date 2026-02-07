/**
 * CitationBuilder - Merge extracted citations with native PDF annotations
 *
 * Creates a single source of truth for all in-text citations by:
 * 1. Indexing native PDF link annotations that point to reference section
 * 2. For native links with invalid destinations (x=0 or y=0), treat as extracted
 * 3. Merging: extracted citations win on overlap, native fills gaps
 * 4. Preserving range notation and confirmation flags
 *
 * Output is organized by page for efficient lazy rendering.
 *
 * @typedef {Object} RefKey
 * @property {string} author - First author surname
 * @property {string|null} secondAuthor - Second author surname (for two-author citations)
 * @property {string} year - Year string
 * @property {boolean} isRange - Whether this is a year range (e.g., 1996-2004)
 *
 * @typedef {Object} Citation
 * @property {string} type - 'numeric' | 'author-year' | 'superscript'
 * @property {string} text - The matched text
 * @property {number} pageNumber - 1-based page number
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects
 * @property {number[]} refIndices - Expanded reference indices
 * @property {Array<{start: number, end: number}>} refRanges - Original range notation
 * @property {RefKey[]|null} refKeys - For author-year citations
 * @property {number} confidence - 0-1 confidence score
 * @property {number} flags - CitationFlags bitmask
 * @property {{pageIndex: number, x: number, y: number}|null} targetLocation - Primary navigation target
 * @property {Array<{refIndex: number, refKey: RefKey|null, location: {pageIndex: number, x: number, y: number}}>} allTargets - All reference targets
 */

import { CitationFlags } from "./lexicon.js";

/**
 * Main citation builder class
 */
export class CitationBuilder {
  #referenceIndex = null;
  #textIndex = null;
  #nativeAnnotationsByPage = null;
  #numPages = 0;

  // Reference signatures for matching
  #signatures = [];

  // Reference section bounds
  #refSectionStartPage = Infinity;

  /**
   * @param {Object} referenceIndex - Reference index from buildReferenceIndex
   * @param {Map<number, Array>} nativeAnnotationsByPage - Native annotations by page
   * @param {number} numPages - Total page count
   */
  constructor(referenceIndex, nativeAnnotationsByPage, textIndex, numPages) {
    this.#referenceIndex = referenceIndex;
    this.#nativeAnnotationsByPage = nativeAnnotationsByPage || new Map();
    this.#textIndex = textIndex;
    this.#numPages = numPages;
    this.#signatures = referenceIndex?.anchors || [];
    this.#refSectionStartPage =
      referenceIndex?.sectionStart?.pageNumber || Infinity;
  }

  /**
   * Build merged citations from extracted and native sources
   *
   * @param {Array} extractedCitations - Raw citations from InlineExtractor
   * @returns {Map<number, Citation[]>} Citations organized by page number
   */
  build(extractedCitations) {
    console.log("[CitationBuilder] Starting citation merge...");

    // Phase 1: Index native citation links
    const nativeIndex = this.#indexNativeCitationLinks();
    console.log(`[CitationBuilder] Indexed ${nativeIndex.size} native links`);

    // Phase 2: Build merged citation map by position
    const mergedMap = this.#mergeCitations(extractedCitations, nativeIndex);
    console.log(`[CitationBuilder] Merged into ${mergedMap.size} citations`);

    // Phase 3: Organize by page for lazy rendering
    const byPage = this.#organizeByPage(mergedMap);

    // Phase 4: Filter by confidence
    for (const [pageNum, citations] of byPage) {
      byPage.set(
        pageNum,
        citations.filter((c) => c.confidence >= 0.3),
      );
    }

    const totalCount = Array.from(byPage.values()).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    console.log(`[CitationBuilder] Final: ${totalCount} citations`);

    return byPage;
  }

  /**
   * Index native PDF annotations that are citation links
   * (i.e., links pointing to the reference section)
   *
   * @returns {Map<string, NativeCitationLink>}
   */
  #indexNativeCitationLinks() {
    const index = new Map();

    for (const [pageNum, annotations] of this.#nativeAnnotationsByPage) {
      // Skip pages in reference section
      if (pageNum >= this.#refSectionStartPage) continue;
      const { height: pageHeight } = this.#textIndex.getPageDimensions(pageNum);

      for (const annot of annotations) {
        // Only process destination links (not URLs)
        if (annot.target?.type !== "destination") continue;

        const dest = annot.target.destination;
        if (!dest) continue;

        const destPageIndex = dest.pageIndex ?? -1;
        const destX = dest.view?.[0] ?? 0;
        const destY = dest.view?.[1] ?? 0;
        const rect = annot.rect;

        if (!rect) continue;

        // Check if link points to reference section
        if (destPageIndex + 1 < this.#refSectionStartPage) continue;

        // Check if destination has valid coordinates
        const hasValidDest = destX !== 0 && destY !== 0;

        // Try to match to a reference anchor by position or by proximity
        let matchedRef = null;
        if (hasValidDest) {
          matchedRef = this.#findReferenceAtLocation(
            destPageIndex + 1,
            destX,
            destY,
          );
        }

        // If no match by position, we'll handle this link as needing text-based matching
        // during the merge phase

        const key = this.#makePositionKey(
          pageNum,
          rect.origin?.x || 0,
          rect.origin?.y || 0,
        );

        index.set(key, {
          pageNumber: pageNum,
          rect: {
            x: rect.origin?.x || 0,
            y: rect.origin?.y || 0,
            width: rect.size?.width || 0,
            height: rect.size?.height || 0,
          },
          hasValidDest,
          destPageIndex,
          destX,
          destY,
          matchedRefIndex: matchedRef?.index || null,
          matchedRefAnchor: matchedRef,
        });
      }
    }

    return index;
  }

  /**
   * Find reference anchor at a specific location
   */
  #findReferenceAtLocation(pageNumber, x, y) {
    let best = null;
    let bestDist = Infinity;

    for (const anchor of this.#signatures) {
      if (anchor.pageNumber !== pageNumber) continue;

      // Calculate distance (y is more important for vertical position)
      const dist =
        Math.abs(anchor.startCoord.y - y) + Math.abs(anchor.startCoord.x - x);

      if (dist < bestDist) {
        bestDist = dist;
        best = anchor;
      }
    }

    // Allow some tolerance for matching
    return bestDist < 50 ? best : null;
  }

  /**
   * Build target location for a reference index
   * @param {number} refIndex - Reference index
   * @returns {{pageIndex: number, x: number, y: number}|null}
   */
  #buildTargetLocation(refIndex) {
    const refAnchor = this.#signatures.find((a) => a.index === refIndex);
    if (!refAnchor) return null;

    const { height: pageHeight } = this.#textIndex.getPageDimensions(
      refAnchor.pageNumber,
    );

    return {
      pageIndex: refAnchor.pageNumber - 1,
      x: refAnchor.startCoord.x,
      y: refAnchor.startCoord.y,
    };
  }

  /**
   * Build all target locations for a citation
   * Maps refIndices to their corresponding refKeys and locations
   *
   * @param {number[]} refIndices - Array of reference indices
   * @param {RefKey[]|null} refKeys - Array of ref keys (for author-year)
   * @returns {Array<{refIndex: number, refKey: RefKey|null, location: Object|null}>}
   */
  #buildAllTargets(refIndices, refKeys) {
    const targets = [];

    for (let i = 0; i < refIndices.length; i++) {
      const refIndex = refIndices[i];
      const refKey = refKeys && refKeys[i] ? refKeys[i] : null;
      const location = this.#buildTargetLocation(refIndex);

      targets.push({
        refIndex,
        refKey,
        location,
      });
    }

    return targets;
  }

  /**
   * Merge extracted citations with native links
   * Extracted citations win on overlap, native fills gaps
   */
  #mergeCitations(extractedCitations, nativeIndex) {
    const merged = new Map();

    // Phase 1: Add all extracted citations, keyed by position
    for (const cit of extractedCitations) {
      if (!cit.rects || cit.rects.length === 0) continue;

      const rect = cit.rects[0];
      const key = this.#makePositionKey(cit.pageNumber, rect.x, rect.y);

      // Build all target locations
      const allTargets = this.#buildAllTargets(cit.refIndices, cit.refKeys);

      // Primary target is the first one with a valid location
      let targetLocation = null;
      for (const target of allTargets) {
        if (target.location) {
          targetLocation = target.location;
          break;
        }
      }

      const citation = {
        type: cit.type,
        text: cit.text,
        pageNumber: cit.pageNumber,
        rects: cit.rects,
        refIndices: cit.refIndices,
        refRanges: cit.refRanges || [],
        refKeys: cit.refKeys,
        confidence: cit.confidence,
        flags: cit.flags || CitationFlags.NONE,
        targetLocation,
        allTargets,
      };

      const existing = merged.get(key);
      if (!existing || existing.confidence < citation.confidence) {
        merged.set(key, citation);
      }
    }

    // Phase 2: Check native links for overlaps and fill gaps
    for (const [nativeKey, nativeLink] of nativeIndex) {
      let foundOverlap = false;

      // Check if any extracted citation overlaps with this native link
      for (const [citKey, citation] of merged) {
        if (citation.pageNumber !== nativeLink.pageNumber) continue;

        if (this.#rectsOverlap(citation.rects, nativeLink.rect)) {
          foundOverlap = true;

          // Native link confirms the extracted citation
          if (nativeLink.hasValidDest && nativeLink.matchedRefIndex !== null) {
            // Check if they agree on the reference
            if (citation.refIndices?.includes(nativeLink.matchedRefIndex)) {
              // Boost confidence and set confirmation flags
              citation.confidence = Math.min(1.0, citation.confidence + 0.2);
              citation.flags |= CitationFlags.NATIVE_CONFIRMED;
              citation.flags |= CitationFlags.DEST_CONFIRMED;

              // Use native destination for navigation (more reliable)
              citation.targetLocation = {
                pageIndex: nativeLink.destPageIndex,
                x: nativeLink.destX,
                y: nativeLink.destY,
              };

              // Update allTargets with the native destination for the matching ref
              const matchingTarget = citation.allTargets.find(
                (t) => t.refIndex === nativeLink.matchedRefIndex,
              );
              if (matchingTarget) {
                matchingTarget.location = {
                  pageIndex: nativeLink.destPageIndex,
                  x: nativeLink.destX,
                  y: nativeLink.destY,
                };
              }
            } else {
              // Different reference - still confirm existence
              citation.flags |= CitationFlags.NATIVE_CONFIRMED;
            }
          } else {
            // Native link exists but has invalid destination
            // Just confirm existence
            citation.flags |= CitationFlags.NATIVE_CONFIRMED;
          }
          break;
        }
      }

      // If no overlap found, check if we should create a citation from native link
      if (
        !foundOverlap &&
        nativeLink.hasValidDest &&
        nativeLink.matchedRefIndex !== null
      ) {
        const targetLocation = {
          pageIndex: nativeLink.destPageIndex,
          x: nativeLink.destX,
          y: nativeLink.destY,
        };

        const citation = {
          type: "numeric", // Default to numeric for native-only
          text: `[${nativeLink.matchedRefIndex}]`,
          pageNumber: nativeLink.pageNumber,
          rects: [nativeLink.rect],
          refIndices: [nativeLink.matchedRefIndex],
          refRanges: [],
          refKeys: null,
          confidence: 0.85, // Slightly lower than extracted + confirmed
          flags: CitationFlags.NATIVE_CONFIRMED | CitationFlags.DEST_CONFIRMED,
          targetLocation,
          allTargets: [
            {
              refIndex: nativeLink.matchedRefIndex,
              refKey: null,
              location: targetLocation,
            },
          ],
        };

        merged.set(nativeKey, citation);
      }
    }

    return merged;
  }

  /**
   * Check if citation rects overlap with a native link rect
   */
  #rectsOverlap(citRects, nativeRect) {
    const tolerance = 0;

    for (const rect of citRects) {
      const overlapX =
        rect.x < nativeRect.x + nativeRect.width + tolerance &&
        rect.x + rect.width > nativeRect.x - tolerance;
      const overlapY =
        rect.y < nativeRect.y + nativeRect.height + tolerance &&
        rect.y + rect.height > nativeRect.y - tolerance;

      if (overlapX && overlapY) {
        return true;
      }
    }

    return false;
  }

  /**
   * Organize citations by page number
   */
  #organizeByPage(mergedMap) {
    const byPage = new Map();

    for (const citation of mergedMap.values()) {
      const pageNum = citation.pageNumber;

      if (!byPage.has(pageNum)) {
        byPage.set(pageNum, []);
      }

      byPage.get(pageNum).push(citation);
    }

    // Sort citations on each page by position (top to bottom, left to right)
    for (const [pageNum, citations] of byPage) {
      citations.sort((a, b) => {
        const rectA = a.rects[0];
        const rectB = b.rects[0];
        const yDiff = rectA.y - rectB.y;
        if (Math.abs(yDiff) > 5) return yDiff;
        return rectA.x - rectB.x;
      });
    }

    return byPage;
  }

  /**
   * Create position key for deduplication
   */
  #makePositionKey(pageNumber, x, y) {
    return `${pageNumber}:${Math.round(x)}:${Math.round(y)}`;
  }
}

/**
 * Factory function to create CitationBuilder
 *
 * @param {import('./doc.js').PDFDocumentModel} doc
 * @returns {CitationBuilder}
 */
export function createCitationBuilder(doc) {
  return new CitationBuilder(
    doc.referenceIndex,
    doc.nativeAnnotationsByPage,
    doc.textIndex,
    doc.numPages,
  );
}
