/**
 * @typedef {Object} OutlineItem
 * @property {string} id
 * @property {string} title
 * @property {number} pageIndex - 0-based
 * @property {number} left
 * @property {number} top
 * @property {OutlineItem[]} children
 */

import { COMMON_SECTION_NAMES, SECTION_NUMBER_STRIP } from "./lexicon.js";
import { FontStyle } from "./text_index.js";

const NUMBERED_SECTION_PATTERN =
  /^(\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLCDM]+\.)\s+\S/;
const SECTION_NUMBER_EXTRACT = /^(\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLCDM]+\.)\s*/;

/**
 * Build document outline from PDF metadata or heuristic analysis
 */
export async function buildOutline(pdfDoc, native, textIndex, allNamedDests) {
  const nativeOutline = await extractPdfOutline(pdfDoc, native, allNamedDests);

  if (nativeOutline && nativeOutline.length > 0) {
    if (nativeOutline.length === 1 && nativeOutline[0].children.length > 1) {
      console.log("[Outline]Use Embeded Outline's root");
      return nativeOutline[0].children;
    } else if (
      nativeOutline.length === 1 &&
      nativeOutline[0].children.length <= 1
    ) {
      return buildHeuristicOutline(textIndex);
    }
    console.log("[Outline]Use Embeded Outlines");
    return nativeOutline;
  }

  return buildHeuristicOutline(textIndex);
}

async function extractPdfOutline(pdfDoc, native, allNamedDests) {
  if (!native || !pdfDoc) return [];

  try {
    const bookmarkTask = await native.getBookmarks(pdfDoc).toPromise();
    const bookmarks = bookmarkTask.bookmarks;
    if (!bookmarks?.length) return [];

    if (bookmarks.length === 1 && bookmarks[0].children) {
      return processBookmarks(bookmarks[0].children, allNamedDests);
    }

    return processBookmarks(bookmarks, allNamedDests);
  } catch (error) {
    console.warn("[Outline] Error extracting PDF bookmarks:", error);
    return [];
  }
}

function processBookmarks(bookmarks, allNamedDests) {
  const result = [];

  for (const bookmark of bookmarks) {
    const dest = resolveBookmarkDestination(bookmark, allNamedDests);

    result.push({
      id: crypto.randomUUID(),
      title: bookmark.title || "Untitled",
      pageIndex: dest?.pageIndex ?? 0,
      left: dest?.left ?? 0,
      top: dest?.top ?? 0,
      children: bookmark.children?.length
        ? processBookmarks(bookmark.children, allNamedDests)
        : [],
    });
  }

  return result;
}

function resolveBookmarkDestination(bookmark, allNamedDests) {
  let dest = null;
  if (bookmark.target.type === "action") {
    dest = bookmark.target.action.destination;
  } else if (bookmark.target.type === "destination") {
    dest = bookmark.target.destination;
  }
  if (!dest) return null;

  if (dest && typeof dest === "object") {
    return {
      pageIndex: dest.pageIndex ?? 0,
      left: dest.view[0] ?? 0,
      top: dest.view[1] ?? 0,
    };
  }

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

function buildHeuristicOutline(textIndex) {
  if (!textIndex) return [];

  const candidates = collectHeadingCandidates(textIndex);
  if (candidates.length === 0) return [];

  const leveledCandidates = assignHeadingLevels(candidates);
  const outline = buildOutlineTree(leveledCandidates);

  console.log("[Outline] Built heuristically Parsed Tree");
  return purgeReferenceChildren(outline);
}

/**
 * @typedef {Object} DocInfo
 * @property {number} fontSize
 * @property {number} fontStyle
 * @property {Map<number, {lines: Array}>} pageData
 */

export function getDocInfo(textIndex) {
  const numPages = textIndex.getPageCount?.() || 60;
  const pageData = new Map();

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const data = textIndex.getPageData?.(pageNum);
    if (!data || data.lines.length === 0) continue;

    const lines = data.lines.filter((line) => !line.text.startsWith("arXiv:"));
    if (lines.length === 0) continue;

    pageData.set(pageNum, {
      lines,
      pageWidth: data.pageWidth,
      pageHeight: data.pageHeight,
      marginLeft: data.marginLeft,
      marginBottom: data.marginBottom,
    });
  }

  return {
    fontSize: textIndex.getBodyFontSize(),
    fontStyle: textIndex.getBodyFontStyle(),
    lineHeight: textIndex.getBodyLineHeight(),
    marginBottom: textIndex.getBodyMarginBottom(),
    pageData,
  };
}

