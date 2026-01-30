/**
 * OutlineBuilder - Handles document outline extraction and heuristic generation
 * Refactored for @embedpdf/engines (PDFium)
 *
 * Supports two modes:
 * 1. Native PDF outline extraction from PDFium bookmarks (preferred)
 * 2. Heuristic outline generation from text analysis (fallback)
 *
 * @typedef {Object} OutlineItem
 * @property {string} id - Unique identifier
 * @property {string} title - Section title
 * @property {number} pageIndex - 0-based page index
 * @property {number} left - X position in PDF coordinates
 * @property {number} top - Y position in PDF coordinates
 * @property {number} columnIndex - Column index: -1 for full-width, 0 for left column, 1 for right, etc.
 * @property {OutlineItem[]} children - Child items
 */

import { COMMON_SECTION_NAMES, SECTION_NUMBER_STRIP } from "./lexicon.js";

/**
 * Build document outline from PDF metadata or heuristic analysis
 *
 * @param {import('@embedpdf/engines').PdfDocumentObject} pdfDoc - PDFium document
 * @param {import('@embedpdf/engines/pdfium').PdfiumNative} native - PDFium native API
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex - Built search index
 * @param {Map} allNamedDests - Pre-resolved named destinations
 * @returns {Promise<OutlineItem[]>}
 */
export async function buildOutline(pdfDoc, native, searchIndex, allNamedDests) {
  // Try native PDF outline first
  const nativeOutline = await extractPdfOutline(
    pdfDoc,
    native,
    searchIndex,
    allNamedDests,
  );

  if (nativeOutline && nativeOutline.length > 0) {
    // Handle single-root case (e.g., document title as root)
    // If there's only one top-level item with multiple children,
    // use the children as the top-level items
    if (nativeOutline.length === 1 && nativeOutline[0].children.length > 1) {
      console.log(
        "[Outline] Single root detected, promoting children to top level",
      );
      return nativeOutline[0].children;
    } else if (
      nativeOutline.length === 1 &&
      nativeOutline[0].children.length <= 1
    ) {
      console.log(
        "[Outline] PDF native outline unusable, building heuristic outline...",
      );
      return buildHeuristicOutline(searchIndex);
    }
    return nativeOutline;
  }

  // Fallback to heuristic outline generation
  console.log("[Outline] No PDF outline found, building heuristic outline...");
  return buildHeuristicOutline(searchIndex);
}

// ============================================
// Native PDF Outline Extraction (PDFium)
// ============================================

/**
 * Extract outline from PDF bookmarks using PDFium
 * @param {import('@embedpdf/engines').PdfDocumentObject} pdfDoc
 * @param {import('@embedpdf/engines/pdfium').PdfiumNative} native
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @param {Map} allNamedDests
 * @returns {Promise<OutlineItem[]>}
 */
async function extractPdfOutline(pdfDoc, native, searchIndex, allNamedDests) {
  if (!native || !pdfDoc) {
    return [];
  }

  try {
    const bookmarkTask = await native.getBookmarks(pdfDoc).toPromise();
    const bookmarks = bookmarkTask.bookmarks;
    if (!bookmarks || bookmarks.length === 0) {
      return [];
    }

    return processBookmarks(
      bookmarks,
      pdfDoc,
      native,
      searchIndex,
      allNamedDests,
    );
  } catch (error) {
    console.warn("[Outline] Error extracting PDF bookmarks:", error);
    return [];
  }
}

/**
 * Recursively process PDFium bookmarks into OutlineItems
 *
 * PDFium bookmark structure:
 * {
 *   title: string,
 *   dest: { pageIndex: number, left: number, top: number, zoom: number|null } | null,
 *   children: Bookmark[]
 * }
 *
 * @param {Array} bookmarks - PDFium bookmarks
 * @param {import('@embedpdf/engines').PdfDocumentObject} pdfDoc
 * @param {import('@embedpdf/engines/pdfium').PdfiumNative} native
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @param {Map} allNamedDests
 * @returns {Promise<OutlineItem[]>}
 */
