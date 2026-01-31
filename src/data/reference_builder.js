/**
 * ReferenceBuilder - Reference extraction and citation detection for academic PDFs
 * Refactored for DocumentTextIndex (PDFium-based)
 *
 * @typedef {Object} ReferenceAnchor
 * @property {string} id
 * @property {number|null} index
 * @property {number} pageNumber
 * @property {{x: number, y: number}} startCoord
 * @property {{x: number, y: number}} endCoord
 * @property {number} confidence
 * @property {string} formatHint
 * @property {string|null} cachedText
 * @property {string|null} authors
 * @property {string|null} year
 * @property {Array<{pageNumber: number, rects: Array}>} pageRanges
 *
 * @typedef {Object} ReferenceIndex
 * @property {ReferenceAnchor[]} anchors
 * @property {string} format
 * @property {number} sectionConfidence
 * @property {Object|null} sectionStart
 * @property {Object|null} sectionEnd
 */

import { getDocInfo } from "./outline_builder.js";
import { FontStyle } from "./text_index.js";
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

const EMPTY_RESULT = {
  anchors: [],
  format: "unknown",
  sectionConfidence: 0,
  sectionStart: null,
  sectionEnd: null,
};

export async function buildReferenceIndex(textIndex) {
  if (!textIndex) return EMPTY_RESULT;

  try {
    const section = findReferenceSection(textIndex);
    if (!section) return EMPTY_RESULT;

    console.log(`[Reference] Reference section: Page ${section.startPage} - ${section.endPage}`);
    const format = detectReferenceFormat(section.lines);
    console.log(`[Reference] Reference format detected: ${format}`);
    const anchors = extractReferenceAnchors(section, format);
    console.log(`[Reference] Extracted ${anchors.length} anchors`);
    console.log(anchors);

    for (const anchor of anchors) {
      if (anchor.confidence > 0.8) {
        anchor.cachedText = extractTextForAnchor(anchor, section);
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
    console.error("[References] Error building index:", error);
    return EMPTY_RESULT;
  }
}

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

      const isLarger = line.fontSize > bodyFontSize * 1.1;
      const isBold =
        line.fontStyle === FontStyle.BOLD ||
        line.fontStyle === FontStyle.BOLD_ITALIC;
      const isAllCapital = line.text === line.text.toUpperCase();

      if (isLarger || isBold || isAllCapital) {
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

function calculateSectionConfidence(start, end, lines) {
  let confidence = 0.5;

  if (lines.length >= 5 && lines.length <= 500) {
    confidence += 0.2;
  } else if (lines.length < 5) {
    confidence -= 0.2;
  }

  const pageSpan = end.pageNumber - start.pageNumber + 1;
  if (pageSpan >= 1 && pageSpan <= 10) confidence += 0.1;

  const hasNumberedRefs = lines.some((l) =>
    Object.values(REFERENCE_FORMAT_PATTERNS).some((p) => p.test(l.text)),
  );
  const hasYears =
    lines.filter((l) => YEAR_PATTERN.test(l.text)).length > lines.length * 0.3;

  if (hasNumberedRefs) confidence += 0.15;
  if (hasYears) confidence += 0.1;

  return Math.max(0, Math.min(1, confidence));
}

function detectReferenceFormat(lines) {
  if (lines.length === 0) return "unknown";

  const sampleLines = lines
    .filter((l) => l.text.trim().length > 10)
    .slice(0, 20);
  if (sampleLines.length === 0) return "unknown";

  const formatCounts = {};
  for (const [name, pattern] of Object.entries(REFERENCE_FORMAT_PATTERNS)) {
    formatCounts[name] = sampleLines.filter((l) => pattern.test(l.text)).length;
  }

  const bestNumbered = Object.entries(formatCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];
  if (bestNumbered && bestNumbered[1] >= sampleLines.length * 0.2) {
    return bestNumbered[0];
  }

  const authorYearCount = sampleLines.filter((l) =>
    AUTHOR_YEAR_START_PATTERN.test(l.text),
  ).length;
  if (authorYearCount >= sampleLines.length * 0.2) return "author-year";

  if (detectHangingIndent(sampleLines)) return "hanging-indent";

  return "unknown";
}

function detectHangingIndent(lines) {
  if (lines.length < 4) return false;

  const marginX = Math.min(
    ...lines.filter((l) => l.isAtLineStart).map((l) => l.x),
  );
  if (!isFinite(marginX)) return false;

  let hangingPatterns = 0;
  let i = 0;

  while (i < lines.length - 1) {
    if (lines[i].isAtLineStart) {
      let j = i + 1;
      while (
        j < lines.length &&
        Math.abs(lines[j].y - lines[j - 1].y) < lines[j - 1].fontSize * 2.2
      ) {
        if (lines[j].x > marginX + lines[j].fontSize) {
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

function extractReferenceAnchors(section, format) {
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

function extractNumberedReferences(lines, format) {
  const pattern = REFERENCE_FORMAT_PATTERNS[format];
  if (!pattern) return [];

  const anchors = [];
  let currentAnchor = null;
  let currentLines = [];

  for (const line of lines) {
    const match = line.text.match(pattern);

    if (match) {
      if (currentAnchor && currentLines.length > 0) {
        finalizeAnchor(currentAnchor, currentLines, format);
        anchors.push(currentAnchor);
      }

      const refIndex = parseInt(match[1], 10);
      currentAnchor = {
        id: `ref-${refIndex}`,
        index: refIndex,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.y },
        endCoord: null,
        confidence: 0.7,
        formatHint: format,
        cachedText: null,
        authors: null,
        year: null,
        pageRanges: [],
      };
      currentLines = [line];
    } else if (currentAnchor) {
      currentLines.push(line);
    }
  }

  if (currentAnchor && currentLines.length > 0) {
    finalizeAnchor(currentAnchor, currentLines, format);
    anchors.push(currentAnchor);
  }

  return anchors;
}

function extractAuthorYearReferences(lines) {
  const anchors = [];
  let currentAnchor = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsWithAuthor = AUTHOR_YEAR_START_PATTERN.test(line.text);
    const previousEndsWithPeriod = i > 0 && /\.\s*$/.test(lines[i - 1].text);

    const isNewEntry =
      line.isAtLineStart &&
      (startsWithAuthor ||
        (previousEndsWithPeriod && /^[A-Z]/.test(line.text)));

    if (isNewEntry && currentLines.length > 0) {
      if (currentAnchor) {
        finalizeAnchor(currentAnchor, currentLines, "author-year");
        anchors.push(currentAnchor);
      }

      const parsed = parseAuthorYear(line.text);
      currentAnchor = {
        id: `ref-${parsed.authors?.split(/[,\s]/)[0]?.toLowerCase() || "unknown"}-${parsed.year || i}`,
        index: null,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.y },
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
      const parsed = parseAuthorYear(line.text);
      currentAnchor = {
        id: `ref-${parsed.authors?.split(/[,\s]/)[0]?.toLowerCase() || "unknown"}-${parsed.year || 0}`,
        index: null,
        pageNumber: line.pageNumber,
        startCoord: { x: line.x, y: line.y },
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

function extractHangingIndentReferences(lines) {
  const anchors = [];
  let currentAnchor = null;
  let currentLines = [];
  let refIndex = 0;

  for (const line of lines) {
    if (line.isAtLineStart) {
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

function extractFallbackReferences(lines) {
  const anchors = [];
  let currentLines = [];
  let refIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = lines[i - 1];

    const hasGap =
      prevLine &&
      (line.pageNumber !== prevLine.pageNumber ||
        Math.abs(line.y - prevLine.y) > prevLine.fontSize * 2.5);

    if (hasGap && currentLines.length > 0) {
      refIndex++;
      anchors.push(createBasicAnchor(currentLines, refIndex));
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

function createBasicAnchor(lines, index) {
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const text = lines.map((l) => l.text).join(" ");
  const parsed = parseAuthorYear(text);

  return {
    id: `ref-${index}`,
    index,
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

function finalizeAnchor(anchor, lines, format) {
  if (lines.length === 0) return;

  const lastLine = lines[lines.length - 1];
  const lastItem = lastLine.items?.[lastLine.items.length - 1];

  anchor.endCoord = {
    x: lastItem ? lastItem.x + lastItem.width : lastLine.x + 200,
    y: lastLine.originalY || lastLine.y,
  };

  anchor.pageRanges = buildPageRanges(lines);

  const text = lines
    .map((l) => l.text)
    .join(" ")
    .trim();
  anchor.cachedText = text;

  if (
    text.length >= MIN_REFERENCE_LENGTH &&
    text.length <= MAX_REFERENCE_LENGTH
  ) {
    anchor.confidence += 0.1;
  }
  if (YEAR_PATTERN.test(text)) anchor.confidence += 0.05;
  if (Object.values(REFERENCE_ENDING_PATTERNS).some((p) => p.test(text))) {
    anchor.confidence += 0.05;
  }

  anchor.confidence = Math.min(1, anchor.confidence);
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

function extractTextForAnchor(anchor, section) {
  if (anchor.cachedText) return anchor.cachedText;

  const relevantLines = section.lines.filter((line) => {
    if (line.pageNumber < anchor.pageNumber) return false;
    if (line.pageNumber > anchor.pageNumber) {
      return (
        anchor.endCoord &&
        line.pageNumber === anchor.endCoord.pageNumber &&
        (line.originalY || line.y) >= anchor.endCoord.y
      );
    }
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

export function findBoundingAnchors(anchors, pageNumber, x, y) {
  const pageAnchors = anchors.filter((a) => a.pageNumber === pageNumber);
  if (pageAnchors.length === 0) return { current: null, next: null };

  const sorted = [...pageAnchors].sort(
    (a, b) => b.startCoord.y - a.startCoord.y,
  );

  let current = null;
  let currentIndex = -1;
  let bestDist = Infinity;

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    const anchorY = anchor.startCoord.y;
    const endY = anchor.endCoord?.y ?? anchorY - 50;

    if (y <= anchorY && y >= endY) {
      const xDist = Math.abs(x - anchor.startCoord.x);
      if (xDist < bestDist) {
        bestDist = xDist;
        current = anchor;
        currentIndex = i;
      }
    } else {
      const yDist = Math.abs(y - anchorY);
      const xDist = Math.abs(x - anchor.startCoord.x);
      const dist = Math.sqrt(xDist * xDist + yDist * yDist);
      if (dist < bestDist) {
        bestDist = dist;
        current = anchor;
        currentIndex = i;
      }
    }
  }

  const next =
    currentIndex >= 0 && currentIndex < sorted.length - 1
      ? sorted[currentIndex + 1]
      : null;

  return { current, next };
}

export function findReferenceByIndex(anchors, index) {
  return anchors.find((a) => a.index === index) || null;
}
