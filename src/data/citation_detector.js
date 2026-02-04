/**
 * CitationDetector - Multi-signal fusion approach for robust citation detection
 *
 * Key principles:
 * 1. Reference-first: Build signature database from references before scanning body
 * 2. Full-text matching: Operate on full page text to handle cross-line citations
 * 3. Multi-signal fusion: Combine hyperlinks, patterns, and validation
 * 4. Confidence scoring: Every citation has a confidence score
 *
 * @typedef {Object} CitationMatch
 * @property {string} type - 'numeric' | 'author-year'
 * @property {string} text - The matched text
 * @property {number} pageNumber - 1-based page number
 * @property {number} charIndex - Character index in full page text
 * @property {number} charCount - Number of characters in match
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects - Bounding rects
 * @property {number[]|null} refIndices - Matched reference indices (for numeric)
 * @property {Array<{author: string, year: string}>|null} refKeys - Author-year keys
 * @property {number} confidence - 0-1 confidence score
 * @property {string} source - 'pattern' | 'hyperlink' | 'merged'
 */

import {
  REFERENCE_FORMAT_PATTERNS,
  AUTHOR_YEAR_START_PATTERN,
} from "./lexicon.js";

/**
 * Low-level text and rect extraction for citation detection
 * Extends PdfiumTextExtractor with methods for character-range rect extraction
 */
export class CitationTextExtractor {
  #pdfium = null;
  #docPtr = null;

  /**
   * @param {import('@embedpdf/pdfium').WrappedPdfiumModule} pdfiumModule
   * @param {number} docPtr - Document pointer
   */
  constructor(pdfiumModule, docPtr) {
    this.#pdfium = pdfiumModule;
    this.#docPtr = docPtr;
  }

