/**
 * @typedef {Object} ReferenceAnchor
 * @property {string} id
 * @property {number|null} index
 * @property {number} pageNumber
 * @property {{x: number, y: number}} startCoord
 * @property {{x: number, y: number}} endCoord
 * @property {string} formatHint
 * @property {string} cachedText
 * @property {string|null} authors
 * @property {string|null} year
 * @property {Array<{pageNumber: number, rects: Array}>} pageRanges
 */

import { getDocInfo } from "./outline_builder.js";
import { FontStyle } from "./text_index.js";
import {
  REFERENCE_SECTION_PATTERN,
  REFERENCE_FORMAT_PATTERNS,
  AUTHOR_YEAR_START_PATTERN,
  YEAR_PATTERN,
  SECTION_NUMBER_STRIP,
  POST_REFERENCE_SECTION_PATTERN,
  AUTHOR_YEAR_BLOCKS,
} from "./lexicon.js";

const EMPTY_RESULT = {
  anchors: [],
  format: "unknown",
  sectionStart: null,
  sectionEnd: null,
};

export async function buildReferenceIndex(textIndex) {
  if (!textIndex) return EMPTY_RESULT;

  try {
    const section = findReferenceSection(textIndex);
    if (!section) {
      console.log("[Reference] No reference section found");
      return EMPTY_RESULT;
    }

    console.log(
      `[Reference] Section: pages ${section.startPage}-${section.endPage}, ${section.lines.length} lines`,
    );

    const format = detectReferenceFormat(section.lines);
    console.log(`[Reference] Format: ${format}`);

    const anchors = extractReferenceAnchors(section.lines, format);
    console.log(`[Reference] Extracted ${anchors.length} anchors`);

    return {
      anchors,
      format,
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
    console.error("[Reference] Error building index:", error);
    return EMPTY_RESULT;
  }
}

function findReferenceSection(textIndex) {
  const docInfo = getDocInfo(textIndex);
  if (!docInfo?.pageData) return null;

  const {
    pageData,
    lineHeight: bodyFontSize,
    marginBottom: bodyMarginBottom,
  } = docInfo;
  let referenceStart = null;

  for (const [pageNum, data] of pageData) {
    if (pageNum <= 2) continue;

    const { lines, pageHeight } = data;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const strippedText = line.text
        .replace(SECTION_NUMBER_STRIP, "")
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();

      if (REFERENCE_SECTION_PATTERN.test(strippedText)) {
        const isWeirdPosition =
          line.y >= pageHeight * 0.95 || line.y <= pageHeight * 0.05;
        const isBold =
          line.fontStyle === FontStyle.BOLD ||
          line.fontStyle === FontStyle.BOLD_ITALIC;
        const isAllCapital = line.text === line.text.toUpperCase();
        const isDirectMatch = strippedText === "references";

        if (!isWeirdPosition && (isBold || isAllCapital || isDirectMatch)) {
          referenceStart = {
            pageNumber: pageNum,
            lineIndex: i,
            y: line.y,
            originalY: line.originalY,
            line,
          };
        }
      }
    }
  }

  if (!referenceStart) return null;

  const referenceEnd = findReferenceSectionEnd(
    pageData,
    referenceStart,
    bodyFontSize,
    bodyMarginBottom,
  );
  const lines = collectSectionLines(pageData, referenceStart, referenceEnd);

  return {
    startPage: referenceStart.pageNumber,
    endPage: referenceEnd.pageNumber,
    startLineIndex: referenceStart.lineIndex,
    endLineIndex: referenceEnd.lineIndex,
    startY: referenceStart.y,
    endY: referenceEnd.y,
    lines,
  };
}

function findReferenceSectionEnd(
  pageData,
  start,
  bodyFontSize,
  bodyMarginBottom,
) {
  let lastValidLine = null;
  const pageNumbers = Array.from(pageData.keys()).sort((a, b) => a - b);

  for (const pageNum of pageNumbers) {
    if (pageNum < start.pageNumber) continue;

    const { lines, pageWidth, pageHeight, marginLeft, marginBottom } =
      pageData.get(pageNum);
    const startIdx = pageNum === start.pageNumber ? start.lineIndex + 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const isColumnBreak = lastValidLine?.y - line.y < 0;
      const isWeirdPosition =
        line.y >= pageHeight * 0.95 ||
        line.y <= pageHeight * 0.05 ||
        (isColumnBreak && line.x < pageWidth / 2 && line.x > marginLeft + 30);
      if (isWeirdPosition) continue;
      const strippedText = line.text
        .replace(SECTION_NUMBER_STRIP, "")
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();

      const isBoldAndLarge =
        line.fontSize > bodyFontSize * 1.5 && line.fontStyle === FontStyle.BOLD;
      const isAllCapital =
        line.text === line.text.toUpperCase() &&
        /\d+/.test(line) &&
        line.text.length > 3;
      const isDirectIndicator =
        POST_REFERENCE_SECTION_PATTERN.test(strippedText);
      const isBigJump =
        line.y === marginBottom && marginBottom > bodyMarginBottom + 20;

      if (isDirectIndicator || isAllCapital || isBoldAndLarge || isBigJump) {
        return {
          pageNumber: pageNum,
          lineIndex: i - 1,
          y: lastValidLine?.y || line.y,
        };
      }

      if (line.text.trim().length > 0) {
        lastValidLine = { pageNumber: pageNum, lineIndex: i, y: line.y };
      }
    }
  }

  return (
    lastValidLine || {
      pageNumber: start.pageNumber,
      lineIndex: start.lineIndex + 1,
      y: start.y,
    }
  );
}

