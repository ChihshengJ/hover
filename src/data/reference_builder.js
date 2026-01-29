/**
 * ReferenceBuilder - Extracts and indexes references from academic PDFs
 *
 * Provides:
 * 1. Reference section detection (start/end boundaries)
 * 2. Reference format detection (numbered, author-year, etc.)
 * 3. Individual reference anchor extraction with coordinates
 * 4. Inline citation pattern detection for fallback linking
 *
 * @typedef {Object} ReferenceAnchor
 * @property {string} id - Unique identifier (e.g., 'ref-1', 'ref-smith-2020')
 * @property {number|null} index - Numeric index if numbered format
 * @property {number} pageNumber - 1-based page number
 * @property {{x: number, y: number}} startCoord - Start position in PDF coordinates
 * @property {{x: number, y: number}} endCoord - End position in PDF coordinates
 * @property {number} confidence - 0-1 confidence score
 * @property {string} formatHint - 'numbered-bracket'|'numbered-dot'|'hanging-indent'|'author-year'|'unknown'
 * @property {string|null} cachedText - Pre-extracted text for high-confidence entries
 * @property {string|null} authors - Parsed author string (best-effort)
 * @property {string|null} year - Parsed year (best-effort)
 * @property {Array<{pageNumber: number, rects: Array<{x: number, y: number, width: number, height: number}>}>} pageRanges
 *
 * @typedef {Object} ReferenceIndex
 * @property {ReferenceAnchor[]} anchors - All extracted reference anchors
 * @property {string} format - Detected format type
 * @property {number} sectionConfidence - Overall confidence in section detection
 * @property {{pageNumber: number, lineIndex: number, y: number}|null} sectionStart
 * @property {{pageNumber: number, lineIndex: number, y: number}|null} sectionEnd
 *
 * @typedef {Object} InlineCitation
 * @property {string} type - 'numeric'|'author-year'
 * @property {string} text - The citation text as it appears
 * @property {number} pageNumber - 1-based page number
 * @property {{x: number, y: number, width: number, height: number}} rect - Position
 * @property {number[]|null} refIndices - Referenced indices (for numeric)
 * @property {{author: string, year: string}[]|null} refKeys - Author-year keys
 */

import { getDocInfo } from "./outline_builder.js";
import {
  REFERENCE_SECTION_PATTERN,
  POST_REFERENCE_SECTION_PATTERN,
  REFERENCE_FORMAT_PATTERNS,
  AUTHOR_YEAR_START_PATTERN,
  YEAR_PATTERN,
  CROSS_REFERENCE_PATTERNS,
  NAME_SUFFIXES,
  LAST_NAME_PATTERNS,
  MIN_REFERENCE_LENGTH,
  MAX_REFERENCE_LENGTH,
  REFERENCE_ENDING_PATTERNS,
  SECTION_NUMBER_STRIP,
} from "./lexicon.js";

// ============================================
// Main Entry Point
// ============================================

/**
 * Build complete reference index from search index
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {Promise<ReferenceIndex>}
 */
export async function buildReferenceIndex(searchIndex) {
  const emptyResult = {
    anchors: [],
    format: "unknown",
    sectionConfidence: 0,
    sectionStart: null,
    sectionEnd: null,
  };

  if (!searchIndex?.isBuilt) {
    console.warn(
      "[References] Search index not built, cannot extract references",
    );
    return emptyResult;
  }

  try {
    // Phase 1: Find reference section boundaries
    const section = findReferenceSection(searchIndex);
    if (!section) {
      console.log("[References] No reference section found");
      return emptyResult;
    }

    console.log(
      `[References] Found section: pages ${section.startPage}-${section.endPage}, confidence=${section.confidence.toFixed(2)}`,
    );

    // Phase 2: Detect format from first few entries
    const format = detectReferenceFormat(section.lines);
    console.log(`[References] Detected format: ${format}`);

    // Phase 3: Extract reference anchors
    const anchors = extractReferenceAnchors(section, format, searchIndex);
    console.log(`[References] Extracted ${anchors.length} reference anchors`);

    // Phase 4: Cache text for high-confidence entries
    for (const anchor of anchors) {
      if (anchor.confidence > 0.8) {
        anchor.cachedText = extractTextForAnchor(anchor, section);
        // Parse author/year for matching
        const parsed = parseAuthorYear(anchor.cachedText);
        anchor.authors = parsed.authors;
        anchor.year = parsed.year;
      }
    }

    return {
      anchors,
      format,
      sectionConfidence: section.confidence,
      sectionStart: {
        pageNumber: section.startPage,
        lineIndex: section.startLineIndex,
        y: section.startY,
      },
      sectionEnd: {
        pageNumber: section.endPage,
        lineIndex: section.endLineIndex,
        y: section.endY,
      },
    };
  } catch (error) {
    console.error("[References] Error building reference index:", error);
    return emptyResult;
  }
}

