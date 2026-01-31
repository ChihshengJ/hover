/**
 * ReferenceBuilder - Reference extraction using structural signals
 * Uses relative X/Y changes and line width for robust boundary detection
 *
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
  CROSS_REFERENCE_PATTERNS,
  NAME_SUFFIXES,
  LAST_NAME_PATTERNS,
  SECTION_NUMBER_STRIP,
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

    for (const anchor of anchors) {
      const parsed = parseAuthorYear(anchor.cachedText);
      anchor.authors = parsed.authors;
      anchor.year = parsed.year;
    }

    console.log("[Reference] Anchors:", anchors);

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

// ============================================
// Section Location (kept from original)
// ============================================

function findReferenceSection(textIndex) {
  const docInfo = getDocInfo(textIndex);
  if (!docInfo?.pageData) return null;

  const { pageData, fontSize: bodyFontSize } = docInfo;
  let referenceStart = null;

  for (const [pageNum, data] of pageData) {
    if (pageNum <= 2) continue;

    const { lines } = data;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const strippedText = line.text
        .replace(SECTION_NUMBER_STRIP, "")
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();

      if (REFERENCE_SECTION_PATTERN.test(strippedText)) {
        const isLarger = line.fontSize > bodyFontSize * 1.05;
        const isBold =
          line.fontStyle === FontStyle.BOLD ||
          line.fontStyle === FontStyle.BOLD_ITALIC;
        const isAllCapital = line.text === line.text.toUpperCase();

        if (isLarger || isBold || isAllCapital) {
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

function findReferenceSectionEnd(pageData, start, bodyFontSize) {
  let lastValidLine = null;
  const pageNumbers = Array.from(pageData.keys()).sort((a, b) => a - b);

  for (const pageNum of pageNumbers) {
    if (pageNum < start.pageNumber) continue;

    const { lines } = pageData.get(pageNum);
    const startIdx = pageNum === start.pageNumber ? start.lineIndex + 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const strippedText = line.text
        .replace(SECTION_NUMBER_STRIP, "")
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();

      const isLarger = line.fontSize > bodyFontSize * 1.3;
      const isBold =
        line.fontStyle === FontStyle.BOLD ||
        line.fontStyle === FontStyle.BOLD_ITALIC;
      const isAllCapital =
        line.text === line.text.toUpperCase() && /\d+/.test(line) && line.text.length > 3;

      if (isLarger || isBold || isAllCapital) {
        console.log("found section end:");
        console.log(line, bodyFontSize);
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

// ============================================
// Format Detection (kept from original)
// ============================================

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
// Structural Reference Extraction (new)
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
    let isNewReference = false;

    if (currentRef.lines.length === 0) {
      isNewReference = true;
    } else {
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
  const isAfterShortLine = prevLineWidth < metrics.typicalLineWidth * 0.7;

  const lineHeight = line.lineHeight || 10;
  const tolerance = lineHeight * 0.5;

  const isIndented = line.x > currentRef.firstLineX + tolerance;
  const isAtFirstX = line.x <= currentRef.firstLineX + tolerance;
  const wasIndented = prevLine.x > currentRef.firstLineX + tolerance;

  const isColumnBreak =
    prevYDirection !== null &&
    yDirection !== 0 &&
    yDirection !== prevYDirection &&
    absYDelta > metrics.baselineLineGap;

  const isPageBreak = line.pageNumber !== prevLine.pageNumber;
  const isBoundaryJump = isColumnBreak || isPageBreak;

  const isLargeGap =
    !isBoundaryJump && absYDelta > metrics.baselineLineGap * 1.5;

  console.log(line.text, isIndented, isAfterShortLine, isLargeGap, isBoundaryJump);
  let isNewReference = false;

  if (isLargeGap) {
    isNewReference = true;
  } else if (isBoundaryJump) {
    if (isAfterShortLine && isAtFirstX) {
      isNewReference = true;
    } else if (isIndented) {
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
  if (/^[A-Z][a-zÀ-ÿ]+[,\.]/.test(trimmed)) return true;

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

  return {
    id: `ref-${index}`,
    index,
    pageNumber: firstLine.pageNumber,
    startCoord: { x: firstLine.x, y: firstLine.y - firstLineHeight },
    endCoord: { x: endX, y: lastLine.y - lastLineHeight },
    formatHint: format,
    cachedText: text,
    authors: null,
    year: null,
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

function parseAuthorYear(text) {
  if (!text) return { authors: null, year: null };

  let authors = null;
  let year = null;

  const yearMatch = text.match(YEAR_PATTERN);
  if (yearMatch) year = yearMatch[0];

  const lastFirstMatch = text.match(LAST_NAME_PATTERNS.lastFirst);
  if (lastFirstMatch) {
    authors = lastFirstMatch[1];
  } else {
    const simpleMatch = text.match(
      /^([A-Z][a-zÀ-ÿ]+(?:[-'][A-Z][a-zÀ-ÿ]+)?(?:\s*,?\s*(?:and|&)\s*[A-Z][a-zÀ-ÿ]+)*)/,
    );
    if (simpleMatch) {
      authors = simpleMatch[1].replace(NAME_SUFFIXES, "").trim();
    }
  }

  return { authors, year };
}

// ============================================
// Anchor Lookup (simplified)
// ============================================

export function findBoundingAnchors(anchors, pageNumber, x, y) {
  if (anchors.length === 0) return { current: null, next: null };
  let closest = null;
  let closestDist = Infinity;
  let closestIdx = -1;
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (anchor.pageNumber !== pageNumber) continue;
    const dist = Math.hypot(anchor.startCoord.x - x, anchor.startCoord.y - y);
    if (dist < closestDist) {
      closestDist = dist;
      closest = anchor;
      closestIdx = i;
    }
  }
  if (!closest) {
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      const hasPageRange = anchor.pageRanges.some(pr => pr.pageNumber === pageNumber);
      if (!hasPageRange) continue;
      const dist = Math.abs(anchor.startCoord.y - y);
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

export function matchCitationToReference(
  citationAuthor,
  citationYear,
  anchors,
) {
  if (!citationYear) return null;

  const yearMatches = anchors.filter((a) => a.year === citationYear);
  if (yearMatches.length === 0) return null;
  if (yearMatches.length === 1) return yearMatches[0];

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
      return (
        authorMatches.find((a) =>
          a.authors?.toLowerCase().startsWith(authorLower),
        ) || authorMatches[0]
      );
    }
  }

  return yearMatches[0];
}

// ============================================
// Inline Citations (kept from original)
// ============================================

export function findInlineCitations(textIndex, referenceIndex) {
  if (!textIndex) return [];

  const citations = [];
  const docInfo = getDocInfo(textIndex);
  if (!docInfo?.pageData) return citations;

  const { pageData } = docInfo;
  const refStartPage = referenceIndex?.sectionStart?.pageNumber || Infinity;

  for (const [pageNum, data] of pageData) {
    if (pageNum >= refStartPage) continue;

    for (const line of data.lines) {
      citations.push(...findNumericCitationsInLine(line, pageNum));
      citations.push(...findAuthorYearCitationsInLine(line, pageNum));
    }
  }

  return citations;
}

function findNumericCitationsInLine(line, pageNumber) {
  const citations = [];
  const bracketPattern = /\[(\d+(?:\s*[-–—,;]\s*\d+)*)\]/g;
  let match;

  while ((match = bracketPattern.exec(line.text)) !== null) {
    citations.push({
      type: "numeric",
      text: match[0],
      pageNumber,
      rect: estimateRectFromMatch(line, match.index, match[0].length),
      refIndices: parseNumericCitation(match[1]),
      refKeys: null,
    });
  }

  return citations;
}

function findAuthorYearCitationsInLine(line, pageNumber) {
  const citations = [];

  const authorThenYear =
    /([A-Z][a-zÀ-ÿ]+(?:\s+et\s+al\.?)?)\s*\((\d{4}[a-z]?)\)/g;
  let match;

  while ((match = authorThenYear.exec(line.text)) !== null) {
    citations.push({
      type: "author-year",
      text: match[0],
      pageNumber,
      rect: estimateRectFromMatch(line, match.index, match[0].length),
      refIndices: null,
      refKeys: [{ author: match[1], year: match[2] }],
    });
  }

  const parenStyle =
    /\(([A-Z][a-zÀ-ÿ]+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][a-zÀ-ÿ]+)?),?\s*(\d{4}[a-z]?)\)/g;

  while ((match = parenStyle.exec(line.text)) !== null) {
    citations.push({
      type: "author-year",
      text: match[0],
      pageNumber,
      rect: estimateRectFromMatch(line, match.index, match[0].length),
      refIndices: null,
      refKeys: [{ author: match[1], year: match[2] }],
    });
  }

  return citations;
}

function parseNumericCitation(str) {
  const indices = [];
  const parts = str.split(/[,;]/);

  for (const part of parts) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/(\d+)\s*[-–—]\s*(\d+)/);

    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) indices.push(i);
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) indices.push(num);
    }
  }

  return indices;
}

function estimateRectFromMatch(line, matchStart, matchLength) {
  if (line.items?.length > 0) {
    let charCount = 0;
    let startX = line.x;
    let endX = line.x;

    for (const item of line.items) {
      const itemEnd = charCount + item.str.length;

      if (charCount <= matchStart && itemEnd >= matchStart) {
        const offsetRatio = (matchStart - charCount) / item.str.length;
        startX = item.x + item.width * offsetRatio;
      }

      if (
        charCount <= matchStart + matchLength &&
        itemEnd >= matchStart + matchLength
      ) {
        const offsetRatio =
          (matchStart + matchLength - charCount) / item.str.length;
        endX = item.x + item.width * offsetRatio;
        break;
      }

      charCount = itemEnd + 1;
    }

    return {
      x: startX,
      y: line.y,
      width: Math.max(10, endX - startX),
      height: line.fontSize || 12,
    };
  }

  const avgCharWidth = (line.fontSize || 12) * 0.5;
  return {
    x: line.x + matchStart * avgCharWidth,
    y: line.y,
    width: matchLength * avgCharWidth,
    height: line.fontSize || 12,
  };
}

// ============================================
// Cross References (kept from original)
// ============================================

export function findCrossReferences(textIndex) {
  if (!textIndex) return [];

  const crossRefs = [];
  const docInfo = getDocInfo(textIndex);
  if (!docInfo?.pageData) return crossRefs;

  for (const [pageNum, data] of docInfo.pageData) {
    for (const line of data.lines) {
      for (const [type, pattern] of Object.entries(CROSS_REFERENCE_PATTERNS)) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;

        while ((match = regex.exec(line.text)) !== null) {
          crossRefs.push({
            type,
            text: match[0],
            pageNumber: pageNum,
            rect: estimateRectFromMatch(line, match.index, match[0].length),
            target: match[1] || match[2],
          });
        }
      }
    }
  }

  return crossRefs;
}