async function processBookmarks(
  bookmarks,
  pdfDoc,
  native,
  searchIndex,
  allNamedDests,
) {
  const result = [];

  for (const bookmark of bookmarks) {
    // PDFium bookmarks have destination directly resolved
    const dest = resolveBookmarkDestination(bookmark, allNamedDests);

    // Estimate column index from left coordinate using searchIndex column data
    const columnIndex = estimateColumnFromPosition(
      dest?.pageIndex ?? 0,
      dest?.left ?? 0,
      searchIndex,
    );

    const outlineItem = {
      id: crypto.randomUUID(),
      title: bookmark.title || "Untitled",
      pageIndex: dest?.pageIndex ?? 0,
      left: dest?.left ?? 0,
      top: dest?.top ?? 0,
      columnIndex: columnIndex,
      children:
        bookmark.children && bookmark.children.length > 0
          ? await processBookmarks(
            bookmark.children,
            pdfDoc,
            native,
            searchIndex,
            allNamedDests,
          )
          : [],
    };
    result.push(outlineItem);
  }

  return result;
}

/**
 * Resolve destination from a PDFium bookmark
 * PDFium bookmarks typically have the destination already resolved
 * @param {Object} bookmark - PDFium bookmark
 * @param {Map} allNamedDests - Pre-resolved named destinations
 * @returns {{pageIndex: number, left: number, top: number}|null}
 */
function resolveBookmarkDestination(bookmark, allNamedDests) {
  if (bookmark.target.type !== "action") return null;
  const dest = bookmark.target.action.destination;
  if (dest && typeof dest === "object") {
    return {
      pageIndex: dest.pageIndex ?? 0,
      left: dest.view[0] ?? 0,
      top: dest.view[1] ?? 0,
    };
  }

  // Fall back to named destinations if dest is a string reference
  if (typeof dest === "string" && allNamedDests) {
    const resolved = allNamedDests.get(bookmark.dest);
    if (resolved) {
      return {
        pageIndex: resolved.pageIndex ?? 0,
        left: resolved.left ?? 0,
        top: resolved.top ?? 0,
      };
    }
  }

  return null;
}

/**
 * Estimate which column a position belongs to using searchIndex column data
 *
 * @param {number} pageIndex - 0-based page index
 * @param {number} leftX - X position in PDF coordinates
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {number} Column index: -1 for full-width/unknown, 0 for left, 1 for right, etc.
 */
function estimateColumnFromPosition(pageIndex, leftX, searchIndex) {
  if (!searchIndex?.isBuilt && !searchIndex?.hasPage?.(pageIndex + 1)) {
    return -1;
  }

  // Get column data for this page (1-based page number)
  const columnData = searchIndex.getColumnAwareLines?.(pageIndex + 1);
  if (!columnData || !columnData.columns || columnData.columns.length <= 1) {
    // Single column or no column data - treat as full-width
    return -1;
  }

  const columns = columnData.columns;

  // Find which column this X position falls into
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    // Allow some tolerance at column boundaries
    const tolerance = 5;
    if (leftX >= col.left - tolerance && leftX <= col.right + tolerance) {
      return i;
    }
  }

  // Position doesn't fall clearly into any column
  // Check if it's in the gap between columns (likely full-width content)
  if (columns.length >= 2) {
    const gap_start = columns[0].right;
    const gap_end = columns[1].left;
    if (leftX > gap_start && leftX < gap_end) {
      return -1; // In the gutter, treat as full-width
    }
  }

  // Fallback: estimate based on page width ratio
  const pageWidth = columnData.pageWidth;
  if (pageWidth > 0) {
    const ratio = leftX / pageWidth;
    if (ratio < 0.45) return 0;
    if (ratio > 0.55) return 1;
  }

  return -1;
}

// ============================================
// Heuristic Outline Generation
// ============================================

/**
 * Numbered section pattern
 * Matches: "1", "1.", "1.1", "1.1.1", "A.", "A.1", "I.", "II.", etc.
 * Must be followed by whitespace and a non-whitespace character
 */
const NUMBERED_SECTION_PATTERN =
  /^(\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLCDM]+\.)\s+\S/;

/**
 * Section number extraction pattern
 * Captures the numbering prefix
 */
const SECTION_NUMBER_EXTRACT = /^(\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLCDM]+\.)\s*/;

/**
 * Build outline from heuristic text analysis
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {OutlineItem[]}
 */
