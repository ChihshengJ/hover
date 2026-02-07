/**
 * InlineExtractor - Single-pass page scanner for citations and cross-references
 *
 * This module scans all document pages once and extracts:
 * - Numeric citations: [1], [1,2,3], [1-8]
 * - Author-year citations: Smith (2020), (Smith et al., 2020), (A; B; C)
 * - Superscript citations: detected via font metrics
 * - Cross-references: Figure 1, Table 2, §3, Eq. 4, etc.
 *
 * The extracted data is then used by:
 * - citation_builder.js for merging with native citation links
 * - cross_reference_builder.js for merging with native cross-ref links
 *
 * @typedef {Object} RawCitation
 * @property {string} type - 'numeric' | 'author-year' | 'superscript'
 * @property {string} text - The matched text
 * @property {number} pageNumber - 1-based page number
 * @property {number} charIndex - Character index in full page text
 * @property {number} charCount - Number of characters
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects
 * @property {number[]} refIndices - Expanded reference indices
 * @property {Array<{start: number, end: number}>} refRanges - Original range notation
 * @property {Array<{author: string, year: string, secondAuthor?: string}>|null} refKeys - For author-year
 * @property {number} confidence - 0-1 confidence score
 *
 * @typedef {Object} RawCrossRef
 * @property {string} type - 'figure' | 'table' | 'section' | 'equation' | etc.
 * @property {string} text - The matched text
 * @property {string} targetId - The identifier (e.g., "1", "1a", "A.2")
 * @property {number} pageNumber - 1-based page number
 * @property {number} charIndex - Character index in full page text
 * @property {number} charCount - Number of characters
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects
 *
 * @typedef {Object} ExtractionResult
 * @property {RawCitation[]} citations
 * @property {RawCrossRef[]} crossRefs
 */

import {
  INLINE_CITATION_PATTERNS,
  AUTHOR_YEAR_PATTERNS,
  PARENTHETICAL_CITATION_BLOCK,
  CROSS_REFERENCE_PATTERNS,
  CitationFlags,
  parseNumericCitationContent,
  parseCitationChunk,
  cloneRegex,
  AUTHOR_YEAR_BLOCKS,
} from "./lexicon.js";

class InlineTextAdapter {
  /** @type {import('./text_extractor.js').PdfiumTextExtractor} */
  #extractor = null;
  #docPtr = null;

  /**
   * @param {import('./text_extractor.js').PdfiumTextExtractor} extractor
   * @param {number} docPtr
   */
  constructor(extractor, docPtr) {
    this.#extractor = extractor;
    this.#docPtr = docPtr;
  }

  /**
   * @param {number} pageIndex - 0-based
   * @returns {{fullText: string, charCount: number, pageWidth: number, pageHeight: number}}
   */
  getPageFullText(pageIndex) {
    return this.#extractor.getPageFullText(this.#docPtr, pageIndex);
  }

  /**
   * @param {number} pageIndex - 0-based
   * @param {number} startCharIndex
   * @param {number} charCount
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  getRectsForCharRange(pageIndex, startCharIndex, charCount) {
    return this.#extractor.getRectsForCharRangeOnPage(
      this.#docPtr,
      pageIndex,
      startCharIndex,
      charCount,
    );
  }
}

/**
 * Main inline element extractor
 */
export class InlineExtractor {
  #textExtractor = null;
  #textIndex = null;
  #referenceIndex = null;
  #numPages = 0;

  // Reference signatures for validation
  #signatures = [];

  // Detected citation format from reference section
  #detectedFormat = null;

  // Track matched positions to avoid duplicates
  #matchedRanges = new Map(); // pageNumber -> Set of "start:end" strings

  /**
   * @param {InlineTextExtractor} textExtractor
   * @param {Object} textIndex - DocumentTextIndex instance
   * @param {Object} referenceIndex - Reference index from buildReferenceIndex
   * @param {number} numPages - Total page count
   */
  constructor(textExtractor, textIndex, referenceIndex, numPages) {
    this.#textExtractor = textExtractor;
    this.#textIndex = textIndex;
    this.#referenceIndex = referenceIndex;
    this.#numPages = numPages;
  }

