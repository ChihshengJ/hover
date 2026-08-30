/**
 * CrossReferenceBuilder - Extract targets and merge cross-references
 *
 * This module:
 * 1. Maps outline sections/appendices to cross-reference targets
 * 2. Identifies definition targets (Figure 1:, Table 2:, etc.) from
 *    extracted cross-refs using font/position checks — no redundant full scan
 * 3. Indexes native PDF links that point to non-reference destinations
 * 4. Merges extracted in-text cross-refs with native links
 * 5. Matches cross-references to their target definitions
 *
 * Output is organized by page for efficient lazy rendering.
 */

import {
  CROSSREF_DEFINITION_PATTERNS,
  SECTION_MARK_HEADER_PATTERN,
  CitationFlags,
  CrossRefType,
} from "./lexicon.js";
import { FontStyle } from "./text_index.js";
import { rectFromPdfium } from "./geometry.js";
import {
  SECTION_NUMBER_EXTRACT,
  parseRomanNumeral,
} from "./outline_builder.js";
import type { OutlineItem } from "./outline_builder.js";
import type { DocumentTextIndex, TextLine } from "./text_index.js";
import type { ReferenceIndex } from "./reference_builder.js";
import type { RawCrossRef } from "./inline_extractor.js";

/** Where a "Figure 1"-style reference points: the caption that defines it. */
export interface CrossRefTarget {
  /** 'figure' | 'table' | 'section' | 'equation' | 'appendix' | … */
  type: string;
  /** The identifier (e.g. "1", "1a", "A.2"). */
  targetId: string;
  /** 1-based. */
  pageNumber: number;
  x: number;
  y: number;
  /** The caption/header text. */
  text: string;
}

export interface CrossReference {
  /** 'figure' | 'table' | 'section' | 'equation' | … */
  type: string;
  /** The matched text. */
  text: string;
  targetId: string;
  /** 1-based. */
  pageNumber: number;
  rects: Rect[];
  targetLocation: PageLocation | null;
  /** CitationFlags bitmask. */
  flags: number;
  /**
   * True for the caption that defines the target ("Figure 1: …"), which must
   * not be rendered as a link to itself.
   */
  isDefinition?: boolean;
}

/** What `build()` hands back. */
export interface CrossRefBuildResult {
  byPage: Map<number, CrossReference[]>;
  targets: Map<string, CrossRefTarget>;
}

/**
 * Main cross-reference builder class
 */
export class CrossReferenceBuilder {
  #textIndex: DocumentTextIndex = null;
  #nativeAnnotationsByPage: Map<number, any[]> = null;
  #referenceIndex: ReferenceIndex | null = null;
  #outline: OutlineItem[] = null;

  /** Extracted targets (definitions), keyed `${type}-${targetId}`. */
  #targets = new Map<string, CrossRefTarget>();

  // Reference section bounds (to identify non-reference links)
  #refSectionStartPage = Infinity;
  #refSectionEndPage = -1;

  constructor(
    textIndex: DocumentTextIndex,
    nativeAnnotationsByPage: Map<number, any[]>,
    referenceIndex: ReferenceIndex,
    outline: OutlineItem[],
  ) {
    this.#textIndex = textIndex;
    this.#nativeAnnotationsByPage = nativeAnnotationsByPage || new Map();
    this.#referenceIndex = referenceIndex;
    this.#outline = outline || [];
    this.#refSectionStartPage =
      referenceIndex?.sectionStart?.pageNumber || Infinity;
    this.#refSectionEndPage = referenceIndex?.sectionEnd?.pageNumber || -1;
  }

  /**
   * Build merged cross-references from extracted and native sources
   *
   * @param extractedCrossRefs Raw cross-refs from InlineExtractor
   */
  build(extractedCrossRefs: RawCrossRef[]): CrossRefBuildResult {
    console.log("[CrossRefBuilder] Starting cross-reference build...");

    // Phase 1: Map outline sections to targets
    this.#mapSections();
    console.log(
      `[CrossRefBuilder] Mapped ${this.#targets.size} section targets from outline`,
    );

    // Phase 2: Find definition targets from extracted cross-refs
    this.#findDefinitions(extractedCrossRefs);
    console.log(`[CrossRefBuilder] Total targets: ${this.#targets.size}`);

    // Phase 3: Index native cross-reference links
    const nativeIndex = this.#indexNativeLinks();
    console.log(`[CrossRefBuilder] Indexed ${nativeIndex.size} native links`);

    // Phase 4: Merge cross-references
    const mergedMap = this.#merge(extractedCrossRefs, nativeIndex);
    console.log(`[CrossRefBuilder] Merged into ${mergedMap.size} cross-refs`);

    // Phase 5: Match to target definitions
    this.#matchTargets(mergedMap);

    // Phase 6: Group by page
    const byPage = this.#groupByPage(mergedMap);

    const totalCount = Array.from(byPage.values()).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    console.log(`[CrossRefBuilder] Final: ${totalCount} cross-references`);

    return {
      byPage,
      targets: this.#targets,
    };
  }