/**
 * @typedef {Object} HeadingCandidate
 * @property {string} text
 * @property {string} title
 * @property {number} pageNumber
 * @property {number} pageIndex
 * @property {number} x
 * @property {number} y
 * @property {number} top
 * @property {number} fontSize
 * @property {number} fontStyle
 * @property {string|null} numberPrefix
 * @property {number} numberDepth
 * @property {boolean} isNumbered
 */

function collectHeadingCandidates(textIndex) {
  const candidates = [];
  const {
    fontSize: bodyFontSize,
    fontStyle: bodyFontStyle,
    lineHeight: bodyLineHeight,
    pageData,
  } = getDocInfo(textIndex);

  let abstractLine = null;
  let startPage = 0;
  for (const [pageNum, data] of pageData) {
    if (pageNum > 2) break;
    const { lines, pageHeight, pageWidth } = data;

    abstractLine = lines.find((line) => {
      const text = line.text
        .replace(/\s+/, "")
        .replace(SECTION_NUMBER_STRIP, "")
        .trim();
      return /^(?:\d+\.?\s+)?abstract/i.test(text);
    });
    if (abstractLine) startPage = pageNum;
  }

  for (const [pageNum, data] of pageData) {
    if (pageNum < startPage) continue;
    const { lines, pageHeight, pageWidth } = data;
    const pageData = { pageHeight, pageWidth };

    const skipThresholdY = abstractLine ? abstractLine.y : pageHeight * 0.3;

    for (const line of lines) {
      if (abstractLine && line.y > skipThresholdY) continue;
      if (pageNum === 1 && line.y > skipThresholdY) continue;

      const candidate = analyzeLineAsHeading(
        line,
        pageNum,
        bodyFontSize,
        bodyLineHeight,
        pageData,
      );
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

function isCommonSectionName(text) {
  if (!text || text.length < 2 || !/^[A-Z]/.test(text)) return false;

  const stripped = text.replace(SECTION_NUMBER_STRIP, "").trim().toLowerCase();
  if (stripped.length < 2) return false;
  if (COMMON_SECTION_NAMES.has(stripped)) return true;

  return false;
}

function analyzeLineAsHeading(
  line,
  pageNum,
  bodyFontSize,
  bodyLineHeight,
  page,
) {
  const text = line.text?.trim();
  if (!text || text.length < 2 || text.length > 100) return null;

  const isNumbered = NUMBERED_SECTION_PATTERN.test(text);
  let numberPrefix = null;
  let numberDepth = 0;

  const weirdPosition =
    line.y < page.pageHeight * 0.08 || line.y > page.pageHeight * 0.95;
  const isTabFig = /^(tab|fig|sec|keywords)/.test(text.toLowerCase());
  if (weirdPosition || isTabFig) return null;

  if (isNumbered) {
    const match = text.match(SECTION_NUMBER_EXTRACT);
    if (match) {
      numberPrefix = match[1].replace(/\s+$/, "");
      numberDepth = calculateNumberDepth(numberPrefix);
    }
  }
  const lineHeight = line.lineHeight || 0;
  const fontSize = line.items[0].fontSize ?? 0;
  const fontStyle = line.items[0].fontStyle ?? FontStyle.REGULAR;

  const isSmallerFont = lineHeight < bodyLineHeight * 0.92;
  const isLargerFont = lineHeight > bodyLineHeight * 1.4;
  const isStyled =
    fontStyle === FontStyle.BOLD || fontStyle === FontStyle.BOLD_ITALIC;

  const isShortLine = line.lineWidth < page.pageWidth * 0.4;
  const isAllCapital = line.text === line.text.toUpperCase();

  if (isNumbered) {
    const strippedText = text
      .replace(SECTION_NUMBER_STRIP, "")
      .replace(/\s+/g, "")
      .trim();
    if (!/[A-Z]/.test(strippedText[0])) return null;
    if (!isShortLine) return null;
    if (!isStyled && !isAllCapital) return null;
  }

  const isNonNumberedHeading =
    !isNumbered && isLargerFont && isStyled && isShortLine && text.length < 80;
  const isTitleCaseHeading =
    !isNumbered &&
    !isSmallerFont &&
    isShortLine &&
    isStyled &&
    isTitleCase(line.items[0]?.str || text);
  const isCommonSectionHeading = isShortLine && isCommonSectionName(text);

  if (
    !isNumbered &&
    !isNonNumberedHeading &&
    !isTitleCaseHeading &&
    !isCommonSectionHeading
  ) {
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

  if (title.length < 2) return null;

  return {
    text,
    title: numberPrefix ? `${numberPrefix} ${title}` : title,
    pageNumber: pageNum,
    pageIndex: pageNum - 1,
    x: line.x || 0,
    y: line.y || 0,
    top: line.originalY + lineHeight || line.y || 0,
    fontSize: line.fontSize,
    lineHeight: lineHeight,
    fontStyle,
    numberPrefix,
    numberDepth,
    isNumbered,
  };
}

function calculateNumberDepth(prefix) {
  if (!prefix) return 0;
  const dotCount = (prefix.match(/\./g) || []).length;
  if (dotCount === 0) return 1;
  return prefix.replace(/\.$/, "").split(".").length;
}

function isTitleCase(text) {
  if (!text || text.length < 5) return false;
  const words = text.split(/[\s .]+/);
  if (words.length < 2) return false;
  const upperWords = words.filter((w) => w.length > 0 && /^[A-Z]/.test(w));
  return upperWords.length >= words.length * 0.6;
}

function assignHeadingLevels(candidates) {
  if (candidates.length === 0) return [];

  // Phase 1: Collect all line heights and cluster into tiers
  const allSizes = candidates.map((c) => Math.round(c.fontSize * 10) / 10);
  const uniqueHeights = [...new Set(allSizes)].sort((a, b) => b - a);
  const tiers = clusterSizes(uniqueHeights);

  // Phase 2: For each tier, compute depth offsets for numbered candidates
  const tierMinDepths = new Map(); // tierIndex -> minimum numberDepth in that tier
  for (const c of candidates) {
    if (!c.isNumbered || !c.numberDepth) continue;
    const h = Math.round(c.fontSize * 10) / 10;
    const tier = tiers.get(h) ?? 1;
    const current = tierMinDepths.get(tier);
    if (current === undefined || c.numberDepth < current) {
      tierMinDepths.set(tier, c.numberDepth);
    }
  }

  // Phase 3: Compute max possible offset across all tiers so we can
  // space tiers apart enough to avoid collisions
  const tierMaxOffsets = new Map(); // tierIndex -> max offset within tier
  for (const c of candidates) {
    if (!c.isNumbered || !c.numberDepth) continue;
    const h = Math.round(c.fontSize * 10) / 10;
    const tier = tiers.get(h) ?? 1;
    const minDepth = tierMinDepths.get(tier) ?? 1;
    const offset = c.numberDepth - minDepth;
    const current = tierMaxOffsets.get(tier) ?? 0;
    if (offset > current) tierMaxOffsets.set(tier, offset);
  }

  // Build a map from raw tier index to spaced-out base level
  // Each tier needs enough room for its depth offsets before the next tier starts
  const tierBaseLevels = new Map(); // tierIndex -> actual base level
  const tierCount = Math.max(...tiers.values(), 0);
  let currentLevel = 1;
  for (let t = 1; t <= tierCount; t++) {
    tierBaseLevels.set(t, currentLevel);
    const maxOffset = tierMaxOffsets.get(t) ?? 0;
    currentLevel += 1 + maxOffset; // reserve space for sub-levels
  }

  // Phase 4: Assign final level to each candidate
  return candidates.map((c) => {
    const h = Math.round(c.fontSize * 10) / 10;
    const tier = tiers.get(h) ?? 1;
    const baseLevel = tierBaseLevels.get(tier) ?? 1;

    let level = baseLevel;
    if (c.isNumbered && c.numberDepth > 0) {
      const minDepth = tierMinDepths.get(tier) ?? 1;
      level = baseLevel + (c.numberDepth - minDepth);
    }

    return { ...c, level };
  });
}

/**
 * Cluster nearby font sizes into tiers.
 *
 * @param {number[]} sortedSizes - unique sizes sorted descending
 * @returns {Map<number, number>} map from rounded size to tier index (1-based)
 */
function clusterSizes(sortedSizes) {
  if (sortedSizes.length === 0) return new Map();

  const RELATIVE_THRESHOLD = 0.1;
  const sizeToTier = new Map();
  let tierIndex = 1;
  let clusterAnchor = sortedSizes[0];

  sizeToTier.set(sortedSizes[0], tierIndex);

  for (let i = 1; i < sortedSizes.length; i++) {
    const size = sortedSizes[i];
    // Compare relative to the cluster anchor (the largest size in current cluster)
    const relativeDiff =
      clusterAnchor > 0 ? (clusterAnchor - size) / clusterAnchor : 1;

    if (relativeDiff > RELATIVE_THRESHOLD) {
      tierIndex++;
      clusterAnchor = size;
    }
    sizeToTier.set(size, tierIndex);
  }

  return sizeToTier;
}

const ROMAN_NUMERAL_MAP = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
  XXI: 21,
  XXII: 22,
  XXIII: 23,
  XXIV: 24,
  XXV: 25,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

function parseRomanNumeral(str) {
  const upper = str.toUpperCase();
  if (ROMAN_NUMERAL_MAP[upper] !== undefined) {
    return ROMAN_NUMERAL_MAP[upper];
  }
  return null;
}

function parseLetter(str) {
  if (/^[A-Z]$/i.test(str)) {
    return str.toUpperCase().charCodeAt(0) - 64;
  }
  return null;
}

function parsePrefix(prefix) {
  if (!prefix) return [];

  const cleaned = prefix.replace(/\.$/, "").trim();
  if (!cleaned) return [];

  const parts = cleaned.split(".");
  const components = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const asNumber = parseInt(trimmed, 10);
    if (!isNaN(asNumber)) {
      components.push(asNumber);
      continue;
    }

    const asRoman = parseRomanNumeral(trimmed);
    if (asRoman !== null) {
      components.push(asRoman);
      continue;
    }

    const asLetter = parseLetter(trimmed);
    if (asLetter !== null) {
      components.push(asLetter);
      continue;
    }

    components.push(0);
  }

  return components;
}

function isPrefixCompatible(parentComponents, childComponents) {
  if (childComponents.length <= parentComponents.length) {
    return false;
  }

  for (let i = 0; i < parentComponents.length; i++) {
    if (childComponents[i] !== parentComponents[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Build tree structure from flat leveled candidates
 * @param {Array<HeadingCandidate & {level: number}>} candidates
 * @returns {OutlineItem[]}
 */
function buildOutlineTree(candidates) {
  if (candidates.length === 0) return [];

  const filtered = candidates.filter((c) => {
    if (!c.numberPrefix) return true;
    const components = parsePrefix(c.numberPrefix);
    if (components.length > 0 && components[0] >= 1000) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) =>
    a.pageIndex !== b.pageIndex ? a.pageIndex - b.pageIndex : true,
  );

  const root = { children: [] };
  const stack = [{ node: root, level: 0, components: [] }];
  const seenTopLevel = new Set();

  for (const candidate of sorted) {
    const childComponents = parsePrefix(candidate.numberPrefix);

    const item = {
      id: crypto.randomUUID(),
      title: candidate.title,
      pageIndex: candidate.pageIndex,
      left: candidate.x,
      top: candidate.y,
      children: [],
    };

    while (stack.length > 1) {
      const parent = stack[stack.length - 1];

      if (parent.level >= candidate.level) {
        stack.pop();
        continue;
      }

      if (childComponents.length > 0 && parent.components.length > 0) {
        if (!isPrefixCompatible(parent.components, childComponents)) {
          stack.pop();
          continue;
        }
      }

      break;
    }

    if (childComponents.length > 1 && stack.length === 1) {
      continue;
    }

    if (childComponents.length === 1 && stack.length === 1) {
      const topNum = childComponents[0];
      if (seenTopLevel.size > 0) {
        const maxSeen = Math.max(...seenTopLevel);
        if (topNum > maxSeen + 5) {
          continue;
        }
      }
      seenTopLevel.add(topNum);
    }

    stack[stack.length - 1].node.children.push(item);
    stack.push({
      node: item,
      level: candidate.level,
      components: childComponents,
    });
  }

  return root.children;
}

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

/**
 * Detect document title and abstract from first pages
 */
export function detectDocumentMetadata(textIndex) {
  if (!textIndex) return { title: null, abstractInfo: null };

  const result = { title: null, abstractInfo: null };
  const pagesToScan = Math.min(3, textIndex.getPageCount?.() || 2);
  const allLines = [];
  const allFontSizes = [];

  for (let pageNum = 1; pageNum <= pagesToScan; pageNum++) {
    const data = textIndex.getPageData?.(pageNum);
    if (!data) continue;

    for (const line of data.lines) {
      if (!line.text || line.text.trim().length < 2) continue;
      if (line.text.startsWith("arXiv:")) continue;

      allLines.push({ ...line, pageNum, pageHeight: data.pageHeight });
      if (line.fontSize > 0) allFontSizes.push(line.fontSize);
    }
  }

  if (allLines.length === 0) return result;

  const bodyFontSize = findMostCommonFontSize(allFontSizes);
  result.title = detectTitle(allLines, bodyFontSize);
  result.abstractInfo = detectAbstract(allLines, bodyFontSize);

  return result;
}

function findMostCommonFontSize(fontSizes) {
  const rounded = fontSizes.map((s) => Math.round(s * 10) / 10);
  const counts = new Map();
  for (const size of rounded) {
    counts.set(size, (counts.get(size) || 0) + 1);
  }
  let maxCount = 0;
  let mostCommon = 10;
  for (const [size, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = size;
    }
  }
  return mostCommon;
}

function detectTitle(allLines, bodyFontSize) {
  const page1Lines = allLines.filter((line) => line.pageNum === 1);
  if (page1Lines.length === 0) return null;

  const pageHeight = page1Lines[0]?.pageHeight || 792;
  const topThreshold = pageHeight * 0.4;
  const titleCandidates = page1Lines.filter((line) => line.y > topThreshold);
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
    const posDiff = a.y - b.y;
    if (Math.abs(posDiff) > 5) return posDiff;
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
    const text = titleLines[i].text.trim();
    if (i === 0) {
      title = text;
    } else if (title.endsWith("-")) {
      title = title.slice(0, -1) + text;
    } else {
      title += " " + text;
    }
  }

  return cleanTitleText(title);
}

function cleanTitleText(text) {
  if (!text) return null;
  let cleaned = text
    .trim()
    .replace(/\*+$/, "")
    .trim()
    .replace(/^(title:\s*)/i, "")
    .trim();
  if (cleaned.length < 5 || !/[a-zA-Z]{3,}/.test(cleaned)) return null;
  return cleaned;
}

function detectAbstract(allLines, bodyFontSize) {
  for (const line of allLines) {
    const text = line.text?.trim() || "";
    const stripped = text.replace(SECTION_NUMBER_STRIP, "").trim();
    const lowerStripped = stripped.toLowerCase();

    if (
      lowerStripped === "abstract" ||
      lowerStripped === "abstract:" ||
      lowerStripped === "abstract." ||
      /^abstract\s*[-â€“â€”]\s*/i.test(stripped)
    ) {
      for (const item of line.items) {
        const isLarger = item.fontSize > bodyFontSize * 1.05;
        const isStyled = item.fontStyle !== FontStyle.REGULAR;

        if (isLarger || isStyled || lowerStripped === "abstract") {
          return {
            pageIndex: line.pageNum - 1,
            top: line.originalY || line.y || 0,
            left: line.x || 0,
          };
        }
      }
    }
  }
  return null;
}