// ============================================
// Reference Section Detection
// ============================================

/**
 * Find the reference section boundaries in the document
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {{
 *   startPage: number,
 *   endPage: number,
 *   startLineIndex: number,
 *   endLineIndex: number,
 *   startY: number,
 *   endY: number,
 *   lines: Array,
 *   confidence: number
 * }|null}
 */
function findReferenceSection(searchIndex) {
  const docInfo = getDocInfo(searchIndex);
  if (!docInfo || !docInfo.pageData) return null;

  const { pageData, fontSize: bodyFontSize } = docInfo;

  let referenceStart = null;

  // First pass: find reference section heading
  // Start from page 3+ (references are never on first pages)
  for (const [pageNum, data] of pageData) {
    if (pageNum <= 2) continue;

    const { allLines } = data;

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      const strippedText = line.text.replace(SECTION_NUMBER_STRIP, "").trim();

      if (REFERENCE_SECTION_PATTERN.test(strippedText)) {
        // Check for font differentiation (heading-like)
        const isLarger = line.fontSize > bodyFontSize * 1.05;
        const isBold = isBoldFont(line.fontName);
        const isAtColumnStart = line.isAtColumnStart === true;

        // Prefer last occurrence (some papers mention "References" in intro)
        if (isLarger || isBold || isAtColumnStart) {
          referenceStart = {
            pageNumber: pageNum,
            lineIndex: i,
            y: line.y,
            originalY: line.originalY,
            line: line,
          };
        }
      }
    }
  }

  if (!referenceStart) return null;

  // Second pass: find end of reference section
  const referenceEnd = findReferenceSectionEnd(
    pageData,
    referenceStart,
    bodyFontSize,
  );

  // Collect all lines in the reference section
  const lines = collectSectionLines(pageData, referenceStart, referenceEnd);

  // Calculate confidence
  const confidence = calculateSectionConfidence(
    referenceStart,
    referenceEnd,
    lines,
  );

  return {
    startPage: referenceStart.pageNumber,
    endPage: referenceEnd.pageNumber,
    startLineIndex: referenceStart.lineIndex,
    endLineIndex: referenceEnd.lineIndex,
    startY: referenceStart.y,
    endY: referenceEnd.y,
    lines,
    confidence,
  };
}

/**
 * Find where the reference section ends
 * @param {Map} pageData
 * @param {Object} start
 * @param {number} bodyFontSize
 * @returns {Object}
 */
function findReferenceSectionEnd(pageData, start, bodyFontSize) {
  let lastValidLine = null;

  const pageNumbers = Array.from(pageData.keys()).sort((a, b) => a - b);

  for (const pageNum of pageNumbers) {
    if (pageNum < start.pageNumber) continue;

    const { allLines } = pageData.get(pageNum);
    const startIdx = pageNum === start.pageNumber ? start.lineIndex + 1 : 0;

    for (let i = startIdx; i < allLines.length; i++) {
      const line = allLines[i];
      const strippedText = line.text.replace(SECTION_NUMBER_STRIP, "").trim();

      // Check for post-reference section heading
      if (POST_REFERENCE_SECTION_PATTERN.test(strippedText)) {
        const isLarger = line.fontSize > bodyFontSize * 1.05;
        const isBold = isBoldFont(line.fontName);

        if (isLarger || isBold) {
          return {
            pageNumber: pageNum,
            lineIndex: i - 1,
            y: lastValidLine?.y || line.y,
          };
        }
      }

      // Track last valid line (non-empty)
      if (line.text.trim().length > 0) {
        lastValidLine = { pageNumber: pageNum, lineIndex: i, y: line.y };
      }
    }
  }

  // No post-section found - use end of document
  return (
    lastValidLine || {
      pageNumber: start.pageNumber,
      lineIndex: start.lineIndex + 1,
      y: start.y,
    }
  );
}

/**
 * Collect all lines within the reference section
 * @param {Map} pageData
 * @param {Object} start
 * @param {Object} end
 * @returns {Array}
 */
