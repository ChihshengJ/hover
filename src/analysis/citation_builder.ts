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
 */

import { CitationFlags } from "./lexicon.js";
import { rectFromPdfium } from "./geometry.js";
import type { ReferenceAnchor, ReferenceIndex } from "./reference_builder.js";
import type { DocumentTextIndex } from "./text_index.js";
import type { RawCitation } from "./inline_extractor.js";

export interface RefKey {
  /** First author surname. */
  author: string;
  /** Second author surname, for two-author citations. */
  secondAuthor: string | null;
  year: string;
  /** Whether this is a year range (e.g. 1996-2004). */
  isRange: boolean;
}

/**
 * One reference a citation points at. `rects` is the sub-span of the citation
 * that names this particular reference — present only for multi-reference
 * citations like `[3,5]`, where each number is separately clickable.
 */
export interface CitationTarget {
  refIndex: RefIndex | null;
  refKey: RefKey | null;
  location: PageLocation | null;
  rects?: Rect[] | null;
}

export interface Citation {
  /** 'numeric' | 'abbreviated' | 'author-year' | 'superscript' | 'imported' */
  type: string;
  /** The matched text. */
  text: string;
  /** 1-based. */
  pageNumber: number;
  rects: Rect[];
  /** Expanded reference indices. */
  refIndices: RefIndex[];
  /** Original range notation. */
  refRanges: Array<{ start: number; end: number }>;
  /** For author-year citations. */
  refKeys: RefKey[] | null;
  /** 0-1 confidence score. */
  confidence: number;
  /** CitationFlags bitmask. */
  flags: number;
  /** Primary navigation target. */
  targetLocation: PageLocation | null;
  allTargets: CitationTarget[];
}

/**
 * A native PDF link annotation that points into the reference section, keyed
 * by its position on the page.
 */
export interface NativeCitationLink {
  /** 1-based page the link sits on. */
  pageNumber: number;
  rect: Rect;
  /** False for the x=0/y=0 degenerate targets. */
  hasValidDest: boolean;
  /** 0-based destination page. */
  destPageIndex: number;
  destX: number;
  destY: number;
  matchedRefIndex: RefIndex | null;
  matchedRefAnchor: ReferenceAnchor | null;
}

/** What `build()` hands back. */
export interface CitationBuildResult {
  byPage: Map<number, { citationId: number; rects: Rect[]; flags: number }[]>;
  details: Map<number, Citation>;
}

/**
 * Main citation builder class
 */
export class CitationBuilder {
  #referenceIndex: ReferenceIndex | null = null;
  #textIndex: DocumentTextIndex = null;
  #nativeAnnotationsByPage: Map<number, any[]> = null;

  /** Reference anchors, used to match a citation to what it points at. */
  #signatures: ReferenceAnchor[] = [];

  // Reference section bounds
  #refSectionStartPage = Infinity;
  #refSectionEndPage = -1;

  constructor(
    referenceIndex: ReferenceIndex,
    nativeAnnotationsByPage: Map<number, any[]>,
    textIndex: DocumentTextIndex,
  ) {
    this.#referenceIndex = referenceIndex;
    this.#nativeAnnotationsByPage = nativeAnnotationsByPage || new Map();
    this.#textIndex = textIndex;
    this.#signatures = referenceIndex?.anchors || [];
    this.#refSectionStartPage =
      referenceIndex?.sectionStart?.pageNumber || Infinity;
    this.#refSectionEndPage = referenceIndex?.sectionEnd?.pageNumber || -1;
  }