  /**
   * Extract full text from a page with character indexing preserved
   * @param {number} pageIndex - 0-based page index
   * @returns {{fullText: string, charCount: number, pageWidth: number, pageHeight: number}}
   */
  getPageFullText(pageIndex) {
    const pdfium = this.#pdfium;

    const pagePtr = pdfium.FPDF_LoadPage(this.#docPtr, pageIndex);
    if (!pagePtr) {
      return { fullText: "", charCount: 0, pageWidth: 0, pageHeight: 0 };
    }

    try {
      const pageWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
      const pageHeight = pdfium.FPDF_GetPageHeightF(pagePtr);

      const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) {
        return { fullText: "", charCount: 0, pageWidth, pageHeight };
      }

      try {
        const charCount = pdfium.FPDFText_CountChars(textPagePtr);
        if (charCount <= 0) {
          return { fullText: "", charCount: 0, pageWidth, pageHeight };
        }

        const bufferSize = (charCount + 1) * 2;
        const bufferPtr = pdfium.pdfium.wasmExports.malloc(bufferSize);

        try {
          pdfium.FPDFText_GetText(textPagePtr, 0, charCount, bufferPtr);
          const fullText = pdfium.pdfium.UTF16ToString(bufferPtr);

          return { fullText, charCount, pageWidth, pageHeight };
        } finally {
          pdfium.pdfium.wasmExports.free(bufferPtr);
        }
      } finally {
        pdfium.FPDFText_ClosePage(textPagePtr);
      }
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  /**
   * Get bounding rectangles for a specific character range
   * This is the key method for citation rect extraction
   *
   * @param {number} pageIndex - 0-based page index
   * @param {number} startCharIndex - Starting character index
   * @param {number} charCount - Number of characters
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  getRectsForCharRange(pageIndex, startCharIndex, charCount) {
    const pdfium = this.#pdfium;
    const rects = [];

    const pagePtr = pdfium.FPDF_LoadPage(this.#docPtr, pageIndex);
    if (!pagePtr) return rects;

    try {
      const pageHeight = pdfium.FPDF_GetPageHeightF(pagePtr);
      const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) return rects;

      try {
        // Get count of rectangles for this character range
        const rectCount = pdfium.FPDFText_CountRects(
          textPagePtr,
          startCharIndex,
          charCount,
        );

        if (rectCount <= 0) return rects;

        // Allocate memory for rect coordinates
        const leftPtr = pdfium.pdfium.wasmExports.malloc(8);
        const topPtr = pdfium.pdfium.wasmExports.malloc(8);
        const rightPtr = pdfium.pdfium.wasmExports.malloc(8);
        const bottomPtr = pdfium.pdfium.wasmExports.malloc(8);

        try {
          for (let i = 0; i < rectCount; i++) {
            const success = pdfium.FPDFText_GetRect(
              textPagePtr,
              i,
              leftPtr,
              topPtr,
              rightPtr,
              bottomPtr,
            );

            if (!success) continue;

            const left = pdfium.pdfium.HEAPF64[leftPtr >> 3];
            const top = pdfium.pdfium.HEAPF64[topPtr >> 3];
            const right = pdfium.pdfium.HEAPF64[rightPtr >> 3];
            const bottom = pdfium.pdfium.HEAPF64[bottomPtr >> 3];

            // Convert to top-left origin coordinate system
            rects.push({
              x: left,
              y: pageHeight - top, // Flip Y
              width: right - left,
              height: top - bottom,
            });
          }
        } finally {
          pdfium.pdfium.wasmExports.free(leftPtr);
          pdfium.pdfium.wasmExports.free(topPtr);
          pdfium.pdfium.wasmExports.free(rightPtr);
          pdfium.pdfium.wasmExports.free(bottomPtr);
        }
      } finally {
        pdfium.FPDFText_ClosePage(textPagePtr);
      }
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }

    return rects;
  }
}

/**
 * Main citation detector class
 */
export class CitationDetector {
  #textExtractor = null;
  #referenceIndex = null;
  #nativeAnnotations = null;
  #numPages = 0;

  // Derived data
  #signatures = [];
  #detectedFormat = null;
  #hyperlinkMap = new Map();

  /**
   * @param {CitationTextExtractor} textExtractor
   * @param {Object} referenceIndex - Reference index from buildReferenceIndex
   * @param {Map<number, Array>} nativeAnnotations - Native annotations by page
   * @param {number} numPages - Total page count
   */
  constructor(textExtractor, referenceIndex, nativeAnnotations, numPages) {
    this.#textExtractor = textExtractor;
    this.#referenceIndex = referenceIndex;
    this.#nativeAnnotations = nativeAnnotations || new Map();
    this.#numPages = numPages;
  }

  /**
   * Detect all inline citations in the document
   * @returns {Promise<CitationMatch[]>}
   */
  async detect() {
    console.log("[CitationDetector] Starting detection...");

    // Phase 1: Build reference signatures
    this.#signatures = this.#buildReferenceSignatures();
    console.log(
      `[CitationDetector] Built ${this.#signatures.length} reference signatures`,
    );

    if (this.#signatures.length === 0) {
      console.log("[CitationDetector] No references found, skipping detection");
      return [];
    }

    // Phase 2: Detect citation format from reference section
    this.#detectedFormat = this.#detectCitationFormat();
    console.log(
      `[CitationDetector] Detected format: ${this.#detectedFormat.type} (confidence: ${this.#detectedFormat.confidence.toFixed(2)})`,
    );

    // Phase 3: Index hyperlinks pointing to references
    this.#hyperlinkMap = this.#indexReferenceHyperlinks();
    console.log(
      `[CitationDetector] Indexed ${this.#hyperlinkMap.size} reference hyperlinks`,
    );

    // Phase 4: Scan pages for citations
    const allCitations = [];
    const refStartPage =
      this.#referenceIndex?.sectionStart?.pageNumber || Infinity;

    for (let pageNum = 1; pageNum < refStartPage && pageNum <= this.#numPages; pageNum++) {
      const pageCitations = this.#scanPage(pageNum);
      allCitations.push(...pageCitations);
    }

    console.log(
      `[CitationDetector] Found ${allCitations.length} pattern citations`,
    );

    // Phase 5: Merge with hyperlink citations
    const merged = this.#mergeWithHyperlinks(allCitations);
    console.log(`[CitationDetector] After merge: ${merged.length} citations`);

    // Phase 6: Filter by confidence
    const filtered = merged.filter((c) => c.confidence >= 0.3);
    console.log(
      `[CitationDetector] After filtering: ${filtered.length} citations`,
    );

    return filtered;
  }

  // ========================================
  // Phase 1: Build Reference Signatures
  // ========================================

  #buildReferenceSignatures() {
    return this.#referenceIndex?.anchors || [];
  }

  // ========================================
  // Phase 2: Detect Citation Format
  // ========================================

  #detectCitationFormat() {
    const anchors = this.#referenceIndex?.anchors || [];
    if (anchors.length === 0) {
      return { type: "unknown", confidence: 0, isAuthorYear: false };
    }

    const sampleTexts = anchors.slice(0, 25).map((a) => a.cachedText || "");

    let numberedBracket = 0;
    let numberedParen = 0;
    let numberedDot = 0;
    let authorYear = 0;

    for (const text of sampleTexts) {
      if (REFERENCE_FORMAT_PATTERNS["numbered-bracket"].test(text))
        numberedBracket++;
      else if (REFERENCE_FORMAT_PATTERNS["numbered-paren"].test(text))
        numberedParen++;
      else if (REFERENCE_FORMAT_PATTERNS["numbered-dot"].test(text))
        numberedDot++;
      else if (AUTHOR_YEAR_START_PATTERN.test(text)) authorYear++;
    }

    const total = sampleTexts.length;
    const formats = [
      { type: "numbered-bracket", count: numberedBracket, isAuthorYear: false },
      { type: "numbered-paren", count: numberedParen, isAuthorYear: false },
      { type: "numbered-dot", count: numberedDot, isAuthorYear: false },
      { type: "author-year", count: authorYear, isAuthorYear: true },
    ];

    formats.sort((a, b) => b.count - a.count);
    const best = formats[0];

    return {
      type: best.type,
      confidence: total > 0 ? best.count / total : 0,
      isAuthorYear: best.isAuthorYear,
    };
  }

  // ========================================
  // Phase 3: Index Reference Hyperlinks
  // ========================================

  #indexReferenceHyperlinks() {
    const map = new Map();
    const refSection = this.#referenceIndex?.sectionStart;
    if (!refSection) return map;

    const refStartPage = refSection.pageNumber;

    for (const [pageNum, annotations] of this.#nativeAnnotations) {
      if (pageNum >= refStartPage) continue;

      for (const annot of annotations) {
        if (annot.target?.type !== "destination") continue;

        const dest = annot.target.destination;
        if (!dest) continue;

        const destPageIndex = dest.pageIndex ?? -1;
        const destY = dest.view?.[1] ?? 0;

        // Check if link points to reference section
        if (destPageIndex + 1 >= refStartPage) {
          const matchedSig = this.#findSignatureAtLocation(
            destPageIndex + 1,
            destY,
          );

          if (matchedSig) {
            const key = `${pageNum}:${Math.round(annot.rect?.origin?.x || 0)}:${Math.round(annot.rect?.origin?.y || 0)}`;
            map.set(key, {
              pageNumber: pageNum,
              rect: annot.rect,
              refIndex: matchedSig.index,
              confidence: 0.9,
            });
          }
        }
      }
    }