function collectSectionLines(pageData, start, end) {
  const lines = [];
  const pageNumbers = Array.from(pageData.keys()).sort((a, b) => a - b);

  for (const pageNum of pageNumbers) {
    if (pageNum < start.pageNumber || pageNum > end.pageNumber) continue;

    const { allLines, columnData } = pageData.get(pageNum);

    let startIdx = 0;
    let endIdx = allLines.length - 1;

    if (pageNum === start.pageNumber) {
      startIdx = start.lineIndex + 1; // Skip the heading itself
    }
    if (pageNum === end.pageNumber) {
      endIdx = end.lineIndex;
    }

    for (let i = startIdx; i <= endIdx && i < allLines.length; i++) {
      const line = allLines[i];
      lines.push({
        ...line,
        pageNumber: pageNum,
        lineIndex: i,
        pageWidth: columnData.pageWidth,
        pageHeight: columnData.pageHeight,
        columns: columnData.columns,
      });
    }
  }

  return lines;
}

/**
 * Calculate confidence score for the detected section
 * @param {Object} start
 * @param {Object} end
 * @param {Array} lines
 * @returns {number}
 */
function calculateSectionConfidence(start, end, lines) {
  let confidence = 0.5;

  // Has reasonable number of lines
  if (lines.length >= 5 && lines.length <= 500) {
    confidence += 0.2;
  } else if (lines.length < 5) {
    confidence -= 0.2;
  }

  // Section spans reasonable amount of document
  const pageSpan = end.pageNumber - start.pageNumber + 1;
  if (pageSpan >= 1 && pageSpan <= 10) {
    confidence += 0.1;
  }

  // Check for reference-like content patterns
  const hasNumberedRefs = lines.some((l) =>
    Object.values(REFERENCE_FORMAT_PATTERNS).some((p) => p.test(l.text)),
  );
  const hasYears =
    lines.filter((l) => YEAR_PATTERN.test(l.text)).length > lines.length * 0.3;

  if (hasNumberedRefs) confidence += 0.15;
  if (hasYears) confidence += 0.1;

  return Math.max(0, Math.min(1, confidence));
}

// ============================================
// Reference Format Detection
// ============================================

/**
 * Detect the format used in the reference section
 * @param {Array} lines - Lines from the reference section
 * @returns {string} Format identifier
 */
function detectReferenceFormat(lines) {
  if (lines.length === 0) return "unknown";

  // Sample first 20 non-empty lines for format detection
  const sampleLines = lines
    .filter((l) => l.text.trim().length > 10)
    .slice(0, 20);

  if (sampleLines.length === 0) return "unknown";

  // Count matches for each numbered format
  const formatCounts = {};
  for (const [formatName, pattern] of Object.entries(
    REFERENCE_FORMAT_PATTERNS,
  )) {
    formatCounts[formatName] = sampleLines.filter((l) =>
      pattern.test(l.text),
    ).length;
  }

  // Find best numbered format
  const bestNumbered = Object.entries(formatCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];

  if (bestNumbered && bestNumbered[1] >= sampleLines.length * 0.3) {
    return bestNumbered[0];
  }

  // Check for author-year format
  const authorYearCount = sampleLines.filter((l) =>
    AUTHOR_YEAR_START_PATTERN.test(l.text),
  ).length;

  if (authorYearCount >= sampleLines.length * 0.3) {
    return "author-year";
  }

  // Check for hanging indent
  if (detectHangingIndent(sampleLines)) {
    return "hanging-indent";
  }

  return "unknown";
}

/**
 * Detect hanging indent format (first line at margin, continuation indented)
 * @param {Array} lines
 * @returns {boolean}
 */
function detectHangingIndent(lines) {
  if (lines.length < 4) return false;

  // Get typical column start position
  const columnStarts = lines.filter((l) => l.isAtColumnStart).map((l) => l.x);

  if (columnStarts.length === 0) return false;

  const marginX = Math.min(...columnStarts);

  // Look for pattern: margin line followed by indented lines
  let hangingPatterns = 0;
  let i = 0;

  while (i < lines.length - 1) {
    const line = lines[i];
    const isAtMargin = Math.abs(line.x - marginX) < 5;

    if (isAtMargin) {
      // Check if next line(s) are indented
      let j = i + 1;
      while (
        j < lines.length &&
        Math.abs(lines[j].y - lines[j - 1].y) < lines[j - 1].fontSize * 2
      ) {
        if (lines[j].x > marginX + 10) {
          hangingPatterns++;
          break;
        }
        j++;
      }
    }
    i++;
  }

  return hangingPatterns >= 3;
}

// ============================================
// Reference Anchor Extraction
// ============================================

/**
 * Extract individual reference anchors from section
 * @param {Object} section - Reference section data
 * @param {string} format - Detected format
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {ReferenceAnchor[]}
 */
