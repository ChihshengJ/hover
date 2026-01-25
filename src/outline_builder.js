/**
 * OutlineBuilder - Handles document outline extraction and heuristic generation
 *
 * Supports two modes:
 * 1. Native PDF outline extraction (preferred)
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

/**
 * Build document outline from PDF metadata or heuristic analysis
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc - PDF.js document
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex - Built search index
 * @param {Object} allNamedDests - Pre-resolved named destinations
 * @returns {Promise<OutlineItem[]>}
 */

import { COMMON_SECTION_NAMES, SECTION_NUMBER_STRIP } from "./lexicon.js";

export async function buildOutline(pdfDoc, searchIndex, allNamedDests) {
  // Try native PDF outline first
  const nativeOutline = await extractPdfOutline(
    pdfDoc,
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
    } else if (nativeOutline.length === 1) {
      console.log(
        "[Outline] No PDF native outline unusable, building heuristic outline...",
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
// Native PDF Outline Extraction
// ============================================

/**
 * Extract outline from PDF metadata
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @param {Object} allNamedDests
 * @returns {Promise<OutlineItem[]>}
 */
async function extractPdfOutline(pdfDoc, searchIndex, allNamedDests) {
  const outline = await pdfDoc.getOutline();
  if (!outline || outline.length === 0) {
    return [];
  }

  return processOutlineItems(outline, pdfDoc, searchIndex, allNamedDests);
}

/**
 * Recursively process PDF outline items
 * @param {Array} items - PDF.js outline items
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @param {Object} allNamedDests
 * @returns {Promise<OutlineItem[]>}
 */
async function processOutlineItems(items, pdfDoc, searchIndex, allNamedDests) {
  const result = [];

  for (const item of items) {
    const dest = await resolveDestination(item.dest, pdfDoc, allNamedDests);

    // Estimate column index from left coordinate using searchIndex column data
    const columnIndex = estimateColumnFromPosition(
      dest?.pageIndex ?? 0,
      dest?.left ?? 0,
      searchIndex,
    );

    const outlineItem = {
      id: crypto.randomUUID(),
      title: item.title,
      pageIndex: dest?.pageIndex ?? 0,
      left: dest?.left ?? 0,
      top: dest?.top ?? 0,
      columnIndex: columnIndex,
      children: item.items
        ? await processOutlineItems(
          item.items,
          pdfDoc,
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
 * Estimate which column a position belongs to using searchIndex column data
 *
 * @param {number} pageIndex - 0-based page index
 * @param {number} leftX - X position in PDF coordinates
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {number} Column index: -1 for full-width/unknown, 0 for left, 1 for right, etc.
 */
function estimateColumnFromPosition(pageIndex, leftX, searchIndex) {
  if (!searchIndex?.isBuilt) return -1;

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

/**
 * Resolve a PDF destination to page coordinates
 * @param {string|Array} dest - Destination reference
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {Object} allNamedDests
 * @returns {Promise<{pageIndex: number, left: number, top: number}|null>}
 */
async function resolveDestination(dest, pdfDoc, allNamedDests) {
  try {
    let explicitDest = dest;

    if (typeof dest === "string") {
      explicitDest = allNamedDests?.[dest];
      if (!explicitDest) {
        explicitDest = await pdfDoc.getDestination(dest);
      }
    }

    if (!Array.isArray(explicitDest)) return null;

    const [ref, , left, top] = explicitDest;
    const pageIndex = await pdfDoc.getPageIndex(ref);

    return {
      pageIndex,
      left: left ?? 0,
      top: top ?? 0,
    };
  } catch (error) {
    return null;
  }
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
  if (!searchIndex?.isBuilt) {
    console.warn(
      "[Outline] Search index not built, cannot generate heuristic outline",
    );
    return [];
  }

  // Step 1: Collect heading candidates from all pages
  const candidates = collectHeadingCandidates(searchIndex);

  console.log(`[Outline] Found ${candidates.length} heading candidates`);
  // if (candidates.length > 0) {
  //   // Log first few for debugging
  //   for (const c of candidates) {
  //     console.log(
  //       `[Outline]   - "${c.title.substring(0, 50)}" (page ${c.pageNumber}, x=${c.x.toFixed(1)}, numbered=${c.isNumbered})`,
  //     );
  //   }
  // }

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
  const numPages = searchIndex.getPageCount?.() || 60;

  // First pass: collect all lines and determine body text font size
  const allFontSizes = [];
  const allFontNames = [];
  const pageData = new Map(); // pageNum -> ColumnAwarePageData

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    // Use the new column-aware API
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

    // Debug: log dimensions for first page
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
    return [];
  }

  // Determine body text characteristics (most common)
  const bodyFontSize = findMostCommonFontSize(allFontSizes);
  const bodyFontName = findMostCommonFontName(allFontNames);

  console.log(
    `[Outline] Body text: fontSize=${bodyFontSize.toFixed(1)}, fontName=${bodyFontName}`,
  );

  // Second pass: identify heading candidates with stricter criteria
  for (const [pageNum, data] of pageData) {
    const { columnData, allLines } = data;

    // For page 1: find where content actually starts
    // Skip title/author block by either finding "Abstract" or using top 30% threshold
    let skipThresholdY = 0;
    if (pageNum === 1) {
      const pageHeight = columnData.pageHeight;
      const abstractLine = allLines.find(
        (line) =>
          isCommonSectionName(line.text) &&
          /^(?:\d+\.?\s+)?abstract/i.test(
            line.text.replace(SECTION_NUMBER_STRIP, "").trim(),
          ),
      );

      if (abstractLine) {
        // Start from the abstract line (allow it through)
        skipThresholdY = abstractLine.y - 1;
      } else {
        // Fallback: skip top 30% of first page
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
        bodyFontSize,
        bodyFontName,
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
    /[^a-z]it[^a-z]/.test(lower) || // "it" surrounded by non-letters
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
 * This is used to identify section headings even without font differentiation.
 *
 * @param {string} text - The line text to check
 * @returns {boolean} True if the line starts with a known section name
 */
function isCommonSectionName(text) {
  if (!text || text.length < 2) return false;
  if (!/^[A-Z]/.test(text)) return false;

  // Strip leading section number and normalize
  const stripped = text.replace(SECTION_NUMBER_STRIP, "").trim().toLowerCase();
  if (stripped.length < 2) return false;

  if (COMMON_SECTION_NAMES.has(stripped)) return true;

  const maxCheckLength = 20; // Longest section names are ~30 chars
  const checkText =
    stripped.length > maxCheckLength
      ? stripped.slice(0, maxCheckLength)
      : stripped;

  for (const name of COMMON_SECTION_NAMES) {
    if (
      checkText.length >= name.length &&
      checkText.startsWith(name) &&
      (checkText.length === name.length ||
        /^[\s:.\-â€”â€“]/.test(checkText[name.length]))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Analyze a line to determine if it's a heading candidate
 *
 * For numbered sections, requires:
 * 1. Line starts at column/page margin (left-aligned) - uses isAtColumnStart from column detection
 * 2. Font is either italic, bold, or larger than body text
 *
 * @param {Object} line - Column-aware line data from SearchIndex.getColumnAwareLines()
 * @param {number} pageNum - 1-based page number
 * @param {number} bodyFontSize - Detected body text font size
 * @param {string|null} bodyFontName - Detected body text font name
 * @param {Object} columnData - Column-aware page data from getColumnAwareLines()
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

  const isLargerFont = fontSize > bodyFontSize * 1.05; // 3% larger than body
  const isSmallerFont = fontSize < bodyFontSize * 0.96; // 4& smaller than body
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
      // Not at column start - reject as likely in-text reference
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
    // isDifferentFont &&
    !isSmallerFont &&
    isTitleCase(line.items[0].str) &&
    isAtColumnStart;

  const isCommonSectionHeading =
    isCommonSectionName(text) && hasFontDifferentiation;

  const isCandidate =
    isNumbered ||
    isNonNumberedHeading ||
    isTitleCaseHeading ||
    isCommonSectionHeading;

  console.log({ text, fontSize, fontName, isNumbered, isNonNumberedHeading, isTitleCaseHeading, isCommonSectionHeading });

  if (!isCandidate) {
    return null;
  }

  let title = "";
  if (!isNumbered && isTitleCaseHeading) {
    title = line.items[0].str;
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
 * "1" -> 1, "1.1" -> 2, "1.1.1" -> 3, "A." -> 1
 * @param {string} prefix
 * @returns {number}
 */
function calculateNumberDepth(prefix) {
  if (!prefix) return 0;

  // Count dots for hierarchical numbering
  const dotCount = (prefix.match(/\./g) || []).length;

  // For single numbers/letters: depth 1
  // For "1.1": depth 2, etc.
  if (dotCount === 0) {
    return 1;
  }

  // "1." has 1 dot but is depth 1
  // "1.1" has 1 dot but is depth 2
  // "1.1." has 2 dots but is depth 2
  // "1.1.1" has 2 dots but is depth 3

  const cleanPrefix = prefix.replace(/\.$/, ""); // Remove trailing dot
  const parts = cleanPrefix.split(".");
  return parts.length;
}

/**
 * Check if text is in title case
 * @param {string} text
 * @returns {boolean}
 */
function isTitleCase(text) {
  // Skip very short text
  if (text.length < 5) return false;

  const words = text.split(/\s+/);
  if (words.length < 2) return false;

  // Check if most words start with uppercase
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

  // Separate numbered and non-numbered candidates
  const numbered = candidates.filter((c) => c.isNumbered);
  const nonNumbered = candidates.filter((c) => !c.isNumbered);

  // For numbered candidates, use numberDepth as level
  const leveledNumbered = numbered.map((c) => ({
    ...c,
    level: c.numberDepth || 1,
  }));

  // For non-numbered, determine level from font size
  const leveledNonNumbered = assignLevelsByFontSize(nonNumbered);

  // Combine and sort by page position
  const all = [...leveledNumbered, ...leveledNonNumbered];

  all.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return a.y - b.y; // Top to bottom within page
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

  // Get unique font sizes, sorted descending
  const uniqueSizes = [
    ...new Set(candidates.map((c) => Math.round(c.fontSize * 10) / 10)),
  ].sort((a, b) => b - a);

  // Map font size to level (largest = 1)
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
 * Candidates are sorted in reading order: page #’ column #’ top position
 * @param {Array<HeadingCandidate & {level: number}>} candidates
 * @returns {OutlineItem[]}
 */
function buildOutlineTree(candidates) {
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => {
    // First: sort by page
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex;
    }

    // Second: sort by column index
    // Treat full-width (-1) as coming before column content at same position
    // or use a normalized column index where -1 maps based on y position
    const colA = a.columnIndex === -1 ? -1 : a.columnIndex;
    const colB = b.columnIndex === -1 ? -1 : b.columnIndex;

    if (colA !== colB) {
      // Full-width (-1) items should be ordered by their y position relative to column items
      // If one is full-width and one is in a column, full-width comes first if it's above
      if (colA === -1 && colB !== -1) {
        // a is full-width: if a is above b, a comes first; otherwise sort by y
        return a.y - b.y < 0 ? -1 : 1;
      }
      if (colB === -1 && colA !== -1) {
        // b is full-width: if b is above a, b comes first; otherwise sort by y
        return b.y - a.y < 0 ? 1 : -1;
      }
      // Both are in columns: lower column index first
      return colA - colB;
    }

    // Third: sort by y position (top of page = smaller y)
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
 * @param {OutlineItem[]} outline - The outline tree
 * @returns {OutlineItem[]} - Modified outline with reference children purged
 */
function purgeReferenceChildren(outline) {
  const REFERENCE_PATTERN = /^(?:\d+\.?\s+)?(?:references?|bibliography|works cited|citations?)$/i;
  
  function processNode(node) {
    // Check if this node is a references section
    const titleToCheck = node.title.replace(SECTION_NUMBER_STRIP, '').trim();
    if (REFERENCE_PATTERN.test(titleToCheck)) {
      node.children = [];
      return;
    }
    
    // Recursively process children
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
 * @property {number} abstractInfo.pageIndex - 0-based page index
 * @property {number} abstractInfo.top - Y position in PDF coordinates
 * @property {number} abstractInfo.left - X position in PDF coordinates
 * @property {number} abstractInfo.columnIndex - Column index
 */

/**
 * Detect document title and abstract from first 2 pages
 * Uses font size analysis to identify the title (largest text near top of page 1)
 * and locates the abstract section.
 *
 * @param {import('./controls/search/search_index.js').SearchIndex} searchIndex
 * @returns {DetectedMetadata}
 */
export function detectDocumentMetadata(searchIndex) {
  if (!searchIndex?.isBuilt) {
    console.warn("[Metadata] Search index not built, cannot detect metadata");
    return { title: null, abstractInfo: null };
  }

  const result = { title: null, abstractInfo: null };

  // Collect lines from first 2 pages
  const pagesToScan = Math.min(2, searchIndex.getPageCount?.() || 2);
  const allLines = [];
  const allFontSizes = [];

  for (let pageNum = 1; pageNum <= pagesToScan; pageNum++) {
    const columnData = searchIndex.getColumnAwareLines?.(pageNum);
    if (!columnData || columnData.segments.length === 0) continue;

    for (const segment of columnData.segments) {
      for (const line of segment.lines) {
        if (!line.text || line.text.trim().length < 2) continue;
        // Skip arXiv identifiers
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

  // Find body text font size for comparison
  const bodyFontSize = findMostCommonFontSize(allFontSizes);

  // Detect title from page 1
  result.title = detectTitle(allLines, bodyFontSize);

  // Detect abstract
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
 * Title is typically: largest font, near top, possibly bold, not a section header
 *
 * @param {Array} allLines - Lines from first 2 pages
 * @param {number} bodyFontSize - Body text font size for comparison
 * @returns {string|null}
 */
function detectTitle(allLines, bodyFontSize) {
  // Filter to page 1 only, top portion
  const page1Lines = allLines.filter((line) => line.pageNum === 1);
  if (page1Lines.length === 0) return null;

  const pageHeight = page1Lines[0]?.pageHeight || 792;

  // Look at top 40% of page 1 for title candidates
  const topThreshold = pageHeight * 0.4;
  const titleCandidates = page1Lines.filter((line) => {
    // y is distance from top in the line data
    return line.y < topThreshold;
  });

  if (titleCandidates.length === 0) return null;

  // Find lines with font size significantly larger than body text
  const largeFontThreshold = bodyFontSize * 1.2; // At least 20% larger
  const largeFontLines = titleCandidates.filter(
    (line) => line.fontSize >= largeFontThreshold,
  );

  if (largeFontLines.length === 0) {
    // No obviously large text - try finding the largest text in top area
    const sortedBySize = [...titleCandidates].sort(
      (a, b) => (b.fontSize || 0) - (a.fontSize || 0),
    );
    if (sortedBySize.length > 0 && sortedBySize[0].fontSize > bodyFontSize) {
      return cleanTitleText(sortedBySize[0].text);
    }
    return null;
  }

  // Sort by position (top to bottom) then by font size (largest first)
  largeFontLines.sort((a, b) => {
    // Primary: position (earlier/higher on page first)
    const positionDiff = a.y - b.y;
    if (Math.abs(positionDiff) > 5) return positionDiff;
    // Secondary: larger font first
    return (b.fontSize || 0) - (a.fontSize || 0);
  });

  // Find the largest font size among candidates
  const maxFontSize = Math.max(...largeFontLines.map((l) => l.fontSize || 0));

  // Collect all lines with the max font size (title may span multiple lines)
  const titleLines = [];
  let foundTitleBlock = false;

  for (const line of largeFontLines) {
    // Check if this line has the max font size (with some tolerance)
    const isMaxFont = Math.abs(line.fontSize - maxFontSize) < 0.5;

    if (isMaxFont) {
      // Skip if this looks like a section number only
      if (/^\d+\.?\s*$/.test(line.text.trim())) continue;

      // Skip common non-title patterns
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
      // We've moved past the title block
      break;
    }
  }

  if (titleLines.length === 0) return null;

  // Sort title lines by position and combine
  titleLines.sort((a, b) => a.y - b.y);

  // Combine lines, being smart about line breaks
  let title = "";
  for (let i = 0; i < titleLines.length; i++) {
    const line = titleLines[i];
    const text = line.text.trim();

    if (i === 0) {
      title = text;
    } else {
      // Check if previous line ended with hyphen (word continuation)
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
 * @returns {string}
 */
function cleanTitleText(text) {
  if (!text) return null;

  let cleaned = text.trim();

  // Remove trailing asterisks (footnote markers)
  cleaned = cleaned.replace(/\*+$/, "").trim();

  // Remove common prefixes
  cleaned = cleaned.replace(/^(title:\s*)/i, "").trim();

  // Skip if too short or looks like noise
  if (cleaned.length < 5) return null;

  // Skip if it's all numbers/symbols
  if (!/[a-zA-Z]{3,}/.test(cleaned)) return null;

  return cleaned;
}

/**
 * Detect abstract section
 *
 * @param {Array} allLines - Lines from first 2 pages
 * @param {number} bodyFontSize - Body text font size for comparison
 * @returns {Object|null} - {pageIndex, top, left, columnIndex} or null
 */
function detectAbstract(allLines, bodyFontSize) {
  // Look for "Abstract" heading
  for (const line of allLines) {
    const text = line.text?.trim() || "";

    // Check for abstract heading patterns
    // Could be: "Abstract", "ABSTRACT", "1. Abstract", "Abstract:", etc.
    const stripped = text.replace(SECTION_NUMBER_STRIP, "").trim();
    const lowerStripped = stripped.toLowerCase();

    if (
      lowerStripped === "abstract" ||
      lowerStripped === "abstract:" ||
      lowerStripped === "abstract." ||
      /^abstract\s*[-–—]\s*/i.test(stripped)
    ) {
      // Check if it has some font differentiation (bold, larger, etc.)
      const isLarger = line.fontSize > bodyFontSize * 1.05;
      const fontName = line.fontName || "";
      const isBoldFont =
        fontName.toLowerCase().includes("bold") ||
        fontName.toLowerCase().includes("black") ||
        /cmbx/.test(fontName.toLowerCase());

      // Accept if it has font differentiation OR is clearly labeled
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