function collectSectionLines(pageData, start, end) {
  const lines = [];
  const pageNumbers = Array.from(pageData.keys()).sort((a, b) => a - b);

  for (const pageNum of pageNumbers) {
    if (pageNum < start.pageNumber || pageNum > end.pageNumber) continue;

    const data = pageData.get(pageNum);
    const { lines: pageLines, pageWidth, pageHeight } = data;

    let startIdx = 0;
    let endIdx = pageLines.length - 1;

    if (pageNum === start.pageNumber) startIdx = start.lineIndex + 1;
    if (pageNum === end.pageNumber) endIdx = end.lineIndex;

    for (let i = startIdx; i <= endIdx && i < pageLines.length; i++) {
      if (
        pageLines[i].y >= pageHeight * 0.92 ||
        pageLines[i].y <= pageHeight * 0.05
      )
        continue;
      if (pageLines[i].width / 2 + pageLines[i].x)
        if (pageLines[i].text.length < 3) continue;
      lines.push({
        ...pageLines[i],
        pageNumber: pageNum,
        lineIndex: i,
        pageWidth,
        pageHeight,
      });
    }
  }

  return lines;
}

function detectReferenceFormat(lines) {
  if (lines.length === 0) return "unknown";

  const sampleLines = lines
    .filter((l) => l.text.trim().length > 10)
    .slice(0, 30);
  if (sampleLines.length === 0) return "unknown";

  const formatCounts = {};
  for (const [name, pattern] of Object.entries(REFERENCE_FORMAT_PATTERNS)) {
    formatCounts[name] = sampleLines.filter((l) => pattern.test(l.text)).length;
  }

  const bestNumbered = Object.entries(formatCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];
  if (bestNumbered && bestNumbered[1] >= sampleLines.length * 0.15) {
    return bestNumbered[0];
  }

  const authorYearCount = sampleLines.filter((l) =>
    AUTHOR_YEAR_START_PATTERN.test(l.text),
  ).length;
  if (authorYearCount >= sampleLines.length * 0.15) return "author-year";

  if (detectHangingIndent(sampleLines)) return "hanging-indent";

  return "unknown";
}

function detectHangingIndent(lines) {
  if (lines.length < 6) return false;

  let hangingPatterns = 0;
  let prevLineX = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (prevLineX !== null && line.x > prevLineX + line.fontSize * 0.5) {
      hangingPatterns++;
    }
    prevLineX = line.x;
  }

  return hangingPatterns >= 3;
}

// ============================================
// Structural Reference Extraction
// ============================================

function extractReferenceAnchors(lines, format) {
  if (lines.length === 0) return [];

  if (format.startsWith("numbered-")) {
    return extractNumberedReferences(lines, format);
  }

  return extractStructuralReferences(lines, format);
}