  /**
   * Get extracted targets
   */
  getTargets() {
    return this.#targets;
  }

  // ============================================
  // Phase 1: Map Outline Sections to Targets
  // ============================================

  /**
   * Walk the outline tree and register section/appendix targets
   * by extracting and normalizing number prefixes.
   */
  #mapSections() {
    if (!this.#outline?.length) return;

    const walk = (items: OutlineItem[]) => {
      for (const item of items) {
        this.#registerOutlineItem(item);
        if (item.children?.length) walk(item.children);
      }
    };
    walk(this.#outline);
  }

  /**
   * Register a single outline item as section/appendix target(s).
   */
  #registerOutlineItem(item: OutlineItem) {
    const prefix = this.#extractPrefix(item.title);

    if (prefix) {
      const secKey = `section-${prefix}`;
      if (!this.#targets.has(secKey)) {
        this.#targets.set(secKey, {
          type: "section",
          targetId: prefix,
          pageNumber: item.pageIndex + 1,
          x: item.left,
          y: item.top,
          text: item.title,
        });
      }

      if (/^[A-Z]$/.test(prefix)) {
        const appKey = `appendix-${prefix}`;
        if (!this.#targets.has(appKey)) {
          this.#targets.set(appKey, {
            type: "appendix",
            targetId: prefix,
            pageNumber: item.pageIndex + 1,
            x: item.left,
            y: item.top,
            text: item.title,
          });
        }
      }
    }

    // Also detect explicit "Appendix X" in title text
    const appendixMatch = item.title.match(/^appendix\s+([A-Z])/i);
    if (appendixMatch) {
      const letter = appendixMatch[1].toUpperCase();
      for (const key of [`appendix-${letter}`, `section-${letter}`]) {
        if (!this.#targets.has(key)) {
          this.#targets.set(key, {
            type: key.startsWith("appendix") ? "appendix" : "section",
            targetId: letter,
            pageNumber: item.pageIndex + 1,
            x: item.left,
            y: item.top,
            text: item.title,
          });
        }
      }
    }
  }

  /**
   * Extract and normalize the section number prefix from an outline title.
   * Converts Roman numerals to Arabic, preserves letters for appendices.
   * @returns {string|null}
   */
  #extractPrefix(title: string): string | null {
    const match = title.match(SECTION_NUMBER_EXTRACT);
    if (!match) return null;

    const raw = match[1].replace(/\.$/, "").trim();
    if (!raw) return null;

    const parts = raw.split(".");
    const converted = [];

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) {
        converted.push(String(num));
        continue;
      }

      const roman = parseRomanNumeral(trimmed);
      if (roman !== null) {
        converted.push(String(roman));
        continue;
      }

      // Single letter (appendix)
      if (/^[A-Z]$/i.test(trimmed)) {
        converted.push(trimmed.toUpperCase());
        continue;
      }

      converted.push(trimmed);
    }

    return converted.length > 0 ? converted.join(".") : null;
  }

  // ============================================
  // Phase 2: Find Definition Targets
  // ============================================

  /**
   * Identify which extracted cross-refs are actually definitions
   * (e.g., "Figure 1:" at start of a caption line with bold font).
   * Uses targeted line lookups instead of scanning all pages.
   */
  #findDefinitions(crossRefs: RawCrossRef[]) {
    const bodyFontSize = this.#textIndex?.getBodyFontSize() || 10;
    const bodyFontStyle =
      this.#textIndex?.getBodyFontStyle() || FontStyle.REGULAR;

    // Cache page data lookups
    const pageCache = new Map<number, ReturnType<DocumentTextIndex["getPageData"]>>();
    const getPage = (pageNum: number) => {
      if (!pageCache.has(pageNum)) {
        pageCache.set(pageNum, this.#textIndex?.getPageData(pageNum));
      }
      return pageCache.get(pageNum);
    };

    for (const ref of crossRefs) {
      const refY = ref.rects?.[0]?.y;
      if (refY == null) continue;

      const pageData = getPage(ref.pageNumber);
      if (!pageData?.lines) continue;

      const line = this.#findLineByY(pageData.lines, refY);
      if (!line || !line.text || line.text.length < 5) continue;

      // Handle § headers separately
      if (ref.type === "sectionMark") {
        const match = line.text.match(SECTION_MARK_HEADER_PATTERN);
        if (match) {
          const key = `section-${match[1]}`;
          if (!this.#targets.has(key)) {
            this.#targets.set(key, {
              type: "section",
              targetId: match[1],
              pageNumber: ref.pageNumber,
              x: line.x,
              y: line.y,
              text: line.text,
            });
          }
        }
        continue;
      }

      const defPattern =
        CROSSREF_DEFINITION_PATTERNS[
          ref.type as keyof typeof CROSSREF_DEFINITION_PATTERNS
        ];
      if (!defPattern) continue;

      const match = line.text.match(defPattern);
      if (!match) continue;

      if (
        !this.#isDefinition(
          line,
          ref.type,
          bodyFontSize,
          bodyFontStyle,
          pageData.pageWidth,
          match,
        )
      ) {
        continue;
      }

      const targetId = ref.type === "theorem" ? match[2] : match[1];
      const fullType =
        ref.type === "theorem" ? match[1].toLowerCase() : ref.type;
      const key = `${fullType}-${targetId}`;
      ref.isDefinition = true;

      if (!this.#targets.has(key)) {
        this.#targets.set(key, {
          type: fullType,
          targetId,
          pageNumber: ref.pageNumber,
          x: line.x,
          y: line.y,
          text: line.text,
        });
      }
    }
  }

  /**
   * Find the closest line to a given y-coordinate.
   */
  #findLineByY(lines: TextLine[], y: number): TextLine | null {
    let best: TextLine | null = null;
    let bestDist = Infinity;
    for (const line of lines) {
      const dist = Math.abs(line.originalY - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = line;
      }
    }
    return bestDist < 10 ? best : null;
  }

  /**
   * Validate that a line is a definition (caption/header)
   */
  #isDefinition(
    line: TextLine,
    type: string,
    bodyFontSize: number,
    bodyFontStyle: number,
    pageWidth: number,
    match: RegExpMatchArray,
  ): boolean {
    const firstItem = line.items?.[0];
    if (!firstItem) return false;

    const itemFontStyle = firstItem.fontStyle ?? FontStyle.REGULAR;
    const itemFontSize = firstItem.fontSize ?? bodyFontSize;
    const isBold =
      itemFontStyle === FontStyle.ITALIC ||
      itemFontStyle === FontStyle.BOLD ||
      itemFontStyle === FontStyle.BOLD_ITALIC;
    const isLarger = itemFontSize > bodyFontSize * 1.05;
    const isAllCapital = firstItem.str === firstItem.str.toUpperCase();

    const trailingPunc = match ? /^[:\.]/.test(match[0].at(-1)) : false;

    if (type === "sectionMark") return true;
    if (type === "figure" || type === "table") {
      if (trailingPunc) return true;
      const isShortCaption = firstItem.str.length < 15;
      return (isBold || isAllCapital) && isShortCaption;
    }
    if (type === "theorem") return isBold || isLarger || trailingPunc;
    if (type === "algorithm") return isBold || isLarger || trailingPunc;
    return isBold || isLarger || isAllCapital || trailingPunc;
  }

  // ============================================
  // Phase 3: Index Native Cross-Reference Links
  // ============================================

  /**
   * Index native PDF annotations that are cross-reference links
   * (i.e., links NOT pointing to reference section)
   */
  #indexNativeLinks() {
    const index = new Map();

    for (const [pageNum, annotations] of this.#nativeAnnotationsByPage) {
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

        // Skip links pointing to reference section
        if (
          destPageIndex + 1 >= this.#refSectionStartPage &&
          destPageIndex + 1 < this.#refSectionEndPage
        )
          continue;

        // Skip links with invalid destinations
        if (destX === 0 && destY === 0) continue;

        const flatRect = rectFromPdfium(rect);
        const key = this.#posKey(pageNum, flatRect.x, flatRect.y);

        index.set(key, {
          pageNumber: pageNum,
          rect: flatRect,
          destPageIndex,
          destX,
          destY,
        });
      }
    }

    return index;
  }

  // ============================================
  // Phase 4: Merge Cross-References
  // ============================================

  /**
   * Merge extracted cross-references with native links.
   * Native destination wins on overlap (more reliable).
   */
  #merge(
    extractedCrossRefs: RawCrossRef[],
    nativeIndex: Map<string, any>,
  ): Map<string, CrossReference> {
    const merged = new Map<string, CrossReference>();

    // Add all extracted cross-references
    for (const crossRef of extractedCrossRefs) {
      if (!crossRef.rects || crossRef.rects.length === 0) continue;

      const rect = crossRef.rects[0];
      const key = this.#posKey(crossRef.pageNumber, rect.x, rect.y);

      const ref: CrossReference = {
        type: crossRef.type,
        text: crossRef.text,
        targetId: crossRef.targetId,
        pageNumber: crossRef.pageNumber,
        rects: crossRef.rects,
        targetLocation: null,
        isDefinition: crossRef.isDefinition,
        flags: CitationFlags.NONE,
      };

      merged.set(key, ref);
    }

    // Check native links for overlaps
    for (const [nativeKey, nativeLink] of nativeIndex) {
      let foundOverlap = false;

      for (const [refKey, crossRef] of merged) {
        if (crossRef.pageNumber !== nativeLink.pageNumber) continue;

        if (this.#overlaps(crossRef.rects, nativeLink.rect)) {
          foundOverlap = true;
          crossRef.flags |= CitationFlags.NATIVE_CONFIRMED;
          crossRef.flags |= CitationFlags.DEST_CONFIRMED;
          crossRef.targetLocation = {
            pageIndex: nativeLink.destPageIndex,
            x: nativeLink.destX,
            y: nativeLink.destY,
          };
          break;
        }
      }
      // Don't create cross-refs from native-only links
      // because we can't determine the type (figure/table/etc.) without text matching
    }

    return merged;
  }

  /**
   * Check if cross-ref rects overlap with a native link rect
   */
  #overlaps(refRects: Rect[], nativeRect: Rect): boolean {
    const tolerance = 5;

    for (const rect of refRects) {
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

  // ============================================
  // Phase 5: Match to Targets
  // ============================================

  /**
   * Match cross-references to their target definitions
   */
  #matchTargets(mergedMap: Map<string, CrossReference>) {
    for (const crossRef of mergedMap.values()) {
      // Skip if already has target from native link
      if (crossRef.targetLocation) continue;

      // Try to find matching target
      const targetKey = `${crossRef.type}-${crossRef.targetId}`;
      const target = this.#targets.get(targetKey);

      if (target) {
        crossRef.targetLocation = {
          pageIndex: target.pageNumber - 1,
          x: target.x,
          y: target.y,
        };
      }
    }
  }

  // ============================================
  // Phase 6: Group by Page
  // ============================================

  /**
   * Organize cross-references by page number
   */
  #groupByPage(
    mergedMap: Map<string, CrossReference>,
  ): Map<number, CrossReference[]> {
    const byPage = new Map<number, CrossReference[]>();

    for (const crossRef of mergedMap.values()) {
      const pageNum = crossRef.pageNumber;

      if (!byPage.has(pageNum)) {
        byPage.set(pageNum, []);
      }

      byPage.get(pageNum).push(crossRef);
    }

    // Sort by position
    for (const [pageNum, crossRefs] of byPage) {
      crossRefs.sort((a, b) => {
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
  #posKey(pageNumber: number, x: number, y: number): string {
    return `${pageNumber}:${Math.round(x)}:${Math.round(y)}`;
  }
}

/** Factory function to create CrossReferenceBuilder. */
export function createCrossReferenceBuilder({
  textIndex,
  nativeAnnotationsByPage,
  referenceIndex,
  outline,
}: {
  textIndex: DocumentTextIndex;
  nativeAnnotationsByPage: Map<number, any[]>;
  referenceIndex: ReferenceIndex;
  outline: OutlineItem[];
}): CrossReferenceBuilder {
  return new CrossReferenceBuilder(
    textIndex,
    nativeAnnotationsByPage,
    referenceIndex,
    outline,
  );
}