function buildHeuristicOutline(searchIndex) {
  if (!searchIndex) {
    console.warn(
      "[Outline] Search index not available, cannot generate heuristic outline",
    );
    return [];
  }

  // Step 1: Collect heading candidates from all pages
  const candidates = collectHeadingCandidates(searchIndex);

  console.log(`[Outline] Found ${candidates.length} heading candidates`);

  if (candidates.length === 0) {
    console.log("[Outline] No heading candidates found");
    return [];
  }

  // Step 2: Analyze and assign levels
  const leveledCandidates = assignHeadingLevels(candidates);

  // Step 3: Build tree structure
  const outline = buildOutlineTree(leveledCandidates);

  console.log(
    `[Outline] Heuristic outline built with ${outline.length} top-level items`,
  );
  return purgeReferenceChildren(outline);
}

/**
 * @typedef {Object} DocInfo
 * @property {number} fontSize
 * @property {string} fontName
 * @property {Map} pageData
 */

/**
 * Build deeply parsed document info
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {DocInfo} docInfo
 */
export function getDocInfo(searchIndex) {
  const numPages = searchIndex.getPageCount?.() || 60;

  // First pass: collect all lines and determine body text font size
  const allFontSizes = [];
  const allFontNames = [];
  const pageData = new Map(); // pageNum -> ColumnAwarePageData

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    // Use the column-aware API
    const columnData = searchIndex.getColumnAwareLines?.(pageNum);
    if (!columnData || columnData.segments.length === 0) continue;

    // Collect all lines from all segments
    const allLines = [];
    for (const segment of columnData.segments) {
      for (const line of segment.lines) {
        // Filter out arXiv identifiers
        if (line.text.startsWith("arXiv:")) continue;
        allLines.push(line);
      }
    }

    if (allLines.length === 0) continue;

    if (pageNum === 2) {
      console.log(
        `[Outline] Page 2: width=${columnData.pageWidth.toFixed(1)}, ` +
        `columns=${columnData.columns.length}, ` +
        `margins=[${columnData.marginLeft.toFixed(1)}, ${columnData.marginRight.toFixed(1)}]`,
      );
      if (columnData.columns.length > 1) {
        console.log(
          `[Outline] Column boundaries:`,
          columnData.columns
            .map((c) => `[${c.left.toFixed(1)}-${c.right.toFixed(1)}]`)
            .join(", "),
        );
      }
    }

    pageData.set(pageNum, { columnData, allLines });

    for (const line of allLines) {
      if (line.fontSize > 0) {
        allFontSizes.push(line.fontSize);
      }
      if (line.fontName) {
        allFontNames.push(line.fontName);
      }
    }
  }

  if (allFontSizes.length === 0) {
    return {
      fontSize: 10,
      fontName: null,
      pageData: new Map(),
    };
  }

  // Determine body text characteristics (most common)
  const bodyFontSize = findMostCommonFontSize(allFontSizes);
  const bodyFontName = findMostCommonFontName(allFontNames);

  console.log(
    `[Outline] Body text: fontSize=${bodyFontSize.toFixed(1)}, fontName=${bodyFontName}`,
  );

  return {
    fontSize: bodyFontSize,
    fontName: bodyFontName,
    pageData: pageData,
  };
}

/**
 * @typedef {Object} HeadingCandidate
 * @property {string} text - The heading text
 * @property {number} pageNumber - 1-based page number
 * @property {number} pageIndex - 0-based page index
 * @property {number} x - X position (PDF coords)
 * @property {number} y - Y position (PDF coords, from top)
 * @property {number} top - Original Y for navigation (PDF coords from bottom)
 * @property {number} fontSize - Font size
 * @property {string|null} fontName - Font name if available
 * @property {string|null} numberPrefix - Extracted number prefix (e.g., "1.1")
 * @property {number} numberDepth - Depth based on numbering (1, 2, 3...)
 * @property {boolean} isNumbered - Whether this has a number prefix
 * @property {number} columnIndex - -1 for full-width, 0 for col1, 1 for col2, etc.
 * @property {boolean} isFullWidth - Whether this line spans the full page width
 */

/**
 * Collect potential heading candidates from all pages
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {HeadingCandidate[]}
 */