  build(extractedCitations: RawCitation[]): CitationBuildResult {
    console.log("[CitationBuilder] Starting citation merge...");
    const nativeIndex = this.#indexNativeCitationLinks();
    console.log(`[CitationBuilder] Indexed ${nativeIndex.size} native links`);
    const mergedMap = this.#mergeCitations(extractedCitations, nativeIndex);
    console.log(`[CitationBuilder] Merged into ${mergedMap.size} citations`);

    const byPage: CitationBuildResult["byPage"] = new Map();
    const details: CitationBuildResult["details"] = new Map();
    let nextId = 0;

    for (const [key, citation] of mergedMap) {
      if (citation.confidence < 0.3) continue;

      const citationId = nextId++;
      details.set(citationId, citation);

      const ref = {
        citationId,
        rects: citation.rects,
        flags: citation.flags,
      };

      const arr = byPage.get(citation.pageNumber);
      if (arr) {
        arr.push(ref);
      } else {
        byPage.set(citation.pageNumber, [ref]);
      }
    }

    const totalCount = Array.from(byPage.values()).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    console.log(`[CitationBuilder] Final: ${totalCount} citations`);

    return { byPage, details };
  }

  /** Index native PDF annotations that are citation links (i.e., links pointing to the reference section) */
  #indexNativeCitationLinks(): Map<string, NativeCitationLink> {
    const index = new Map();

    for (const [pageNum, annotations] of this.#nativeAnnotationsByPage) {
      // Skip pages in reference section
      if (
        pageNum > this.#refSectionStartPage &&
        pageNum <= this.#refSectionEndPage
      )
        continue;
      const {
        width: pageWidth,
        height: pageHeight,
        multiColumn,
      } = this.#textIndex.getPageDimensions(pageNum);

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

        const hasValidDest =
          (multiColumn ? destX * destY !== 0 : destY !== 0) &&
          rect.origin.x < pageWidth &&
          rect.origin.y < pageHeight;

        let matchedRef = null;
        if (hasValidDest) {
          matchedRef = this.#findReferenceAtLocation(
            destPageIndex + 1,
            destX,
            destY,
          );
        }

        const flatRect = rectFromPdfium(rect);
        const key = this.#makePositionKey(pageNum, flatRect.x, flatRect.y);

        index.set(key, {
          pageNumber: pageNum,
          rect: flatRect,
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
  #findReferenceAtLocation(
    pageNumber: number,
    x: number,
    y: number,
  ): ReferenceAnchor | null {
    let best: ReferenceAnchor | null = null;
    let bestDist = Infinity;

    for (const anchor of this.#signatures) {
      if (anchor.pageNumber !== pageNumber) continue;
      if (anchor.startCoord.y > y) continue;

      let dist = Math.abs(anchor.startCoord.y - y);
      if (x !== 0) dist = dist + Math.abs(anchor.startCoord.x - x);

      if (dist < bestDist) {
        bestDist = dist;
        best = anchor;
      }
    }

    // Allow some tolerance for matching
    return bestDist < 50 ? best : null;
  }

  /** Where in the document reference `refIndex` lives. */
  #buildTargetLocation(refIndex: RefIndex): PageLocation | null {
    const refAnchor = this.#signatures.find((a) => a.index === refIndex);
    if (!refAnchor) return null;

    return {
      pageIndex: refAnchor.pageNumber - 1,
      x: refAnchor.startCoord.x,
      y: refAnchor.startCoord.y,
    };
  }

