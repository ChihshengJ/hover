/**
 * CrossReferenceBuilder - Extract targets and merge cross-references
 *
 * This module:
 * 1. Extracts cross-reference targets (Figure 1:, Table 1:, §1, etc.) from pages
 *    using font info and position heuristics to find actual definitions
 * 2. Indexes native PDF links that point to non-reference destinations
 * 3. Merges extracted in-text cross-refs with native links
 * 4. Matches cross-references to their target definitions
 *
 * Output is organized by page for efficient lazy rendering.
 *
 * @typedef {Object} CrossRefTarget
 * @property {string} type - 'figure' | 'table' | 'section' | 'equation' | etc.
 * @property {string} targetId - The identifier (e.g., "1", "1a", "A.2")
 * @property {number} pageNumber - 1-based page number
 * @property {number} x - X coordinate of the target
 * @property {number} y - Y coordinate of the target
 * @property {string} text - The caption/header text
 *
 * @typedef {Object} CrossReference
 * @property {string} type - 'figure' | 'table' | 'section' | 'equation' | etc.
 * @property {string} text - The matched text
 * @property {string} targetId - The identifier
 * @property {number} pageNumber - 1-based page number
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects
 * @property {{pageIndex: number, x: number, y: number}|null} targetLocation
 * @property {number} flags - CitationFlags bitmask
 */

import {
  CROSSREF_DEFINITION_PATTERNS,
  SECTION_MARK_HEADER_PATTERN,
  CitationFlags,
  CrossRefType,
} from "./lexicon.js";
import { FontStyle } from "./text_index.js";

/**
 * Main cross-reference builder class
 */
export class CrossReferenceBuilder {
  #textIndex = null;
  #nativeAnnotationsByPage = null;
  #referenceIndex = null;
  #numPages = 0;

  // Extracted targets (definitions)
  #targets = new Map();

  // Reference section bounds (to identify non-reference links)
  #refSectionStartPage = Infinity;
  #refSectionEndPage = -1;

  /**
   * @param {Object} textIndex - DocumentTextIndex instance
   * @param {Map<number, Array>} nativeAnnotationsByPage - Native annotations by page
   * @param {Object} referenceIndex - Reference index
   * @param {number} numPages - Total page count
   */
  constructor(textIndex, nativeAnnotationsByPage, referenceIndex, numPages) {
    this.#textIndex = textIndex;
    this.#nativeAnnotationsByPage = nativeAnnotationsByPage || new Map();
    this.#referenceIndex = referenceIndex;
    this.#numPages = numPages;
    this.#refSectionStartPage =
      referenceIndex?.sectionStart?.pageNumber || Infinity;
    this.#refSectionEndPage = referenceIndex?.sectionEnd?.pageNumber || -1;
  }

  /**
   * Build merged cross-references from extracted and native sources
   *
   * @param {Array} extractedCrossRefs - Raw cross-refs from InlineExtractor
   * @returns {{
   *   byPage: Map<number, CrossReference[]>,
   *   targets: Map<string, CrossRefTarget>
   * }}
   */
  build(extractedCrossRefs) {
    console.log("[CrossRefBuilder] Starting cross-reference build...");

    // Phase 1: Extract target definitions (Figure 1:, Table 1:, etc.)
    this.#targets = this.#extractTargetDefinitions();
    console.log(`[CrossRefBuilder] Found ${this.#targets.size} targets`);

    // Phase 2: Index native cross-reference links
    const nativeIndex = this.#indexNativeCrossRefLinks();
    console.log(`[CrossRefBuilder] Indexed ${nativeIndex.size} native links`);

    // Phase 3: Merge cross-references
    const mergedMap = this.#mergeCrossRefs(extractedCrossRefs, nativeIndex);
    console.log(`[CrossRefBuilder] Merged into ${mergedMap.size} cross-refs`);

    // Phase 4: Match to target definitions
    this.#matchToTargets(mergedMap);

    // Phase 5: Organize by page
    const byPage = this.#organizeByPage(mergedMap);

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
  // Phase 1: Extract Target Definitions
  // ============================================

  /**
   * Extract figure/table/section definitions from page text
   * Uses font info and position to identify actual captions
   */
  #extractTargetDefinitions() {
    const targets = new Map();
    const bodyFontSize = this.#textIndex?.getBodyFontSize() || 10;
    const bodyFontStyle =
      this.#textIndex?.getBodyFontStyle() || FontStyle.REGULAR;

    for (let pageNum = 1; pageNum <= this.#numPages; pageNum++) {
      const pageData = this.#textIndex?.getPageData(pageNum);
      if (!pageData || !pageData.lines) continue;

      const { lines, pageWidth, pageHeight } = pageData;

      for (const line of lines) {
        // Skip lines that are too short
        if (!line.text || line.text.length < 5) continue;

        // Check each definition pattern
        for (const [type, pattern] of Object.entries(
          CROSSREF_DEFINITION_PATTERNS,
        )) {
          const match = line.text.match(pattern);
          if (!match) continue;

          // For definitions, verify font styling (often bold or different size)
          // or check if it's at a special position (start of paragraph, centered)
          const isValidDefinition = this.#isValidDefinition(
            line,
            type,
            bodyFontSize,
            bodyFontStyle,
            pageWidth,
          );

          if (!isValidDefinition) continue;

          // Extract target ID based on pattern type
          const targetId = type === "theorem" ? match[2] : match[1];
          const fullType = type === "theorem" ? match[1].toLowerCase() : type;

          const key = `${fullType}-${targetId}`;
          if (!targets.has(key)) {
            targets.set(key, {
              type: fullType,
              targetId,
              pageNumber: pageNum,
              x: line.x,
              y: pageHeight - line.y,
              text: line.text,
            });
          }
        }

        // Special handling for § symbol in headers
        const sectionMatch = line.text.match(SECTION_MARK_HEADER_PATTERN);
        if (sectionMatch) {
          const targetId = sectionMatch[1];
          const key = `section-${targetId}`;
          if (!targets.has(key)) {
            targets.set(key, {
              type: "section",
              targetId,
              pageNumber: pageNum,
              x: line.x,
              y: line.y,
              text: line.text,
            });
          }
        }
      }
    }