    return map;
  }

  #findSignatureAtLocation(pageNumber, y) {
    let best = null;
    let bestDist = Infinity;

    for (const anchor of this.#signatures) {
      if (anchor.pageNumber !== pageNumber) continue;

      const dist = Math.abs(anchor.startCoord.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = anchor;
      }
    }

    return bestDist < 50 ? best : null;
  }

  // ========================================
  // Phase 4: Scan Pages for Citations
  // ========================================

  #scanPage(pageNumber) {
    const pageIndex = pageNumber - 1;
    const { fullText, charCount, pageWidth, pageHeight } =
      this.#textExtractor.getPageFullText(pageIndex);

    if (!fullText || charCount === 0) return [];

    const citations = [];

    // Always scan for numeric citations
    citations.push(
      ...this.#findNumericCitations(fullText, pageNumber, pageIndex),
    );

    // Always scan for author-year citations
    citations.push(
      ...this.#findAuthorYearCitations(fullText, pageNumber, pageIndex),
    );

    // Adjust confidence based on detected format
    for (const cit of citations) {
      if (this.#detectedFormat.isAuthorYear && cit.type === "numeric") {
        cit.confidence *= 0.6; // Lower confidence for non-dominant format
      } else if (!this.#detectedFormat.isAuthorYear && cit.type === "author-year") {
        cit.confidence *= 0.6;
      }
    }

    return citations;
  }

  #findNumericCitations(fullText, pageNumber, pageIndex) {
    const citations = [];

    // Pattern: [1] or [1,2,3] or [1-5]
    const bracketPattern =
      /\[(\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*)\]/g;

    let match;
    while ((match = bracketPattern.exec(fullText)) !== null) {
      const refIndices = this.#parseNumericIndices(match[1]);

      // Validate against known references
      const validIndices = refIndices.filter((idx) =>
        this.#signatures.some((anchor) => anchor.index === idx)
      );
      if (validIndices.length === 0) continue;

      const rects = this.#textExtractor.getRectsForCharRange(
        pageIndex,
        match.index,
        match[0].length,
      );

      if (rects.length === 0) continue;

      citations.push({
        type: "numeric",
        text: match[0],
        pageNumber,
        charIndex: match.index,
        charCount: match[0].length,
        rects,
        refIndices: validIndices,
        refKeys: null,
        confidence: validIndices.length / refIndices.length,
        source: "pattern",
      });
    }

    return citations;
  }

  #findAuthorYearCitations(fullText, pageNumber, pageIndex) {
    const citations = [];

    const patterns = [
      // Smith (2020) or Smith et al. (2020)
      {
        regex: /(\p{Lu}[\p{L}\p{M}]+(?:\s+et\s+al\.?)?),?\s*\((\d{4}[a-z]?)\)/gu,
        extractAuthor: (m) => m[1].replace(/\s+et\s+al\.?/i, "").trim(),
        extractYear: (m) => m[2],
      },
      // (Smith, 2020) or (Smith et al., 2020)
      {
        regex: /\((\p{Lu}[\p{L}\p{M}]+(?:\s+et\s+al\.?)?)\s*,?\s*(\d{4}[a-z]?)\)/gu,
        extractAuthor: (m) => m[1].replace(/\s+et\s+al\.?/i, "").trim(),
        extractYear: (m) => m[2],
      },
      // (Smith and Jones, 2020)
      {
        regex: /\((\p{Lu}[\p{L}\p{M}]+)\s+(?:and|&|&amp;|＆)\s+(\p{Lu}[\p{L}\p{M}]+)\s*,?\s*(\d{4}[a-z]?)\)/gu,
        extractAuthor: (m) => m[1],
        extractYear: (m) => m[3],
      },
    ];

    for (const { regex, extractAuthor, extractYear } of patterns) {
      const re = new RegExp(regex.source, regex.flags);
      let match;

      while ((match = re.exec(fullText)) !== null) {
        const author = extractAuthor(match);
        const year = extractYear(match);

        // Validate against signatures
        const matchResult = this.#matchAuthorYearToSignature(author, year);

        if (!matchResult) continue;

        const rects = this.#textExtractor.getRectsForCharRange(
          pageIndex,
          match.index,
          match[0].length,
        );

        if (rects.length === 0) continue;

        citations.push({
          type: "author-year",
          text: match[0],
          pageNumber,
          charIndex: match.index,
          charCount: match[0].length,
          rects,
          refIndices: [matchResult.index],
          refKeys: [{ author, year }],
          confidence: matchResult.confidence,
          source: "pattern",
        });
      }
    }

    return citations;
  }

  #parseNumericIndices(str) {
    const indices = [];
    const parts = str.split(/[,;]/);

    for (const part of parts) {
      const trimmed = part.trim();
      const rangeMatch = trimmed.match(/(\d+)\s*[-–—]\s*(\d+)/);

      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        // Sanity limit: max 30 refs in a range
        for (let i = start; i <= Math.min(end, start + 30); i++) {
          indices.push(i);
        }
      } else {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num > 0 && num < 1000) {
          indices.push(num);
        }
      }
    }

    return indices;
  }

  #matchAuthorYearToSignature(author, year) {
    const yearBase = year.replace(/[a-z]$/, "");
    const authorLower = author.toLowerCase();

    let bestMatch = null;
    let bestConfidence = 0;

    for (const anchor of this.#signatures) {
      // Year must match
      if (anchor.year !== yearBase && anchor.year !== year) continue;

      let confidence = 0;
      const firstAuthorLower = anchor.firstAuthorLastName?.toLowerCase();

      if (firstAuthorLower === authorLower) {
        confidence = 1.0;
      } else if (firstAuthorLower?.startsWith(authorLower.slice(0, 4))) {
        confidence = 0.7;
      } else if (
        anchor.allAuthorLastNames?.some((n) => n.toLowerCase() === authorLower)
      ) {
        confidence = 0.6;
      }

      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = { index: anchor.index, confidence };
      }
    }

    return bestConfidence > 0.4 ? bestMatch : null;
  }


  // ========================================
  // Phase 5: Merge with Hyperlinks
  // ========================================

  #mergeWithHyperlinks(patternCitations) {
    const merged = new Map();

    // Add pattern citations
    for (const cit of patternCitations) {
      const key = this.#makeCitationKey(cit);
      const existing = merged.get(key);

      if (!existing || existing.confidence < cit.confidence) {
        merged.set(key, cit);
      }
    }

    // Check for hyperlink confirmations and add hyperlink-only citations
    for (const [linkKey, linkData] of this.#hyperlinkMap) {
      const linkRect = linkData.rect;
      if (!linkRect) continue;

      // Try to find matching pattern citation
      let foundMatch = false;

      for (const [citKey, cit] of merged) {
        if (cit.pageNumber !== linkData.pageNumber) continue;

        // Check if rects overlap
        if (this.#rectsOverlap(cit.rects, linkRect)) {
          // Boost confidence if they agree on reference
          if (cit.refIndices?.includes(linkData.refIndex)) {
            cit.confidence = Math.min(1.0, cit.confidence + 0.25);
            cit.hasHyperlinkConfirmation = true;
          }
          foundMatch = true;
          break;
        }
      }

      // If no pattern match, create citation from hyperlink
      if (!foundMatch) {
        const cit = {
          type: "numeric",
          text: `[${linkData.refIndex}]`,
          pageNumber: linkData.pageNumber,
          charIndex: -1,
          charCount: 0,
          rects: [
            {
              x: linkRect.origin?.x || 0,
              y: linkRect.origin?.y || 0,
              width: linkRect.size?.width || 0,
              height: linkRect.size?.height || 0,
            },
          ],
          refIndices: [linkData.refIndex],
          refKeys: null,
          confidence: linkData.confidence,
          source: "hyperlink",
        };

        merged.set(linkKey, cit);
      }
    }

    return Array.from(merged.values());
  }

  #makeCitationKey(cit) {
    const rect = cit.rects[0];
    return `${cit.pageNumber}:${Math.round(rect?.x || 0)}:${Math.round(rect?.y || 0)}`;
  }

  #rectsOverlap(rects, linkRect) {
    const linkX = linkRect.origin?.x || 0;
    const linkY = linkRect.origin?.y || 0;
    const linkW = linkRect.size?.width || 0;
    const linkH = linkRect.size?.height || 0;

    for (const rect of rects) {
      // Check for overlap with some tolerance
      const tolerance = 5;
      const overlapX =
        rect.x < linkX + linkW + tolerance &&
        rect.x + rect.width > linkX - tolerance;
      const overlapY =
        rect.y < linkY + linkH + tolerance &&
        rect.y + rect.height > linkY - tolerance;

      if (overlapX && overlapY) return true;
    }

    return false;
  }
}

/**
 * Factory function to create citation detector with proper dependencies
 *
 * @param {import('./doc.js').PDFDocumentModel} doc
 * @returns {CitationDetector|null}
 */
export function createCitationDetector(doc) {
  if (!doc.lowLevelHandle || !doc.referenceIndex) {
    console.warn(
      "[CitationDetector] Missing lowLevelHandle or referenceIndex",
    );
    return null;
  }

  const pdfium = doc.lowLevelHandle.pdfium;
  const docPtr = doc.lowLevelHandle.docPtr;

  const textExtractor = new CitationTextExtractor(pdfium, docPtr);

  return new CitationDetector(
    textExtractor,
    doc.referenceIndex,
    doc.nativeAnnotationsByPage,
    doc.numPages,
  );
}