function collectHeadingCandidates(searchIndex) {
  const candidates = [];
  const { fontSize, fontName, pageData } = getDocInfo(searchIndex);

  for (const [pageNum, data] of pageData) {
    const { columnData, allLines } = data;

    // For page 1: find where content actually starts
    // Skip title/author block by either finding "Abstract" or using top 30% threshold
    let skipThresholdY = 0;
    if (pageNum <= 2) {
      const pageHeight = columnData.pageHeight;
      const abstractLine = allLines.find(
        (line) =>
          isCommonSectionName(line.text) &&
          /^(?:\d+\.?\s+)?abstract/i.test(
            line.text.replace(SECTION_NUMBER_STRIP, "").trim(),
          ),
      );

      if (abstractLine) {
        skipThresholdY = abstractLine.y - 1;
      } else {
        skipThresholdY = pageHeight * 0.3;
      }
    }

    for (const line of allLines) {
      // Skip lines above the threshold on page 1 (title, authors, affiliations)
      if (pageNum === 1 && line.y < skipThresholdY) {
        continue;
      }

      const candidate = analyzeLineAsHeading(
        line,
        pageNum,
        fontSize,
        fontName,
        columnData,
      );
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

/**
 * Find the most common font size (body text)
 * @param {number[]} fontSizes
 * @returns {number}
 */
function findMostCommonFontSize(fontSizes) {
  // Round to 1 decimal place for grouping
  const rounded = fontSizes.map((s) => Math.round(s * 10) / 10);
  const counts = new Map();

  for (const size of rounded) {
    counts.set(size, (counts.get(size) || 0) + 1);
  }

  let maxCount = 0;
  let mostCommon = 10; // Default fallback

  for (const [size, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = size;
    }
  }

  return mostCommon;
}

/**
 * Find the most common font name (body text font)
 * @param {string[]} fontNames
 * @returns {string|null}
 */
function findMostCommonFontName(fontNames) {
  if (fontNames.length === 0) return null;

  const counts = new Map();

  for (const name of fontNames) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  let maxCount = 0;
  let mostCommon = fontNames[0];

  for (const [name, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = name;
    }
  }

  return mostCommon;
}

/**
 * Check if a font name indicates italic style
 * @param {string|null} fontName
 * @returns {boolean}
 */
function isItalicFont(fontName) {
  if (!fontName) return false;
  const lower = fontName.toLowerCase();
  return (
    lower.includes("italic") ||
    lower.includes("oblique") ||
    lower.includes("-it") ||
    lower.includes("_it") ||
    /[^a-z]it[^a-z]/.test(lower) ||
    lower.endsWith("it") ||
    lower.includes("slant")
  );
}

/**
 * Check if a font name indicates bold style
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
    // Computer Modern bold extended
    /cmbx/.test(lower) ||
    /cmb[^a-z]/.test(lower)
  );
}

function isFullWidthInColumn(line, columns) {
  const tolerance = 0.1;
  const column_width = columns.map((c) => c.right - c.left);
  const line_width = line.items.reduce((a, curr) => {
    return a + curr.width;
  }, 0);
  return line_width > column_width[line.columnIndex] * (1 - tolerance);
}

/**
 * Check if a line starts with a common academic section name.
 * @param {string} text - The line text to check
 * @returns {boolean}
 */
function isCommonSectionName(text) {
  if (!text || text.length < 2) return false;
  if (!/^[A-Z]/.test(text)) return false;

  // Strip leading section number and normalize
  const stripped = text.replace(SECTION_NUMBER_STRIP, "").trim().toLowerCase();
  if (stripped.length < 2) return false;

  if (COMMON_SECTION_NAMES.has(stripped)) return true;

  const maxCheckLength = 20;
  const checkText =
    stripped.length > maxCheckLength
      ? stripped.slice(0, maxCheckLength)
      : stripped;

  for (const name of COMMON_SECTION_NAMES) {
    if (
      checkText.length >= name.length &&
      checkText.startsWith(name) &&
      (checkText.length === name.length ||
        /^[\s:.\-–—]/.test(checkText[name.length]))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Analyze a line to determine if it's a heading candidate
 * @param {Object} line - Column-aware line data
 * @param {number} pageNum - 1-based page number
 * @param {number} bodyFontSize - Detected body text font size
 * @param {string|null} bodyFontName - Detected body text font name
 * @param {Object} columnData - Column-aware page data
 * @returns {HeadingCandidate|null}
 */
function analyzeLineAsHeading(
  line,
  pageNum,
  bodyFontSize,
  bodyFontName,
  columnData,
) {
  const text = line.text?.trim();
  if (!text || text.length < 2 || text.length > 150) {
    return null;
  }

  // Check for numbered section pattern
  const isNumbered = NUMBERED_SECTION_PATTERN.test(text);
  let numberPrefix = null;
  let numberDepth = 0;

  if (isNumbered) {
    const match = text.match(SECTION_NUMBER_EXTRACT);
    if (match) {
      numberPrefix = match[1].replace(/\s+$/, "");
      numberDepth = calculateNumberDepth(numberPrefix);
    }
  }

  // Font characteristics
  const fontSize = line.fontSize || 0;
  const fontName = line.fontName || null;

  const isLargerFont = fontSize > bodyFontSize * 1.05;
  const isSmallerFont = fontSize < bodyFontSize * 0.96;
  const isItalic = isItalicFont(fontName);
  const isBold = isBoldFont(fontName);
  const isDifferentFont = fontName && bodyFontName && fontName !== bodyFontName;

  const hasFontDifferentiation =
    isLargerFont || isItalic || isBold || isDifferentFont;
  const isAtColumnStart = line.isAtColumnStart === true;
  const isFullWidth = isFullWidthInColumn(line, columnData.columns);

  // For numbered sections: require column-start AND font differentiation
  if (isNumbered) {
    if (!isAtColumnStart) {
      return null;
    }

    const isClearSectionPattern = /^[\d\.*]+\s+[A-Z]/.test(text);
    if (!isClearSectionPattern) {
      return null;
    }

    if (isFullWidth) return null;
  }

  // For non-numbered headings: require larger font AND relatively short text
  const isNonNumberedHeading =
    !isNumbered && isLargerFont && text.length < 80 && isAtColumnStart;

  // Title case check for non-numbered
  const isTitleCaseHeading =
    !isNumbered &&
    !isSmallerFont &&
    isTitleCase(line.items[0]?.str || text) &&
    isAtColumnStart;

  const isCommonSectionHeading =
    isCommonSectionName(text) && hasFontDifferentiation;

  const isCandidate =
    isNumbered ||
    isNonNumberedHeading ||
    isTitleCaseHeading ||
    isCommonSectionHeading;

  if (!isCandidate) {
    return null;
  }

  let title = "";
  if (!isNumbered && isTitleCaseHeading) {
    title = line.items[0]?.str || text;
  } else if (isNumbered) {
    title = text.replace(SECTION_NUMBER_EXTRACT, "").trim() || text;
  } else {
    title = text;
  }

  // Skip if title is too short after cleanup
  if (title.length < 2) {
    return null;
  }

  return {
    text: text,
    title: numberPrefix ? `${numberPrefix} ${title}` : title,
    pageNumber: pageNum,
    pageIndex: pageNum - 1,
    x: line.x || 0,
    y: line.y || 0,
    top: line.originalY + fontSize || line.y || 0,
    fontSize: fontSize,
    fontName: fontName,
    numberPrefix: numberPrefix,
    numberDepth: numberDepth,
    isNumbered: isNumbered,
    columnIndex: line.columnIndex,
    isFullWidth: isFullWidth,
  };
}

/**
 * Calculate depth from number prefix
 * @param {string} prefix
 * @returns {number}
 */
function calculateNumberDepth(prefix) {
  if (!prefix) return 0;

  const dotCount = (prefix.match(/\./g) || []).length;

  if (dotCount === 0) {
    return 1;
  }

  const cleanPrefix = prefix.replace(/\.$/, "");
  const parts = cleanPrefix.split(".");
  return parts.length;
}

/**
 * Check if text is in title case
 * @param {string} text
 * @returns {boolean}
 */
function isTitleCase(text) {
  if (!text || text.length < 5) return false;

  const words = text.split(/\s+/);
  if (words.length < 2) return false;

  const upperWords = words.filter((w) => w.length > 0 && /^[A-Z]/.test(w));
  return upperWords.length >= words.length * 0.8;
}

/**
 * Assign heading levels based on numbering and font size
 * @param {HeadingCandidate[]} candidates
 * @returns {Array<HeadingCandidate & {level: number}>}
 */
function assignHeadingLevels(candidates) {
  if (candidates.length === 0) return [];

  const numbered = candidates.filter((c) => c.isNumbered);
  const nonNumbered = candidates.filter((c) => !c.isNumbered);

  const leveledNumbered = numbered.map((c) => ({
    ...c,
    level: c.numberDepth || 1,
  }));

  const leveledNonNumbered = assignLevelsByFontSize(nonNumbered);

  const all = [...leveledNumbered, ...leveledNonNumbered];

  all.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return a.y - b.y;
  });

  return all;
}

/**
 * Assign levels to non-numbered headings based on font size
 * @param {HeadingCandidate[]} candidates
 * @returns {Array<HeadingCandidate & {level: number}>}
 */
function assignLevelsByFontSize(candidates) {
  if (candidates.length === 0) return [];

  const uniqueSizes = [
    ...new Set(candidates.map((c) => Math.round(c.fontSize * 10) / 10)),
  ].sort((a, b) => b - a);

  const sizeToLevel = new Map();
  uniqueSizes.forEach((size, idx) => {
    sizeToLevel.set(size, idx + 1);
  });

  return candidates.map((c) => ({
    ...c,
    level: sizeToLevel.get(Math.round(c.fontSize * 10) / 10) || 1,
  }));
}

/**
 * Build tree structure from flat leveled candidates
 * @param {Array<HeadingCandidate & {level: number}>} candidates
 * @returns {OutlineItem[]}
 */
function buildOutlineTree(candidates) {
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex;
    }

    const colA = a.columnIndex === -1 ? -1 : a.columnIndex;
    const colB = b.columnIndex === -1 ? -1 : b.columnIndex;

    if (colA !== colB) {
      if (colA === -1 && colB !== -1) {
        return a.y - b.y < 0 ? -1 : 1;
      }
      if (colB === -1 && colA !== -1) {
        return b.y - a.y < 0 ? 1 : -1;
      }
      return colA - colB;
    }

    return a.y - b.y;
  });

  const root = { children: [] };
  const stack = [{ node: root, level: 0 }];

  for (const candidate of sorted) {
    const item = {
      id: crypto.randomUUID(),
      title: candidate.title,
      pageIndex: candidate.pageIndex,
      left: candidate.x,
      top: candidate.top,
      columnIndex: candidate.columnIndex ?? -1,
      children: [],
    };

    while (
      stack.length > 1 &&
      stack[stack.length - 1].level >= candidate.level
    ) {
      stack.pop();
    }

    stack[stack.length - 1].node.children.push(item);
    stack.push({ node: item, level: candidate.level });
  }

  return root.children;
}

/**
 * Remove children from reference sections
 * @param {OutlineItem[]} outline
 * @returns {OutlineItem[]}
 */
function purgeReferenceChildren(outline) {
  const REFERENCE_PATTERN =
    /^(?:\d+\.?\s+)?(?:references?|bibliography|works cited|citations?)$/i;

  function processNode(node) {
    const titleToCheck = node.title.replace(SECTION_NUMBER_STRIP, "").trim();
    if (REFERENCE_PATTERN.test(titleToCheck)) {
      node.children = [];
      return;
    }

    for (const child of node.children) {
      processNode(child);
    }
  }

  for (const item of outline) {
    processNode(item);
  }

  return outline;
}

// ============================================
// Document Metadata Detection (Title & Abstract)
// ============================================

/**
 * @typedef {Object} DetectedMetadata
 * @property {string|null} title - Detected document title
 * @property {Object|null} abstractInfo - Abstract section info
 */

/**
 * Detect document title and abstract from first 2 pages
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {DetectedMetadata}
 */
export function detectDocumentMetadata(searchIndex) {
  if (!searchIndex) {
    console.warn(
      "[Metadata] Search index not available, cannot detect metadata",
    );
    return { title: null, abstractInfo: null };
  }

  const result = { title: null, abstractInfo: null };

  // Collect lines from first 2 pages
  const pagesToScan = Math.min(2, searchIndex.getPageCount?.() || 2);
  const allLines = [];
  const allFontSizes = [];

  for (let pageNum = 0; pageNum <= pagesToScan; pageNum++) {
    const columnData = searchIndex.getColumnAwareLines?.(pageNum);
    if (!columnData || columnData.segments.length === 0) continue;

    for (const segment of columnData.segments) {
      for (const line of segment.lines) {
        if (!line.text || line.text.trim().length < 2) continue;
        if (line.text.startsWith("arXiv:")) continue;

        allLines.push({
          ...line,
          pageNum,
          pageHeight: columnData.pageHeight,
        });

        if (line.fontSize > 0) {
          allFontSizes.push(line.fontSize);
        }
      }
    }
  }

  if (allLines.length === 0) {
    return result;
  }

  const bodyFontSize = findMostCommonFontSize(allFontSizes);

  result.title = detectTitle(allLines, bodyFontSize);
  result.abstractInfo = detectAbstract(allLines, bodyFontSize);

  console.log(
    `[Metadata] Detected title: "${result.title?.substring(0, 50)}${result.title?.length > 50 ? "..." : ""}"`,
  );
  console.log(
    `[Metadata] Abstract found: ${result.abstractInfo ? `page ${result.abstractInfo.pageIndex + 1}` : "no"}`,
  );

  return result;
}

/**
 * Detect document title from the first page
 * @param {Array} allLines
 * @param {number} bodyFontSize
 * @returns {string|null}
 */
function detectTitle(allLines, bodyFontSize) {
  const page1Lines = allLines.filter((line) => line.pageNum === 1);
  if (page1Lines.length === 0) return null;

  const pageHeight = page1Lines[0]?.pageHeight || 792;
  const topThreshold = pageHeight * 0.4;
  const titleCandidates = page1Lines.filter((line) => line.y < topThreshold);

  if (titleCandidates.length === 0) return null;

  const largeFontThreshold = bodyFontSize * 1.2;
  const largeFontLines = titleCandidates.filter(
    (line) => line.fontSize >= largeFontThreshold,
  );

  if (largeFontLines.length === 0) {
    const sortedBySize = [...titleCandidates].sort(
      (a, b) => (b.fontSize || 0) - (a.fontSize || 0),
    );
    if (sortedBySize.length > 0 && sortedBySize[0].fontSize > bodyFontSize) {
      return cleanTitleText(sortedBySize[0].text);
    }
    return null;
  }

  largeFontLines.sort((a, b) => {
    const positionDiff = a.y - b.y;
    if (Math.abs(positionDiff) > 5) return positionDiff;
    return (b.fontSize || 0) - (a.fontSize || 0);
  });

  const maxFontSize = Math.max(...largeFontLines.map((l) => l.fontSize || 0));

  const titleLines = [];
  let foundTitleBlock = false;

  for (const line of largeFontLines) {
    const isMaxFont = Math.abs(line.fontSize - maxFontSize) < 0.5;

    if (isMaxFont) {
      if (/^\d+\.?\s*$/.test(line.text.trim())) continue;

      const lowerText = line.text.toLowerCase().trim();
      if (
        lowerText === "abstract" ||
        lowerText === "introduction" ||
        lowerText.startsWith("chapter ")
      ) {
        continue;
      }

      titleLines.push(line);
      foundTitleBlock = true;
    } else if (foundTitleBlock) {
      break;
    }
  }

  if (titleLines.length === 0) return null;

  titleLines.sort((a, b) => a.y - b.y);

  let title = "";
  for (let i = 0; i < titleLines.length; i++) {
    const line = titleLines[i];
    const text = line.text.trim();

    if (i === 0) {
      title = text;
    } else {
      if (title.endsWith("-")) {
        title = title.slice(0, -1) + text;
      } else {
        title += " " + text;
      }
    }
  }

  return cleanTitleText(title);
}

/**
 * Clean up detected title text
 * @param {string} text
 * @returns {string|null}
 */
function cleanTitleText(text) {
  if (!text) return null;

  let cleaned = text.trim();
  cleaned = cleaned.replace(/\*+$/, "").trim();
  cleaned = cleaned.replace(/^(title:\s*)/i, "").trim();

  if (cleaned.length < 5) return null;
  if (!/[a-zA-Z]{3,}/.test(cleaned)) return null;

  return cleaned;
}

/**
 * Detect abstract section
 * @param {Array} allLines
 * @param {number} bodyFontSize
 * @returns {Object|null}
 */
function detectAbstract(allLines, bodyFontSize) {
  for (const line of allLines) {
    const text = line.text?.trim() || "";

    const stripped = text.replace(SECTION_NUMBER_STRIP, "").trim();
    const lowerStripped = stripped.toLowerCase();

    if (
      lowerStripped === "abstract" ||
      lowerStripped === "abstract:" ||
      lowerStripped === "abstract." ||
      /^abstract\s*[-–—]\s*/i.test(stripped)
    ) {
      const isLarger = line.fontSize > bodyFontSize * 1.05;
      const fontName = line.fontName || "";
      const isBoldFont =
        fontName.toLowerCase().includes("bold") ||
        fontName.toLowerCase().includes("black") ||
        /cmbx/.test(fontName.toLowerCase());

      if (isLarger || isBoldFont || lowerStripped === "abstract") {
        return {
          pageIndex: line.pageNum - 1,
          top: line.originalY || line.y || 0,
          left: line.x || 0,
          columnIndex: line.columnIndex ?? -1,
        };
      }
    }
  }

  return null;
}