function extractReferenceAnchors(section, format, searchIndex) {
  const { lines } = section;

  if (lines.length === 0) return [];

  switch (format) {
    case "numbered-bracket":
    case "numbered-paren":
    case "numbered-dot":
    case "numbered-plain":
      return extractNumberedReferences(lines, format);

    case "author-year":
      return extractAuthorYearReferences(lines);

    case "hanging-indent":
      return extractHangingIndentReferences(lines);

    default:
      return extractFallbackReferences(lines);
  }
}

/**
 * Extract references with numbered format
 * @param {Array} lines
 * @param {string} format
 * @returns {ReferenceAnchor[]}
 */
function extractNumberedReferences(lines, format) {
  const pattern = REFERENCE_FORMAT_PATTERNS[format];
  if (!pattern) return [];

  const anchors = [];
  let currentAnchor = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.text.match(pattern);

    if (match) {
      // Save previous anchor
      if (currentAnchor && currentLines.length > 0) {
        finalizeAnchor(currentAnchor, currentLines, format);
        anchors.push(currentAnchor);
      }

      // Start new anchor
      const refIndex = parseInt(match[1], 10);
      currentAnchor = {
        id: `ref-${refIndex}`,
        index: refIndex,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.originalY || line.y },
        endCoord: null,
        confidence: 0.7, // Base confidence for numbered
        formatHint: format,
        cachedText: null,
        authors: null,
        year: null,
        pageRanges: [],
      };
      currentLines = [line];
    } else if (currentAnchor) {
      // Continuation of current reference
      currentLines.push(line);
    }
  }

  // Don't forget last anchor
  if (currentAnchor && currentLines.length > 0) {
    finalizeAnchor(currentAnchor, currentLines, format);
    anchors.push(currentAnchor);
  }

  return anchors;
}

/**
 * Extract references with author-year format
 * @param {Array} lines
 * @returns {ReferenceAnchor[]}
 */
function extractAuthorYearReferences(lines) {
  const anchors = [];
  let currentAnchor = null;
  let currentLines = [];

  // Get margin position for column start detection
  const marginXValues = lines.filter((l) => l.isAtColumnStart).map((l) => l.x);
  const marginX = marginXValues.length > 0 ? Math.min(...marginXValues) : 0;
  const tolerance = 5;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isAtMargin = Math.abs(line.x - marginX) < tolerance;
    const startsWithAuthor = AUTHOR_YEAR_START_PATTERN.test(line.text);
    const previousEndsWithPeriod = i > 0 && /\.\s*$/.test(lines[i - 1].text);

    // New reference starts when: at margin AND (starts with author pattern OR previous ended with period)
    const isNewEntry =
      isAtMargin &&
      (startsWithAuthor ||
        (previousEndsWithPeriod && /^[A-Z]/.test(line.text)));

    if (isNewEntry && currentLines.length > 0) {
      // Save previous anchor
      if (currentAnchor) {
        finalizeAnchor(currentAnchor, currentLines, "author-year");
        anchors.push(currentAnchor);
      }

      // Start new anchor
      const parsed = parseAuthorYear(line.text);
      currentAnchor = {
        id: `ref-${parsed.authors?.split(/[,\s]/)[0]?.toLowerCase() || "unknown"}-${parsed.year || i}`,
        index: null,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.originalY || line.y },
        endCoord: null,
        confidence: startsWithAuthor ? 0.65 : 0.5,
        formatHint: "author-year",
        cachedText: null,
        authors: parsed.authors,
        year: parsed.year,
        pageRanges: [],
      };
      currentLines = [line];
    } else if (currentAnchor) {
      currentLines.push(line);
    } else {
      // First entry
      const parsed = parseAuthorYear(line.text);
      currentAnchor = {
        id: `ref-${parsed.authors?.split(/[,\s]/)[0]?.toLowerCase() || "unknown"}-${parsed.year || 0}`,
        index: null,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.originalY || line.y },
        endCoord: null,
        confidence: 0.5,
        formatHint: "author-year",
        cachedText: null,
        authors: parsed.authors,
        year: parsed.year,
        pageRanges: [],
      };
      currentLines = [line];
    }
  }

  if (currentAnchor && currentLines.length > 0) {
    finalizeAnchor(currentAnchor, currentLines, "author-year");
    anchors.push(currentAnchor);
  }

  return anchors;
}

/**
 * Extract references with hanging indent format
 * @param {Array} lines
 * @returns {ReferenceAnchor[]}
 */