    return targets;
  }

  /**
   * Validate that a line is a valid figure/table/section definition
   */
  #isValidDefinition(line, type, bodyFontSize, bodyFontStyle, pageWidth) {
    // Check font styling in the first item
    const firstItem = line.items?.[0];
    if (!firstItem) return false;

    const itemFontStyle = firstItem.fontStyle ?? FontStyle.REGULAR;
    const itemFontSize = firstItem.fontSize ?? bodyFontSize;

    // Definitions are often:
    // 1. Bold (captions)
    // 2. Larger than body text (section headers)
    // 3. At line start (not mid-sentence)
    // 4. For figures/tables: often centered or at specific margin

    const isBold =
      itemFontStyle === FontStyle.ITALIC ||
      itemFontStyle === FontStyle.BOLD ||
      itemFontStyle === FontStyle.BOLD_ITALIC;
    const isLarger = itemFontSize > bodyFontSize * 1.05;

    // For section marks with §, accept if at line start
    if (type === "sectionMark") {
      return true; // § at line start is always a definition
    }

    // For figures and tables, check if bold or italicized (common for captions)
    if (type === "figure" || type === "table") {
      // Captions are typically bold or have distinct styling
      // Also accept if the line is short (just "Figure 1:" without long text)
      const isShortCaption = firstItem.str.length < 15;
      return isBold && isShortCaption;
    }

    // For theorems, lemmas, etc., they're typically bold
    if (type === "theorem") {
      return isBold || isLarger;
    }

    // For algorithms, accept bold or larger font
    if (type === "algorithm") {
      return isBold || isLarger;
    }

    return isBold || isLarger;
  }

  // ============================================
  // Phase 2: Index Native Cross-Reference Links
  // ============================================

  /**
   * Index native PDF annotations that are cross-reference links
   * (i.e., links NOT pointing to reference section)
   */
  #indexNativeCrossRefLinks() {
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
          destPageIndex,
          destX,
          destY,
        });
      }
    }

    return index;
  }

  // ============================================
  // Phase 3: Merge Cross-References
  // ============================================

  /**
   * Merge extracted cross-references with native links
   * Native destination wins on overlap (more reliable)
   */
  #mergeCrossRefs(extractedCrossRefs, nativeIndex) {
    const merged = new Map();

    // Add all extracted cross-references
    for (const crossRef of extractedCrossRefs) {
      if (!crossRef.rects || crossRef.rects.length === 0) continue;

      const rect = crossRef.rects[0];
      const key = this.#makePositionKey(crossRef.pageNumber, rect.x, rect.y);

      const ref = {
        type: crossRef.type,
        text: crossRef.text,
        targetId: crossRef.targetId,
        pageNumber: crossRef.pageNumber,
        rects: crossRef.rects,
        targetLocation: null,
        flags: CitationFlags.NONE,
      };

      merged.set(key, ref);
    }

    // Check native links for overlaps
    for (const [nativeKey, nativeLink] of nativeIndex) {
      let foundOverlap = false;

      for (const [refKey, crossRef] of merged) {
        if (crossRef.pageNumber !== nativeLink.pageNumber) continue;

        if (this.#rectsOverlap(crossRef.rects, nativeLink.rect)) {
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
  #rectsOverlap(refRects, nativeRect) {
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
  // Phase 4: Match to Targets
  // ============================================

  /**
   * Match cross-references to their target definitions
   */
  #matchToTargets(mergedMap) {
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
  // Phase 5: Organize by Page
  // ============================================

  /**
   * Organize cross-references by page number
   */
  #organizeByPage(mergedMap) {
    const byPage = new Map();

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
  #makePositionKey(pageNumber, x, y) {
    return `${pageNumber}:${Math.round(x)}:${Math.round(y)}`;
  }
}

/**
 * Factory function to create CrossReferenceBuilder
 *
 * @param {import('./doc.js').PDFDocumentModel} doc
 * @returns {CrossReferenceBuilder}
 */
export function createCrossReferenceBuilder(doc) {
  return new CrossReferenceBuilder(
    doc.textIndex,
    doc.nativeAnnotationsByPage,
    doc.referenceIndex,
    doc.numPages,
  );
}
