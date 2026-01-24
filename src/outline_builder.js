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
  const nativeOutline = await extractPdfOutline(pdfDoc, allNamedDests);

  if (nativeOutline && nativeOutline.length > 0) {
    // Handle single-root case (e.g., document title as root)
    // If there's only one top-level item with multiple children,
    // use the children as the top-level items
    if (nativeOutline.length === 1 && nativeOutline[0].children.length > 1) {
      console.log(
        "[Outline] Single root detected, promoting children to top level",
      );
      return nativeOutline[0].children;
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
 * @param {Object} allNamedDests
 * @returns {Promise<OutlineItem[]>}
 */
async function extractPdfOutline(pdfDoc, allNamedDests) {
  const outline = await pdfDoc.getOutline();
  if (!outline || outline.length === 0) {
    return [];
  }

  return processOutlineItems(outline, pdfDoc, allNamedDests);
}

/**
 * Recursively process PDF outline items
 * @param {Array} items - PDF.js outline items
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {Object} allNamedDests
 * @returns {Promise<OutlineItem[]>}
 */
async function processOutlineItems(items, pdfDoc, allNamedDests) {
  const result = [];

  for (const item of items) {
    const dest = await resolveDestination(item.dest, pdfDoc, allNamedDests);
    const outlineItem = {
      id: crypto.randomUUID(),
      title: item.title,
      pageIndex: dest?.pageIndex ?? 0,
      left: dest?.left ?? 0,
      top: dest?.top ?? 0,
      children: item.items
        ? await processOutlineItems(item.items, pdfDoc, allNamedDests)
        : [],
    };
    result.push(outlineItem);
  }

  return result;
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
  if (candidates.length > 0) {
    // Log first few for debugging
    for (const c of candidates) {
      console.log(
        `[Outline]   - "${c.title.substring(0, 50)}" (page ${c.pageNumber}, x=${c.x.toFixed(1)}, numbered=${c.isNumbered})`,
      );
    }
  }

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
  return outline;
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
    if (pageNum === 1) {
      console.log(`[Outline] Page 1: width=${columnData.pageWidth.toFixed(1)}, ` +
        `columns=${columnData.columns.length}, ` +
        `margins=[${columnData.marginLeft.toFixed(1)}, ${columnData.marginRight.toFixed(1)}]`);
      if (columnData.columns.length > 1) {
        console.log(`[Outline] Column boundaries:`, 
          columnData.columns.map(c => `[${c.left.toFixed(1)}-${c.right.toFixed(1)}]`).join(', '));
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
  
  console.log(`[Outline] Body text: fontSize=${bodyFontSize.toFixed(1)}, fontName=${bodyFontName}`);
  
  // Second pass: identify heading candidates with stricter criteria
  for (const [pageNum, data] of pageData) {
    const { columnData, allLines } = data;
    
    // For page 1: find where content actually starts
    // Skip title/author block by either finding "Abstract" or using top 30% threshold
    let skipThresholdY = 0;
    if (pageNum === 1) {
      const pageHeight = columnData.pageHeight;
      const abstractLine = allLines.find(line => 
        isCommonSectionName(line.text) && 
        /^(?:\d+\.?\s+)?abstract/i.test(line.text.replace(SECTION_NUMBER_STRIP, '').trim())
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
        columnData
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
        /^[\s:.\-—–]/.test(checkText[name.length]))
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
  const isItalic = isItalicFont(fontName);
  const isBold = isBoldFont(fontName);
  const isDifferentFont = fontName && bodyFontName && fontName !== bodyFontName;

  const hasFontDifferentiation = isLargerFont || isItalic || isBold || isDifferentFont;
  const isAtColumnStart = line.isAtColumnStart === true;
  const isFullWidth = isFullWidthInColumn(line, columnData.columns);

  // For numbered sections: require column-start AND font differentiation
  if (isNumbered) {
    if (!isAtColumnStart) {
      // Not at column start - reject as likely in-text reference
      return null;
    }

    if (!hasFontDifferentiation) {
      // No font differentiation - could be a list item or table entry
      // Allow only if it's a very clear section pattern (single digit with period and space)
      const isClearSectionPattern = /[^\d\.*]+\s+[A-Z]/.test(text);
      if (!isClearSectionPattern) {
        return null;
      }
    }

    if (isFullWidth) return null;
    console.log(text);

    if (!isLargerFont && !hasFontDifferentiation) return null;
  }

  // For non-numbered headings: require larger font AND relatively short text
  const isNonNumberedHeading =
    !isNumbered && isLargerFont && text.length < 80 && isAtColumnStart;

  // Title case check for non-numbered
  const isTitleCaseHeading =
    !isNumbered && isLargerFont && isTitleCase(text) && isAtColumnStart;

  const isCommonSectionHeading = isCommonSectionName(text) && hasFontDifferentiation;

  const isCandidate =
    isNumbered ||
    isNonNumberedHeading ||
    isTitleCaseHeading ||
    isCommonSectionHeading;

  if (!isCandidate) {
    return null;
  }

  // Extract clean title (remove number prefix for display)
  const title = isNumbered
    ? text.replace(SECTION_NUMBER_EXTRACT, "").trim() || text
    : text;

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
    top: line.originalY || line.y || 0,
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
  return upperWords.length >= words.length * 0.6;
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
 * Handles multi-column layouts by processing columns left-to-right, top-to-bottom
 * @param {Array<HeadingCandidate & {level: number}>} candidates
 * @returns {OutlineItem[]}
 */
function buildOutlineTree(candidates) {
  if (candidates.length === 0) return [];

  // Group candidates by page to determine column thresholds per page
  const candidatesByPage = new Map();
  for (const candidate of candidates) {
    if (!candidatesByPage.has(candidate.pageIndex)) {
      candidatesByPage.set(candidate.pageIndex, []);
    }
    candidatesByPage.get(candidate.pageIndex).push(candidate);
  }

  // Determine column threshold for each page by finding the largest x-gap
  const pageColumnThresholds = new Map();
  for (const [pageIndex, pageCandidates] of candidatesByPage) {
    const xPositions = pageCandidates.map(c => c.x).sort((a, b) => a - b);

    if (xPositions.length >= 2) {
      // Find the largest gap in x positions - that's likely the column gutter
      let maxGap = 0;
      let threshold = null;

      for (let i = 0; i < xPositions.length - 1; i++) {
        const gap = xPositions[i + 1] - xPositions[i];
        if (gap > maxGap) {
          maxGap = gap;
          threshold = (xPositions[i] + xPositions[i + 1]) / 2;
        }
      }

      // Only use threshold if gap is significant (>100pt suggests column gutter)
      // Typical column gutters are 20-40pt, but heading x-positions can vary more
      if (maxGap > 100) {
        pageColumnThresholds.set(pageIndex, threshold);
      }
    }
  }

  // Sort candidates by: page → column → vertical position
  const sortedCandidates = [...candidates].sort((a, b) => {
    // 1. Sort by page
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex;
    }

    // 2. Sort by column (if multi-column detected for this page)
    const threshold = pageColumnThresholds.get(a.pageIndex);
    if (threshold !== undefined) {
      const aColumn = a.x < threshold ? 0 : 1;
      const bColumn = b.x < threshold ? 0 : 1;

      if (aColumn !== bColumn) {
        return aColumn - bColumn;
      }
    }

    // 3. Sort by vertical position (y is from top, so lower y = higher on page)
    return a.y - b.y;
  });

  // Build tree structure from sorted candidates
  const root = { children: [] };
  const stack = [{ node: root, level: 0 }];

  for (const candidate of sortedCandidates) {
    const item = {
      id: crypto.randomUUID(),
      title: candidate.title,
      pageIndex: candidate.pageIndex,
      left: candidate.x,
      top: candidate.top,
      children: [],
    };

    // Find parent: pop stack until we find a node with lower level
    while (stack.length > 1 && stack[stack.length - 1].level >= candidate.level) {
      stack.pop();
    }

    // Add as child of current stack top
    stack[stack.length - 1].node.children.push(item);

    // Push this item onto stack
    stack.push({ node: item, level: candidate.level });
  }

  return root.children;
}