  /**
   * Extract all citations and cross-references from the document
   * Single-pass through all pages
   *
   * @returns {ExtractionResult}
   */
  extract() {
    console.log("[InlineExtractor] Starting extraction...");

    // Build reference signatures for citation validation
    this.#signatures = this.#referenceIndex?.anchors || [];
    console.log(
      `[InlineExtractor] Using ${this.#signatures.length} reference signatures`,
    );

    // Detect citation format from reference section
    this.#detectedFormat = this.#detectCitationFormat();
    console.log(
      `[InlineExtractor] Detected format: ${this.#detectedFormat.type}`,
    );

    const allCitations = [];
    const allCrossRefs = [];

    // Get body line height for superscript detection
    const bodyLineHeight = this.#textIndex?.getBodyLineHeight() || 12;

    // Reference section bounds (to skip scanning there)
    const refSectionStart =
      this.#referenceIndex?.sectionStart?.pageNumber || this.#numPages + 1;

    const refSectionEnd = this.#referenceIndex?.sectionEnd?.pageNumber || -1;

    // Single pass through all pages
    for (let pageNum = 1; pageNum <= this.#numPages; pageNum++) {
      // Reset matched ranges for this page
      this.#matchedRanges.set(pageNum, new Set());

      // Skip pages in reference section for citation extraction
      const isInRefSection =
        pageNum > refSectionStart && pageNum < refSectionEnd;

      const { citations, crossRefs } = this.#scanPage(
        pageNum,
        bodyLineHeight,
        isInRefSection,
      );

      allCitations.push(...citations);
      allCrossRefs.push(...crossRefs);
    }

    console.log(
      `[InlineExtractor] Found ${allCitations.length} citations, ${allCrossRefs.length} cross-references`,
    );

    return {
      citations: allCitations,
      crossRefs: allCrossRefs,
      detectedFormat: this.#detectedFormat,
    };
  }

  /**
   * Check if a character range overlaps with already matched ranges
   * @param {number} pageNumber
   * @param {number} start
   * @param {number} end
   * @returns {boolean}
   */
  #isRangeMatched(pageNumber, start, end) {
    const pageRanges = this.#matchedRanges.get(pageNumber);
    if (!pageRanges) return false;