function extractHangingIndentReferences(lines) {
  const anchors = [];
  let currentAnchor = null;
  let currentLines = [];

  const marginXValues = lines.filter((l) => l.isAtColumnStart).map((l) => l.x);
  const marginX = marginXValues.length > 0 ? Math.min(...marginXValues) : 0;
  const tolerance = 5;
  let refIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isAtMargin = Math.abs(line.x - marginX) < tolerance;

    if (isAtMargin) {
      // Save previous
      if (currentAnchor && currentLines.length > 0) {
        finalizeAnchor(currentAnchor, currentLines, "hanging-indent");
        anchors.push(currentAnchor);
      }

      refIndex++;
      const parsed = parseAuthorYear(line.text);
      currentAnchor = {
        id: `ref-${refIndex}`,
        index: refIndex,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.originalY || line.y },
        endCoord: null,
        confidence: 0.55,
        formatHint: "hanging-indent",
        cachedText: null,
        authors: parsed.authors,
        year: parsed.year,
        pageRanges: [],
      };
      currentLines = [line];
    } else if (currentAnchor) {
      currentLines.push(line);
    }
  }

  if (currentAnchor && currentLines.length > 0) {
    finalizeAnchor(currentAnchor, currentLines, "hanging-indent");
    anchors.push(currentAnchor);
  }

  return anchors;
}

/**
 * Fallback extraction - split by blank lines or large gaps
 * @param {Array} lines
 * @returns {ReferenceAnchor[]}
 */
function extractFallbackReferences(lines) {
  const anchors = [];
  let currentLines = [];
  let refIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = lines[i - 1];

    // Check for gap between lines
    const hasGap =
      prevLine &&
      (line.pageNumber !== prevLine.pageNumber ||
        Math.abs(line.y - prevLine.y) > prevLine.fontSize * 2.5);

    if (hasGap && currentLines.length > 0) {
      refIndex++;
      const anchor = createBasicAnchor(currentLines, refIndex);
      anchors.push(anchor);
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    refIndex++;
    anchors.push(createBasicAnchor(currentLines, refIndex));
  }

  return anchors;
}

/**
 * Create a basic anchor from lines (for fallback)
 * @param {Array} lines
 * @param {number} index
 * @returns {ReferenceAnchor}
 */
function createBasicAnchor(lines, index) {
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const text = lines.map((l) => l.text).join(" ");
  const parsed = parseAuthorYear(text);

  return {
    id: `ref-${index}`,
    index: index,
    pageNumber: firstLine.pageNumber,
    startCoord: { x: firstLine.x, y: firstLine.originalY || firstLine.y },
    endCoord: {
      x:
        lastLine.x +
        (lastLine.items?.[lastLine.items.length - 1]?.width || 100),
      y: lastLine.originalY || lastLine.y,
    },
    confidence: 0.4,
    formatHint: "unknown",
    cachedText: text,
    authors: parsed.authors,
    year: parsed.year,
    pageRanges: buildPageRanges(lines),
  };
}

/**
 * Finalize anchor with end coordinates and page ranges
 * @param {ReferenceAnchor} anchor
 * @param {Array} lines
 * @param {string} format
 */
function finalizeAnchor(anchor, lines, format) {
  if (lines.length === 0) return;

  const lastLine = lines[lines.length - 1];

  // Calculate end coordinate
  const lastItem = lastLine.items?.[lastLine.items.length - 1];
  anchor.endCoord = {
    x: lastItem ? lastItem.x + lastItem.width : lastLine.x + 200,
    y: lastLine.originalY || lastLine.y,
  };

  // Build page ranges with rectangles
  anchor.pageRanges = buildPageRanges(lines);

  // Calculate text and confidence
  const text = lines
    .map((l) => l.text)
    .join(" ")
    .trim();
  anchor.cachedText = text;

  // Adjust confidence based on content
  if (
    text.length >= MIN_REFERENCE_LENGTH &&
    text.length <= MAX_REFERENCE_LENGTH
  ) {
    anchor.confidence += 0.1;
  }
  if (YEAR_PATTERN.test(text)) {
    anchor.confidence += 0.05;
  }
  if (Object.values(REFERENCE_ENDING_PATTERNS).some((p) => p.test(text))) {
    anchor.confidence += 0.05;
  }

  anchor.confidence = Math.min(1, anchor.confidence);
}

/**
 * Build page ranges with rectangles for an anchor
 * @param {Array} lines
 * @returns {Array}
 */