function extractNumberedReferences(lines, format) {
  const pattern = REFERENCE_FORMAT_PATTERNS[format];
  if (!pattern) return [];

  const anchors = [];
  let currentLines = [];
  let currentIndex = null;
  let refCount = 0;

  for (const line of lines) {
    const match = line.text.match(pattern);

    if (match) {
      if (currentLines.length > 0) {
        anchors.push(createAnchor(currentLines, currentIndex, format));
        refCount++;
      }
      currentIndex = parseInt(match[1], 10);
      currentLines = [line];
    } else if (currentLines.length > 0) {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    anchors.push(createAnchor(currentLines, currentIndex, format));
  }

  return anchors;
}

function extractStructuralReferences(lines, format) {
  if (lines.length === 0) return [];

  const metrics = computeSectionMetrics(lines);
  console.log("[Reference] Metrics:", metrics);

  const anchors = [];
  let currentRef = { firstLineX: null, lines: [] };
  let prevLine = null;
  let prevYDirection = null;
  let refIndex = 0;

  for (const line of lines) {
    if (line.text.trim().length <= 2) continue;

    let isNewReference = false;

    if (currentRef.lines.length === 0) {
      isNewReference = true;
    } else {
      // Initialize prevYDirection from first transition if not yet set
      if (prevYDirection === null && prevLine) {
        prevYDirection = Math.sign(line.y - prevLine.y);
      }

      const result = detectBoundary(
        line,
        prevLine,
        currentRef,
        prevYDirection,
        metrics,
      );
      isNewReference = result.isNewReference;

      if (!result.isBoundaryJump && result.yDirection !== 0) {
        prevYDirection = result.yDirection;
      } else if (result.isBoundaryJump) {
        prevYDirection = null;
      }
    }

    if (isNewReference && currentRef.lines.length > 0) {
      refIndex++;
      anchors.push(createAnchor(currentRef.lines, refIndex, format));
      currentRef = { firstLineX: null, lines: [] };
    }

    if (currentRef.firstLineX === null) {
      currentRef.firstLineX = line.x;
    }
    currentRef.lines.push(line);
    prevLine = line;
  }

  if (currentRef.lines.length > 0) {
    refIndex++;
    anchors.push(createAnchor(currentRef.lines, refIndex, format));
  }

  return anchors;
}

function detectBoundary(line, prevLine, currentRef, prevYDirection, metrics) {
  const yDelta = line.y - prevLine.y;
  const yDirection = Math.sign(yDelta);
  const absYDelta = Math.abs(yDelta);

  const prevLineWidth = calculateLineWidth(prevLine);
  const isAfterShortLine = prevLineWidth < metrics.typicalLineWidth * 0.75;

  const lineHeight = line.lineHeight || 10;
  const tolerance = lineHeight * 0.5;

  const isIndented = line.x > currentRef.firstLineX + tolerance;
  const isAtFirstX = line.x <= currentRef.firstLineX + tolerance;
  const wasIndented = prevLine.x >= currentRef.firstLineX;

  const isColumnBreak =
    prevYDirection !== null &&
    yDirection !== 0 &&
    yDirection !== prevYDirection &&
    absYDelta > metrics.baselineLineGap;

  const isPageBreak = line.pageNumber !== prevLine.pageNumber;
  const isBoundaryJump = isColumnBreak || isPageBreak;

  const isLargeGap =
    !isBoundaryJump && absYDelta > metrics.baselineLineGap * 1.5;

  let isNewReference = false;

  if (isLargeGap) {
    isNewReference = true;
  } else if (isBoundaryJump) {
    if (isAfterShortLine) {
      isNewReference = true;
    } else if (isIndented) {
      currentRef.firstLineX = line.x - lineHeight;
      isNewReference = false;
    } else {
      isNewReference = looksLikeReferenceStart(line.text);
    }
  } else if (isAtFirstX && wasIndented) {
    if (isAfterShortLine) {
      isNewReference = true;
    } else {
      isNewReference = looksLikeReferenceStart(line.text);
    }
  }

  return { isNewReference, yDirection, isBoundaryJump };
}

function looksLikeReferenceStart(text) {
  const trimmed = text.trim();
  if (/^\s*[\[\(]?\d+[\]\)\.]/.test(trimmed)) return true;
  if (/^\s*[\[\(]?[A-Z]*\+?\d+[\]\)\.]/.test(trimmed)) return true;
  if (/^[A-Z][a-zÀ-ÿ]]+[,\.]/.test(trimmed)) return true;

  const continuationWords =
    /^(and|the|in|of|on|at|to|for|with|from|by|as|or|an|a)\s/i;
  if (/^[A-Z]/.test(trimmed) && !continuationWords.test(trimmed)) return true;

  return false;
}

function computeSectionMetrics(lines) {
  const widths = lines.map((l) => calculateLineWidth(l)).filter((w) => w > 0);
  const typicalLineWidth = percentile(widths, 75);

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].pageNumber === lines[i - 1].pageNumber) {
      const gap = Math.abs(lines[i].y - lines[i - 1].y);
      const fontSize = lines[i].lineHeight;
      if (gap > 0 && gap < fontSize * 4) {
        gaps.push(gap);
      }
    }
  }
  const baselineLineGap = median(gaps);

  return { typicalLineWidth, baselineLineGap };
}