    for (const rangeStr of pageRanges) {
      const [rStart, rEnd] = rangeStr.split(":").map(Number);
      // Check for overlap
      if (start < rEnd && end > rStart) {
        return true;
      }
    }
    return false;
  }

  /**
   * Mark a character range as matched
   * @param {number} pageNumber
   * @param {number} start
   * @param {number} end
   */
  #markRangeMatched(pageNumber, start, end) {
    const pageRanges = this.#matchedRanges.get(pageNumber);
    if (pageRanges) {
      pageRanges.add(`${start}:${end}`);
    }
  }

  /**
   * Detect citation format from reference section
   */
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

    const bracketPattern = /^\s*\[(\d+)\]\s*/;
    const parenPattern = /^\s*\((\d+)\)\s*/;
    const dotPattern = /^\s*(\d+)\.\s+/;
    const authorYearPattern =
      /^[A-Z][a-z\u00C0-\u00FF]+(?:[,\s]+[A-Z]\.?\s*)+.*?\(?(19|20)\d{2}[a-z]?\)?/;

    for (const text of sampleTexts) {
      if (bracketPattern.test(text)) numberedBracket++;
      else if (parenPattern.test(text)) numberedParen++;
      else if (dotPattern.test(text)) numberedDot++;
      else if (authorYearPattern.test(text)) authorYear++;
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

  /**
   * Scan a single page for citations and cross-references
   */
  #scanPage(pageNumber, bodyLineHeight, isInRefSection) {
    const pageIndex = pageNumber - 1;
    const { fullText, charCount, pageWidth, pageHeight } =
      this.#textExtractor.getPageFullText(pageIndex);

    const citations = [];
    const crossRefs = [];

    if (!fullText || charCount === 0) {
      return { citations, crossRefs };
    }

    // Extract citations only if not in reference section
    if (!isInRefSection) {
      citations.push(
        ...this.#findNumericCitations(fullText, pageNumber, pageIndex),
      );

      // Find author-year citations (order matters for overlap detection)
      // 1. First find large parenthetical blocks and split into individual citations
      citations.push(
        ...this.#findParentheticalBlocks(fullText, pageNumber, pageIndex),
      );

      // 2. Then find individual patterns (skip if overlapping with blocks)
      citations.push(
        ...this.#findAuthorYearCitations(fullText, pageNumber, pageIndex),
      );

      // Check for superscript citations if few others found
      if (citations.length < 2) {
        citations.push(
          ...this.#findSuperscriptCitations(pageNumber, bodyLineHeight),
        );
      }

      // Adjust confidence based on detected format
      this.#adjustConfidenceByFormat(citations);
    }

    // Extract cross-references (can be in any page including references)
    crossRefs.push(...this.#findCrossRefs(fullText, pageNumber, pageIndex));

    return { citations, crossRefs };
  }

  /**
   * Find numeric bracket citations: [1], [1,2,3], [1-8], [17]-[19]
   */
  #findNumericCitations(fullText, pageNumber, pageIndex) {
    const citations = [];

    // First, find inter-bracket ranges like [17]-[19]
    // These must be processed first to avoid partial matches with single brackets
    const interBracketPattern = cloneRegex(
      INLINE_CITATION_PATTERNS.interBracketRange,
    );
    let match;

    while ((match = interBracketPattern.exec(fullText)) !== null) {
      const startNum = parseInt(match[1], 10);
      const endNum = parseInt(match[2], 10);

      // Sanity check: range should be reasonable
      if (startNum >= endNum || endNum - startNum > 30) continue;

      // Expand range to indices
      const indices = [];
      for (let i = startNum; i <= endNum; i++) {
        indices.push(i);
      }

      // Validate against known references
      const validIndices = indices.filter((idx) =>
        this.#signatures.some((anchor) => anchor.index === idx),
      );

      if (validIndices.length === 0) continue;

      const rects = this.#textExtractor.getRectsForCharRange(
        pageIndex,
        match.index,
        match[0].length,
      );

      if (rects.length === 0) continue;

      // Inter-bracket ranges always have RANGE_NOTATION flag
      let flags = CitationFlags.RANGE_NOTATION;
      if (validIndices.length > 1) {
        flags |= CitationFlags.MULTI_REF;
      }

      citations.push({
        type: "numeric",
        text: match[0],
        pageNumber,
        charIndex: match.index,
        charCount: match[0].length,
        rects,
        refIndices: validIndices,
        refRanges: [{ start: startNum, end: endNum }],
        refKeys: null,
        confidence: validIndices.length / indices.length,
        flags,
      });

      // Mark this range as matched
      this.#markRangeMatched(
        pageNumber,
        match.index,
        match.index + match[0].length,
      );
    }

    // Then, find standard bracket citations: [1], [1,2,3], [1-8]
    const pattern = cloneRegex(INLINE_CITATION_PATTERNS.numericBracket);

    while ((match = pattern.exec(fullText)) !== null) {
      // Skip if this range was already matched by inter-bracket pattern
      if (
        this.#isRangeMatched(
          pageNumber,
          match.index,
          match.index + match[0].length,
        )
      ) {
        continue;
      }

      const content = match[1];
      const { indices, ranges } = parseNumericCitationContent(content);

      // Validate against known references
      const validIndices = indices.filter((idx) =>
        this.#signatures.some((anchor) => anchor.index === idx),
      );

      if (validIndices.length === 0) continue;

      const rects = this.#textExtractor.getRectsForCharRange(
        pageIndex,
        match.index,
        match[0].length,
      );

      if (rects.length === 0) continue;

      // Determine flags
      let flags = CitationFlags.NONE;
      if (ranges.length > 0) {
        flags |= CitationFlags.RANGE_NOTATION;
      }
      if (validIndices.length > 1) {
        flags |= CitationFlags.MULTI_REF;
      }

      citations.push({
        type: "numeric",
        text: match[0],
        pageNumber,
        charIndex: match.index,
        charCount: match[0].length,
        rects,
        refIndices: validIndices,
        refRanges: ranges,
        refKeys: null,
        confidence: validIndices.length / indices.length,
        flags,
      });

      // Mark this range as matched
      this.#markRangeMatched(
        pageNumber,
        match.index,
        match.index + match[0].length,
      );
    }

    return citations;
  }

  /**
   * Find superscript citations based on font metrics
   */
  #findSuperscriptCitations(pageNumber, bodyLineHeight) {
    const citations = [];
    const rawSlices = this.#textIndex?.getRawSlices(pageNumber);

    if (!rawSlices) return citations;

    for (const slice of rawSlices) {
      const content = slice.content;

      // Must be pure digits and significantly smaller than body text
      if (
        !INLINE_CITATION_PATTERNS.superscriptDigits.test(content) ||
        slice.rect.size.height >= bodyLineHeight * 0.55
      ) {
        continue;
      }

      const idx = parseInt(content, 10);
      const validAnchor = this.#signatures.find(
        (anchor) => anchor.index === idx,
      );

      if (!validAnchor) continue;

      citations.push({
        type: "superscript",
        text: content,
        pageNumber,
        charIndex: 0, // Not available for slice-based detection
        charCount: content.length,
        rects: [
          {
            x: slice.rect.origin.x,
            y: slice.rect.origin.y,
            width: slice.rect.size.width,
            height: slice.rect.size.height,
          },
        ],
        refIndices: [idx],
        refRanges: [],
        refKeys: null,
        confidence: 0.9,
        flags: CitationFlags.NONE,
      });
    }

    return citations;
  }

  /**
   * Find large parenthetical citation blocks with multiple authors.
   * Each author-year pair in the block becomes a SEPARATE citation object.
   *
   * Examples: (Abutalebi et al., 2008, 2013; de Bruin et al., 2014; ...)
   * This would produce separate citations for each semicolon-separated chunk.
   */
  #findParentheticalBlocks(fullText, pageNumber, pageIndex) {
    const citations = [];
    const pattern = cloneRegex(PARENTHETICAL_CITATION_BLOCK);

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      const blockText = match[0];
      const blockStartIndex = match.index;
      const blockEndIndex = blockStartIndex + blockText.length;

      // Skip if already matched
      if (this.#isRangeMatched(pageNumber, blockStartIndex, blockEndIndex)) {
        continue;
      }

      // Parse individual citation chunks from the block
      const chunkCitations = this.#parseBlockIntoChunks(
        blockText,
        blockStartIndex,
        pageNumber,
        pageIndex,
      );

      if (chunkCitations.length > 0) {
        citations.push(...chunkCitations);
        // Mark the entire block as matched to prevent individual patterns from re-matching
        this.#markRangeMatched(pageNumber, blockStartIndex, blockEndIndex);
      }
    }

    return citations;
  }

  /**
   * Parse a parenthetical block into individual citation chunks.
   * Each chunk (separated by semicolon) becomes its own citation object.
   *
   * @param {string} blockText - The full block text including parentheses
   * @param {number} blockStartIndex - Character index where block starts in page text
   * @param {number} pageNumber - 1-based page number
   * @param {number} pageIndex - 0-based page index
   * @returns {Array} Array of citation objects
   */
  #parseBlockIntoChunks(blockText, blockStartIndex, pageNumber, pageIndex) {
    const citations = [];

    // Remove outer parentheses for inner parsing
    let inner = blockText.trim();
    const hasOpenParen = inner.startsWith("(");
    const hasCloseParen = inner.endsWith(")");

    if (hasOpenParen) inner = inner.slice(1);
    if (hasCloseParen) inner = inner.slice(0, -1);

    // Remove and track prefix phrases
    const prefixPattern = new RegExp(
      `^${AUTHOR_YEAR_BLOCKS.prefixPhrases}`,
      "i",
    );
    const prefixMatch = inner.match(prefixPattern);
    const prefixLength = prefixMatch ? prefixMatch[0].length : 0;
    if (prefixMatch) {
      inner = inner.slice(prefixLength);
    }

    // Calculate offset: opening paren + prefix
    const innerOffset = (hasOpenParen ? 1 : 0) + prefixLength;

    // Split by semicolon and track positions
    const chunks = [];
    let currentPos = 0;
    const parts = inner.split(/\s*;\s*/);

    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      // Find actual position in inner string (accounting for semicolon and spaces)
      const chunkStart = inner.indexOf(chunk, currentPos);
      if (chunkStart === -1) continue;

      chunks.push({
        text: chunk,
        startInInner: chunkStart,
        endInInner: chunkStart + chunk.length,
      });

      currentPos = chunkStart + chunk.length;
    }

    // Process each chunk
    for (const chunk of chunks) {
      const parsed = parseCitationChunk(chunk.text);
      if (!parsed) continue;

      // Validate each year against signatures
      const validRefIndices = [];
      const validRefKeys = [];
      let totalConfidence = 0;

      for (const yearInfo of parsed.years) {
        const matchResult = this.#matchAuthorYearToSignature(
          parsed.firstAuthor,
          yearInfo.year,
          parsed.secondAuthor,
        );

        if (matchResult) {
          validRefIndices.push(matchResult.index);
          validRefKeys.push({
            author: parsed.firstAuthor,
            secondAuthor: parsed.secondAuthor,
            year: yearInfo.year,
            isRange: yearInfo.isRange,
          });
          totalConfidence += matchResult.confidence;
        }
      }

      if (validRefIndices.length === 0) continue;

      // Calculate absolute character position for this chunk
      const chunkAbsStart = blockStartIndex + innerOffset + chunk.startInInner;
      const chunkAbsEnd = blockStartIndex + innerOffset + chunk.endInInner;

      // Get rects for just this chunk
      const rects = this.#textExtractor.getRectsForCharRange(
        pageIndex,
        chunkAbsStart,
        chunk.text.length,
      );

      if (rects.length === 0) continue;

      // Determine flags
      let flags = CitationFlags.NONE;
      if (validRefIndices.length > 1) {
        flags |= CitationFlags.MULTI_REF;
      }
      if (parsed.years.length > 1) {
        flags |= CitationFlags.MULTI_YEAR;
      }

      citations.push({
        type: "author-year",
        text: chunk.text,
        pageNumber,
        charIndex: chunkAbsStart,
        charCount: chunk.text.length,
        rects,
        refIndices: validRefIndices,
        refRanges: [],
        refKeys: validRefKeys,
        confidence: totalConfidence / validRefIndices.length,
        flags,
      });
    }

    return citations;
  }

  /**
   * Find individual author-year citations
   * Handles patterns not caught by parenthetical block detection
   */
  #findAuthorYearCitations(fullText, pageNumber, pageIndex) {
    const citations = [];

    for (const [patternName, patternDef] of Object.entries(
      AUTHOR_YEAR_PATTERNS,
    )) {
      const regex = cloneRegex(patternDef.pattern);

      let match;
      while ((match = regex.exec(fullText)) !== null) {
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;

        // Skip if already matched by parenthetical block or previous pattern
        if (this.#isRangeMatched(pageNumber, startIndex, endIndex)) {
          continue;
        }

        const author = patternDef.extractAuthor(match);
        const secondAuthor = patternDef.isTwoAuthor
          ? patternDef.extractSecondAuthor(match)
          : null;
        const years = patternDef.extractYears(match);

        // Validate each year against signatures
        const validRefIndices = [];
        const validRefKeys = [];
        let totalConfidence = 0;

        for (const yearInfo of years) {
          const matchResult = this.#matchAuthorYearToSignature(
            author,
            yearInfo.year,
            secondAuthor,
          );

          if (matchResult) {
            validRefIndices.push(matchResult.index);
            validRefKeys.push({
              author,
              secondAuthor,
              year: yearInfo.year,
              isRange: yearInfo.isRange,
            });
            totalConfidence += matchResult.confidence;
          }
        }

        if (validRefIndices.length === 0) continue;

        const rects = this.#textExtractor.getRectsForCharRange(
          pageIndex,
          startIndex,
          match[0].length,
        );

        if (rects.length === 0) continue;

        // Determine flags
        let flags = CitationFlags.NONE;
        if (validRefIndices.length > 1) {
          flags |= CitationFlags.MULTI_REF;
        }
        if (years.length > 1) {
          flags |= CitationFlags.MULTI_YEAR;
        }

        citations.push({
          type: "author-year",
          text: match[0],
          pageNumber,
          charIndex: startIndex,
          charCount: match[0].length,
          rects,
          refIndices: validRefIndices,
          refRanges: [],
          refKeys: validRefKeys,
          confidence: totalConfidence / validRefIndices.length,
          flags,
        });

        // Mark this range as matched
        this.#markRangeMatched(pageNumber, startIndex, endIndex);
      }
    }

    return citations;
  }

  /**
   * Match author-year citation to reference signature
   * Enhanced to handle two-author citations and year ranges
   *
   * @param {string} author - First author surname
   * @param {string} year - Year string (may include letter suffix or be a range)
   * @param {string|null} secondAuthor - Second author surname (if two-author citation)
   * @returns {{index: number, confidence: number}|null}
   */
  #matchAuthorYearToSignature(author, year, secondAuthor = null) {
    // Handle year ranges by extracting the start year for matching
    let yearToMatch = year;
    const rangeMatch = year.match(/^(\d{4})\s*[-–—]\s*\d{4}$/);
    if (rangeMatch) {
      yearToMatch = rangeMatch[1];
    }

    const yearBase = yearToMatch.replace(/[a-z]$/, "");
    const authorLower = author.toLowerCase();
    const secondAuthorLower = secondAuthor?.toLowerCase();

    let bestMatch = null;
    let bestConfidence = 0;

    for (const anchor of this.#signatures) {
      // Year must match (base year for ranges/suffixed years)
      if (anchor.year !== yearBase && anchor.year !== yearToMatch) continue;

      let confidence = 0;
      const firstAuthorLower = anchor.firstAuthorLastName?.toLowerCase();

      // First author matching
      if (firstAuthorLower === authorLower) {
        confidence = 1.0;
      } else if (firstAuthorLower?.startsWith(authorLower.slice(0, 4))) {
        confidence = 0.7;
      } else if (
        anchor.allAuthorLastNames?.some((n) => n.toLowerCase() === authorLower)
      ) {
        confidence = 0.6;
      }

      // Boost confidence if second author also matches
      if (secondAuthorLower && confidence > 0) {
        if (
          anchor.allAuthorLastNames?.some(
            (n) => n.toLowerCase() === secondAuthorLower,
          )
        ) {
          confidence = Math.min(1.0, confidence + 0.2);
        }
      }

      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = { index: anchor.index, confidence };
      }
    }

    return bestConfidence > 0.4 ? bestMatch : null;
  }

  /**
   * Find cross-references (Figure, Table, Section, etc.)
   */
  #findCrossRefs(fullText, pageNumber, pageIndex) {
    const crossRefs = [];

    for (const [type, pattern] of Object.entries(CROSS_REFERENCE_PATTERNS)) {
      const regex = cloneRegex(pattern);

      let match;
      while ((match = regex.exec(fullText)) !== null) {
        const rects = this.#textExtractor.getRectsForCharRange(
          pageIndex,
          match.index,
          match[0].length,
        );
        if (rects.length === 0) continue;

        // Extract the target identifier
        // For most patterns, it's in capture group 1
        // For theorem pattern, the number is in group 2
        let targetId;
        if (type === "theorem") {
          targetId = match[2];
        } else {
          targetId = match[1];
        }

        crossRefs.push({
          type,
          text: match[0],
          targetId,
          pageNumber,
          charIndex: match.index,
          charCount: match[0].length,
          rects,
        });
      }
    }

    return crossRefs;
  }

  /**
   * Adjust citation confidence based on dominant format
   */
  #adjustConfidenceByFormat(citations) {
    for (const cit of citations) {
      if (this.#detectedFormat.isAuthorYear && cit.type === "numeric") {
        cit.confidence *= 0.6;
      } else if (
        !this.#detectedFormat.isAuthorYear &&
        cit.type === "author-year"
      ) {
        cit.confidence *= 0.6;
      }
    }
  }
}

/**
 * Factory function to create InlineExtractor
 *
 * @param {import('./doc.js').PDFDocumentModel} doc
 * @returns {InlineExtractor|null}
 */
export function createInlineExtractor(doc) {
  if (!doc.lowLevelHandle) {
    console.warn("[InlineExtractor] Missing lowLevelHandle");
    return null;
  }

  const adapter = new InlineTextAdapter(
    doc.lowLevelHandle.extractor,
    doc.lowLevelHandle.docPtr,
  );

  return new InlineExtractor(
    adapter,
    doc.textIndex,
    doc.referenceIndex,
    doc.numPages,
  );
}