function buildPageRanges(lines) {
  const pageRanges = new Map();

  for (const line of lines) {
    if (!pageRanges.has(line.pageNumber)) {
      pageRanges.set(line.pageNumber, {
        pageNumber: line.pageNumber,
        rects: [],
      });
    }

    // Build rect from line items or line bounds
    if (line.items && line.items.length > 0) {
      const minX = Math.min(...line.items.map((i) => i.x));
      const maxX = Math.max(...line.items.map((i) => i.x + i.width));
      const minY = Math.min(...line.items.map((i) => i.y));
      const maxY = Math.max(...line.items.map((i) => i.y + i.height));

      pageRanges.get(line.pageNumber).rects.push({
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      });
    } else {
      pageRanges.get(line.pageNumber).rects.push({
        x: line.x,
        y: line.y,
        width: 200, // Estimate
        height: line.fontSize || 12,
      });
    }
  }

  return Array.from(pageRanges.values());
}

/**
 * Extract text content for an anchor from section lines
 * @param {ReferenceAnchor} anchor
 * @param {Object} section
 * @returns {string}
 */
function extractTextForAnchor(anchor, section) {
  if (anchor.cachedText) return anchor.cachedText;

  const relevantLines = section.lines.filter((line) => {
    if (line.pageNumber < anchor.pageNumber) return false;
    if (line.pageNumber > anchor.pageNumber) {
      // Check if within bounds
      return (
        anchor.endCoord &&
        line.pageNumber === anchor.endCoord.pageNumber &&
        (line.originalY || line.y) >= anchor.endCoord.y
      );
    }
    // Same page
    const lineY = line.originalY || line.y;
    return (
      lineY <= anchor.startCoord.y &&
      (!anchor.endCoord || lineY >= anchor.endCoord.y)
    );
  });

  return relevantLines
    .map((l) => l.text)
    .join(" ")
    .trim();
}

// ============================================
// Author/Year Parsing
// ============================================

/**
 * Parse author and year from reference text
 * @param {string} text
 * @returns {{authors: string|null, year: string|null}}
 */