  /**
   * Build all target locations for a citation
   * Maps refIndices to their corresponding refKeys, locations, and per-number rects
   *
   * @param subCitations Per-number rects from extraction
   */
  #buildAllTargets(
    refIndices: RefIndex[],
    refKeys: RefKey[] | null,
    subCitations:
      | Array<{ refIndex: RefIndex; rects: Rect[] }>
      | null
      | undefined,
  ): CitationTarget[] {
    const targets: CitationTarget[] = [];

    for (let i = 0; i < refIndices.length; i++) {
      const refIndex = refIndices[i];
      const refKey = refKeys && refKeys[i] ? refKeys[i] : null;
      const location = this.#buildTargetLocation(refIndex);

      // Find per-number rects for this refIndex from subCitations
      const sub = subCitations?.find((s) => s.refIndex === refIndex);

      targets.push({
        refIndex,
        refKey,
        location,
        rects: sub?.rects || null,
      });
    }

    return targets;
  }

  /**
   * Merge extracted citations with native links
   * Extracted citations win on overlap, native fills gaps
   */
  #mergeCitations(
    extractedCitations: RawCitation[],
    nativeIndex: Map<string, NativeCitationLink>,
  ): Map<string, Citation> {
    const merged = new Map<string, Citation>();

    // Phase 1: Add all extracted citations, keyed by position
    for (const cit of extractedCitations) {
      if (!cit.rects || cit.rects.length === 0) continue;

      const rect = cit.rects[0];
      const key = this.#makePositionKey(cit.pageNumber, rect.x, rect.y);

      // Build all target locations
      const allTargets = this.#buildAllTargets(
        cit.refIndices,
        cit.refKeys,
        cit.subCitations,
      );

      // Primary target is the first one with a valid location
      let targetLocation: PageLocation | null = null;
      for (const target of allTargets) {
        if (target.location) {
          targetLocation = target.location;
          break;
        }
      }

      const citation: Citation = {
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

      for (const [citKey, citation] of merged) {
        if (citation.pageNumber !== nativeLink.pageNumber) continue;

        if (this.#rectsOverlap(citation.rects, nativeLink.rect)) {
          foundOverlap = true;

          // Native link confirms the extracted citation
          if (nativeLink.hasValidDest && nativeLink.matchedRefIndex !== null) {
            // Check if they agree on the reference
            if (citation.refIndices?.includes(nativeLink.matchedRefIndex)) {
              citation.confidence = Math.min(1.0, citation.confidence + 0.2);
              citation.flags |= CitationFlags.NATIVE_CONFIRMED;
              citation.flags |= CitationFlags.DEST_CONFIRMED;

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
              // Different reference - use native for author-year (but not for
              // numeric or abbreviated which have explicit key/index matching)
              if (
                citation.type !== "numeric" &&
                citation.type !== "abbreviated"
              ) {
                const targetLocation = {
                  pageIndex: nativeLink.destPageIndex,
                  x: nativeLink.destX,
                  y: nativeLink.destY,
                };
                citation.targetLocation = targetLocation;
                citation.refIndices = [nativeLink.matchedRefIndex];
                citation.refKeys = null;
                citation.allTargets = [
                  {
                    refIndex: nativeLink.matchedRefIndex,
                    refKey: null,
                    location: targetLocation,
                  },
                ];
              }
              citation.flags |= CitationFlags.NATIVE_CONFIRMED;
            }
          } else {
            // Native link exists but has invalid destination
            citation.flags |= CitationFlags.NATIVE_CONFIRMED;
          }
          break;
        }
      }

      // if (
      //   !foundOverlap &&
      //   nativeLink.hasValidDest &&
      //   nativeLink.matchedRefIndex !== null
      // ) {
      if (!foundOverlap) {
        const targetLocation = {
          pageIndex: nativeLink.destPageIndex,
          x: nativeLink.destX,
          y: nativeLink.destY,
        };

        const citation: Citation = {
          type: "imported",
          text: `[${nativeLink.matchedRefIndex}]`,
          pageNumber: nativeLink.pageNumber,
          rects: [nativeLink.rect],
          refIndices: [nativeLink.matchedRefIndex],
          refRanges: [] as Array<{ start: number; end: number }>,
          refKeys: null,
          confidence: 0.85,
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
  #rectsOverlap(citRects: Rect[], nativeRect: Rect): boolean {
    // Smaller tolerance for more precise overlap, works for some papers with dense citations
    const tolerance = -5;

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
   * Create position key for deduplication
   */
  #makePositionKey(pageNumber: number, x: number, y: number): string {
    return `${pageNumber}:${Math.round(x)}:${Math.round(y)}`;
  }
}

/** Factory function to create CitationBuilder. */
export function createCitationBuilder({
  referenceIndex,
  nativeAnnotationsByPage,
  textIndex,
}: {
  referenceIndex: ReferenceIndex;
  nativeAnnotationsByPage: Map<number, any[]>;
  textIndex: DocumentTextIndex;
}): CitationBuilder {
  return new CitationBuilder(
    referenceIndex,
    nativeAnnotationsByPage,
    textIndex,
  );
}