function calculateLineWidth(line) {
  if (line.items?.length > 0) {
    const minX = Math.min(...line.items.map((i) => i.x));
    const maxX = Math.max(...line.items.map((i) => i.x + i.width));
    return maxX - minX;
  }
  return line.text.length * (line.fontSize || 10) * 0.5;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ============================================
// Anchor Creation
// ============================================

function createAnchor(lines, index, format) {
  const firstLine = lines[0];
  const firstLineHeight = firstLine.lineHeight / 2;
  const lastLine = lines[lines.length - 1];
  const lastLineHeight = lastLine.lineHeight / 2;
  const text = lines
    .map((l) => l.text)
    .join(" ")
    .trim();

  const lastItem = lastLine.items?.[lastLine.items.length - 1];
  const endX = lastItem ? lastItem.x + lastItem.width : lastLine.x + 200;

  const parsed = parseAuthorYear(text);

  return {
    id: `ref-${index}`,
    index,
    pageNumber: firstLine.pageNumber,
    startCoord: { x: firstLine.x, y: firstLine.y - firstLineHeight },
    endCoord: { x: endX, y: lastLine.y - lastLineHeight },
    formatHint: format,
    cachedText: text,
    year: parsed.year,
    authorSearchText: parsed.authorSearchText,
    hasMultipleAuthors: parsed.hasMultipleAuthors,
    pageRanges: buildPageRanges(lines),
  };
}

function buildPageRanges(lines) {
  const pageRanges = new Map();

  for (const line of lines) {
    if (!pageRanges.has(line.pageNumber)) {
      pageRanges.set(line.pageNumber, {
        pageNumber: line.pageNumber,
        rects: [],
      });
    }

    if (line.items?.length > 0) {
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
        width: 200,
        height: line.fontSize || 12,
      });
    }
  }

  return Array.from(pageRanges.values());
}

// ============================================
// Author/Year Parsing
// ============================================

/**
 * Parse authors and year from reference text
 * Simplified approach: store first 40 chars for substring matching
 *
 * @param {string} text - Reference text
 * @returns {{
 *   year: string|null,
 *   authorSearchText: string,
 *   hasMultipleAuthors: boolean
 * }}
 */
function parseAuthorYear(text) {
  if (!text) {
    return {
      year: null,
      authorSearchText: "",
      hasMultipleAuthors: false,
    };
  }

  // Extract year with optional letter suffix (2024, 2024a, 2024b)
  const yearMatch = text.match(/\b((?:19|20)\d{2}[a-z]?)\b/);
  const year = yearMatch ? yearMatch[1] : null;

  // Strip leading reference number/bracket and get first 40 chars
  const stripped = text
    .replace(/^[\[\(]?\d+[\]\)\.\s]*/, "")
    .slice(0, 40)
    .toLowerCase();

  // Check for multiple authors
  const hasMultipleAuthors = /\bet\s+al\b|,.*,|\band\b|&/i.test(
    text.slice(0, 100),
  );

  return {
    year,
    authorSearchText: stripped,
    hasMultipleAuthors,
  };
}

// ============================================
// Anchor Lookup
// ============================================

export function findBoundingAnchors(anchors, pageNumber, x, y) {
  if (anchors.length === 0) return { current: null, next: null };
  let closest = null;
  let closestDist = Infinity;
  let closestIdx = -1;
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (anchor.pageNumber !== pageNumber) continue;
    const dist =
      Math.abs(anchor.startCoord.y - y) + Math.abs(anchor.startCoord.x - x);
    if (dist < closestDist) {
      closestDist = dist;
      closest = anchor;
      closestIdx = i;
    }
  }
  if (!closest) {
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      const hasPageRange = anchor.pageRanges.some(
        (pr) => pr.pageNumber === pageNumber,
      );
      if (!hasPageRange) continue;
      const dist =
        Math.abs(anchor.startCoord.y - y) + Math.abs(anchor.startCoord.x - x);
      if (dist < closestDist) {
        closestDist = dist;
        closest = anchor;
        closestIdx = i;
      }
    }
  }

  return {
    current: closest,
    next: closestIdx >= 0 ? anchors[closestIdx + 1] || null : null,
  };
}

export function findReferenceByIndex(anchors, index) {
  return anchors.find((a) => a.index === index) || null;
}

// ============================================
// Citation Matching
// ============================================

/**
 * Match citation to reference anchor
 *
 * @param {string} citationAuthor - Author from citation (e.g., "Smith" from "Smith et al.")
 * @param {string} citationYear - Year with optional suffix (e.g., "2024a")
 * @param {Array} anchors - Reference anchors
 * @returns {Object|null}
 */
export function matchCitationToReference(
  citationAuthor,
  citationYear,
  anchors,
) {
  if (!citationYear) return null;

  // Year must match exactly (including letter suffix)
  const yearMatches = anchors.filter((a) => a.year === citationYear);
  if (yearMatches.length === 0) return null;
  if (yearMatches.length === 1) return yearMatches[0];

  if (citationAuthor) {
    // Clean author: remove "et al.", trim, lowercase
    const authorClean = citationAuthor
      .replace(/\s*et\s+al\.?\s*/gi, "")
      .trim()
      .toLowerCase();

    if (authorClean.length > 1) {
      const authorMatch = yearMatches.find((a) =>
        a.authorSearchText.includes(authorClean),
      );
      if (authorMatch) return authorMatch;
    }
  }

  return yearMatches[0];
}