function parseAuthorYear(text) {
  if (!text) return { authors: null, year: null };

  let authors = null;
  let year = null;

  // Extract year
  const yearMatch = text.match(YEAR_PATTERN);
  if (yearMatch) {
    year = yearMatch[0];
  }

  // Extract author - try different patterns
  // Pattern 1: "Smith, J." at start
  const lastFirstMatch = text.match(LAST_NAME_PATTERNS.lastFirst);
  if (lastFirstMatch) {
    authors = lastFirstMatch[1];
  } else {
    // Pattern 2: First capitalized word(s) before year or comma
    const simpleMatch = text.match(
      /^([A-Z][a-zÀ-ÿ]+(?:[-'][A-Z][a-zÀ-ÿ]+)?(?:\s*,?\s*(?:and|&)\s*[A-Z][a-zÀ-ÿ]+)*)/,
    );
    if (simpleMatch) {
      authors = simpleMatch[1].replace(NAME_SUFFIXES, "").trim();
    }
  }

  return { authors, year };
}

/**
 * Match a citation to a reference using year + author + initials
 * @param {string} citationAuthor - Author from citation (e.g., "Smith")
 * @param {string} citationYear - Year from citation (e.g., "2020")
 * @param {ReferenceAnchor[]} anchors - Reference anchors to search
 * @returns {ReferenceAnchor|null}
 */
export function matchCitationToReference(
  citationAuthor,
  citationYear,
  anchors,
) {
  if (!citationYear) return null;

  // First: filter by year (must match exactly)
  const yearMatches = anchors.filter((a) => a.year === citationYear);

  if (yearMatches.length === 0) return null;
  if (yearMatches.length === 1) return yearMatches[0];

  // Second: filter by author last name
  if (citationAuthor) {
    const authorLower = citationAuthor
      .toLowerCase()
      .replace(/\s+et\s+al\.?/i, "")
      .trim();

    const authorMatches = yearMatches.filter((a) => {
      if (!a.authors) return false;
      const refAuthorLower = a.authors.toLowerCase();
      return (
        refAuthorLower.startsWith(authorLower) ||
        refAuthorLower.includes(authorLower)
      );
    });

    if (authorMatches.length === 1) return authorMatches[0];
    if (authorMatches.length > 1) {
      // Try exact match
      const exact = authorMatches.find((a) =>
        a.authors?.toLowerCase().startsWith(authorLower),
      );
      return exact || authorMatches[0];
    }
  }

  // Return first year match if no author match
  return yearMatches[0];
}

// ============================================
// Inline Citation Detection (for fallback linking)
// ============================================

/**
 * Find all inline citations in the document (excluding reference section)
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @param {ReferenceIndex} referenceIndex
 * @returns {InlineCitation[]}
 */
export function findInlineCitations(searchIndex, referenceIndex) {
  if (!searchIndex?.isBuilt) return [];

  const citations = [];
  const docInfo = getDocInfo(searchIndex);
  if (!docInfo?.pageData) return citations;

  const { pageData } = docInfo;
  const refStartPage = referenceIndex?.sectionStart?.pageNumber || Infinity;

  for (const [pageNum, data] of pageData) {
    // Skip reference section
    if (pageNum >= refStartPage) continue;

    const { allLines } = data;

    for (const line of allLines) {
      // Find numeric citations
      const numericCitations = findNumericCitationsInLine(line, pageNum);
      citations.push(...numericCitations);

      // Find author-year citations
      const authorYearCitations = findAuthorYearCitationsInLine(line, pageNum);
      citations.push(...authorYearCitations);
    }
  }

  return citations;
}

/**
 * Find numeric citations in a line
 * @param {Object} line
 * @param {number} pageNumber
 * @returns {InlineCitation[]}
 */
function findNumericCitationsInLine(line, pageNumber) {
  const citations = [];
  const text = line.text;

  // Match [1], [1,2,3], [1-5]
  const bracketPattern = /\[(\d+(?:\s*[-–—,;]\s*\d+)*)\]/g;
  let match;

  while ((match = bracketPattern.exec(text)) !== null) {
    const indices = parseNumericCitation(match[1]);

    // Estimate position from match index
    const rect = estimateRectFromMatch(line, match.index, match[0].length);

    citations.push({
      type: "numeric",
      text: match[0],
      pageNumber,
      rect,
      refIndices: indices,
      refKeys: null,
    });
  }

  return citations;
}

/**
 * Find author-year citations in a line
 * @param {Object} line
 * @param {number} pageNumber
 * @returns {InlineCitation[]}
 */
function findAuthorYearCitationsInLine(line, pageNumber) {
  const citations = [];
  const text = line.text;

  // Match "Smith (2020)" style
  const authorThenYear =
    /([A-Z][a-zÀ-ÿ]+(?:\s+et\s+al\.?)?)\s*\((\d{4}[a-z]?)\)/g;
  let match;

  while ((match = authorThenYear.exec(text)) !== null) {
    const rect = estimateRectFromMatch(line, match.index, match[0].length);

    citations.push({
      type: "author-year",
      text: match[0],
      pageNumber,
      rect,
      refIndices: null,
      refKeys: [{ author: match[1], year: match[2] }],
    });
  }

  // Match "(Smith, 2020)" style
  const parenStyle =
    /\(([A-Z][a-zÀ-ÿ]+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][a-zÀ-ÿ]+)?),?\s*(\d{4}[a-z]?)\)/g;

  while ((match = parenStyle.exec(text)) !== null) {
    const rect = estimateRectFromMatch(line, match.index, match[0].length);

    citations.push({
      type: "author-year",
      text: match[0],
      pageNumber,
      rect,
      refIndices: null,
      refKeys: [{ author: match[1], year: match[2] }],
    });
  }

  return citations;
}

/**
 * Parse numeric citation string like "1,2,3" or "1-5" into array of indices
 * @param {string} str
 * @returns {number[]}
 */
function parseNumericCitation(str) {
  const indices = [];
  const parts = str.split(/[,;]/);

  for (const part of parts) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/(\d+)\s*[-–—]\s*(\d+)/);

    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        indices.push(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) {
        indices.push(num);
      }
    }
  }

  return indices;
}

/**
 * Estimate rectangle for a text match within a line
 * @param {Object} line
 * @param {number} matchStart - Character index where match starts
 * @param {number} matchLength - Length of match
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function estimateRectFromMatch(line, matchStart, matchLength) {
  // Try to find position from line items
  if (line.items && line.items.length > 0) {
    let charCount = 0;
    let startX = line.x;
    let endX = line.x;

    for (const item of line.items) {
      const itemEnd = charCount + item.str.length;

      if (charCount <= matchStart && itemEnd >= matchStart) {
        // Match starts in this item
        const offsetRatio = (matchStart - charCount) / item.str.length;
        startX = item.x + item.width * offsetRatio;
      }

      if (
        charCount <= matchStart + matchLength &&
        itemEnd >= matchStart + matchLength
      ) {
        // Match ends in this item
        const offsetRatio =
          (matchStart + matchLength - charCount) / item.str.length;
        endX = item.x + item.width * offsetRatio;
        break;
      }

      charCount = itemEnd + 1; // +1 for space between items
    }

    return {
      x: startX,
      y: line.y,
      width: Math.max(10, endX - startX),
      height: line.fontSize || 12,
    };
  }

  // Fallback: estimate based on character position
  const avgCharWidth = (line.fontSize || 12) * 0.5;
  return {
    x: line.x + matchStart * avgCharWidth,
    y: line.y,
    width: matchLength * avgCharWidth,
    height: line.fontSize || 12,
  };
}

// ============================================
// Cross-Reference Detection
// ============================================

/**
 * Find figure/table/section references in document
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {Array<{type: string, text: string, pageNumber: number, rect: Object, target: string}>}
 */
export function findCrossReferences(searchIndex) {
  if (!searchIndex?.isBuilt) return [];

  const crossRefs = [];
  const docInfo = getDocInfo(searchIndex);
  if (!docInfo?.pageData) return crossRefs;

  const { pageData } = docInfo;

  for (const [pageNum, data] of pageData) {
    const { allLines } = data;

    for (const line of allLines) {
      for (const [type, pattern] of Object.entries(CROSS_REFERENCE_PATTERNS)) {
        // Create new regex instance to reset lastIndex
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;

        while ((match = regex.exec(line.text)) !== null) {
          const target = match[1] || match[2]; // Some patterns have target in group 2
          const rect = estimateRectFromMatch(
            line,
            match.index,
            match[0].length,
          );

          crossRefs.push({
            type,
            text: match[0],
            pageNumber: pageNum,
            rect,
            target,
          });
        }
      }
    }
  }

  return crossRefs;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Check if font name indicates bold style
 * @param {string|null} fontName
 * @returns {boolean}
 */
function isBoldFont(fontName) {
  if (!fontName) return false;
  const lower = fontName.toLowerCase();
  return (
    lower.includes("bold") ||
    lower.includes("-bd") ||
    lower.includes("_bd") ||
    lower.includes("-b") ||
    lower.includes("black") ||
    lower.includes("heavy") ||
    lower.includes("semibold") ||
    lower.includes("demibold") ||
    /cmbx/.test(lower) ||
    /cmb[^a-z]/.test(lower)
  );
}

/**
 * Find reference anchor by coordinate (for hybrid lookup)
 * @param {ReferenceAnchor[]} anchors
 * @param {number} pageNumber
 * @param {number} x
 * @param {number} y - Y in PDF coordinates (from bottom)
 * @returns {{current: ReferenceAnchor|null, next: ReferenceAnchor|null}}
 */
export function findBoundingAnchors(anchors, pageNumber, x, y) {
  // Filter to relevant page and nearby pages
  const relevantAnchors = anchors.filter(
    (a) =>
      a.pageNumber === pageNumber ||
      a.pageNumber === pageNumber + 1 ||
      a.pageNumber === pageNumber - 1,
  );

  if (relevantAnchors.length === 0) {
    return { current: null, next: null };
  }

  // Sort by page then by Y (descending, since PDF Y goes up)
  relevantAnchors.sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return b.startCoord.y - a.startCoord.y; // Higher Y first (top of page in PDF coords)
  });

  let current = null;
  let next = null;

  for (let i = 0; i < relevantAnchors.length; i++) {
    const anchor = relevantAnchors[i];

    if (anchor.pageNumber === pageNumber) {
      // Check if target Y falls within this anchor's range
      if (
        y <= anchor.startCoord.y &&
        (!anchor.endCoord || y >= anchor.endCoord.y)
      ) {
        current = anchor;
        next = relevantAnchors[i + 1] || null;
        break;
      }
      // Check if we've passed this anchor (target is below it)
      if (y > anchor.startCoord.y) {
        next = anchor;
        current = relevantAnchors[i - 1] || null;
        break;
      }
    } else if (anchor.pageNumber > pageNumber) {
      // We're on next page - previous anchor is current
      current = relevantAnchors[i - 1] || null;
      next = anchor;
      break;
    }
  }

  // If we went through all without finding, target might be after last anchor
  if (!current && !next && relevantAnchors.length > 0) {
    const last = relevantAnchors[relevantAnchors.length - 1];
    if (last.pageNumber === pageNumber || last.pageNumber < pageNumber) {
      current = last;
    }
  }

  return { current, next };
}

/**
 * Find reference by numeric index (for direct lookup from numeric citations)
 * @param {ReferenceAnchor[]} anchors
 * @param {number} index
 * @returns {ReferenceAnchor|null}
 */
export function findReferenceByIndex(anchors, index) {
  return anchors.find((a) => a.index === index) || null;
}
