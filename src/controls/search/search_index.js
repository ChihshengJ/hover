/**
 * SearchIndex - Handles text extraction, word reconstruction, and substring search
 *
 * @typedef {Object} TextItem
 * @property {string} str - The text string
 * @property {number} x - X position in PDF coordinates
 * @property {number} y - Y position in PDF coordinates (top of text, converted from baseline)
 * @property {number} width - Width of text
 * @property {number} height - Height of text (font size)
 * @property {number[]} charPositions - X offset for each character
 *
 * @typedef {Object} PageIndex
 * @property {number} pageNumber - 1-based page number
 * @property {string} fullText - Reconstructed text with proper word breaks
 * @property {TextItem[]} textItems - Original text items with positions
 * @property {CharMapEntry[]} charMap - Maps fullText char index to textItem + char offset
 *
 * @typedef {Object} CharMapEntry
 * @property {number} itemIndex - Index in textItems array
 * @property {number} charIndex - Character index within that item
 * @property {number} x - Absolute X position
 * @property {number} y - Absolute Y position (top of character)
 * @property {number} width - Character width
 * @property {number} height - Character height
 *
 * @typedef {Object} SearchMatch
 * @property {string} id - Unique match ID
 * @property {number} pageNumber - Page where match occurs
 * @property {string} matchText - The matched text
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects - Highlight rectangles
 */

export class SearchIndex {
  /** @type {import('../../doc.js').PDFDocumentModel} */
  #doc = null;

  /** @type {PageIndex[]} */
  #pageIndices = [];

  /** @type {boolean} */
  #isBuilt = false;

  /** @type {boolean} */
  #isBuilding = false;

  /** @type {number} */
  #buildProgress = 0;

  /** @type {HTMLCanvasElement} */
  #measureCanvas = null;

  /** @type {CanvasRenderingContext2D} */
  #measureCtx = null;

  /** @type {string} */
  #currentFont = null;

  /** @type {number} */
  static BATCH_SIZE = 4; // Process 4 pages concurrently

  constructor(doc) {
    this.#doc = doc;
    this.#createMeasureCanvas();
  }

  get isBuilt() {
    return this.#isBuilt;
  }

  get isBuilding() {
    return this.#isBuilding;
  }

  get buildProgress() {
    return this.#buildProgress;
  }

  /**
   * Build the search index for all pages using parallel batch processing
   * @param {Function} [onProgress] - Progress callback (pageNumber, totalPages, percent)
   */
  async build(onProgress = null) {
    if (this.#isBuilt || this.#isBuilding) return;
    this.#isBuilding = true;
    this.#buildProgress = 0;

    const pdfDoc = this.#doc.pdfDoc;
    const numPages = pdfDoc.numPages;

    // Pre-allocate array for proper ordering
    this.#pageIndices = new Array(numPages);

    try {
      let completedPages = 0;

      // Process pages in parallel batches
      for (
        let batchStart = 0;
        batchStart < numPages;
        batchStart += SearchIndex.BATCH_SIZE
      ) {
        const batchEnd = Math.min(
          batchStart + SearchIndex.BATCH_SIZE,
          numPages,
        );
        const batchPromises = [];

        // Create promises for this batch
        for (let pageNum = batchStart + 1; pageNum <= batchEnd; pageNum++) {
          batchPromises.push(
            this.#buildPageIndex(pageNum).then((pageIndex) => {
              // Store at correct index (0-based)
              this.#pageIndices[pageNum - 1] = pageIndex;
              return pageIndex;
            }),
          );
        }

        // Wait for batch to complete
        await Promise.all(batchPromises);

        // Update progress
        completedPages = batchEnd;
        this.#buildProgress = Math.round((completedPages / numPages) * 100);

        if (onProgress) {
          onProgress(completedPages, numPages, this.#buildProgress);
        }

        // Yield to main thread for UI responsiveness
        await new Promise((r) => requestAnimationFrame(r));
      }

      this.#isBuilt = true;
      this.#buildProgress = 100;
    } finally {
      this.#isBuilding = false;
    }
  }

  /**
   * Search within a page range using simple substring matching
   * @param {string} query - Search query
   * @param {number} fromPage - Start page (1-based, inclusive)
   * @param {number} toPage - End page (1-based, inclusive)
   * @returns {SearchMatch[]}
   */
  search(query, fromPage = 1, toPage = this.#doc.numPages) {
    if (!this.#isBuilt || !query.trim()) return [];

    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return []; // Require at least 2 chars

    // Filter pages within range
    const pagesInRange = this.#pageIndices.filter(
      (p) => p.pageNumber >= fromPage && p.pageNumber <= toPage,
    );

    if (pagesInRange.length === 0) return [];

    const matches = [];
    let matchId = 0;

    // Search each page for substring matches
    for (const pageIndex of pagesInRange) {
      const pageText = pageIndex.fullText;
      const pageTextLower = pageText.toLowerCase();

      // Find all occurrences of the needle
      let pos = 0;
      while ((pos = pageTextLower.indexOf(needle, pos)) !== -1) {
        const startIdx = pos;
        const endIdx = pos + needle.length - 1;
        const rects = this.#getRectsForRange(pageIndex, startIdx, endIdx);

        if (rects.length > 0) {
          matches.push({
            id: `match-${matchId++}`,
            pageNumber: pageIndex.pageNumber,
            matchText: pageText.substring(startIdx, endIdx + 1),
            startIndex: startIdx,
            endIndex: endIdx,
            rects,
          });
        }
        pos++;
      }
    }

    // Sort by page number, then by position
    matches.sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.startIndex - b.startIndex;
    });

    return matches;
  }

  /**
   * Get page index data (for debugging or external use)
   * @param {number} pageNumber - 1-based page number
   * @returns {PageIndex|null}
   */
  getPageIndex(pageNumber) {
    return this.#pageIndices[pageNumber - 1] || null;
  }

  // =========================================
  // Private methods
  // =========================================

  #createMeasureCanvas() {
    this.#measureCanvas = document.createElement("canvas");
    this.#measureCanvas.width = 1000;
    this.#measureCanvas.height = 100;
    this.#measureCtx = this.#measureCanvas.getContext("2d");
  }

  /**
   * Build index for a single page
   * @param {number} pageNumber - 1-based page number
   * @returns {Promise<PageIndex>}
   */
  async #buildPageIndex(pageNumber) {
    const page = await this.#doc.pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    // Extract and enrich text items with character positions
    const textItems = this.#extractTextItems(textContent, viewport);

    // Reconstruct text with proper word breaks
    const { fullText, charMap } = this.#reconstructText(textItems, viewport);

    page.cleanup();

    return {
      pageNumber,
      fullText,
      textItems,
      charMap,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    };
  }

  /**
   * Extract text items from PDF.js text content
   * @param {Object} textContent - PDF.js text content
   * @param {Object} viewport - PDF.js viewport
   * @returns {TextItem[]}
   */
  #extractTextItems(textContent, viewport) {
    const items = [];
    const { width: pageWidth, height: pageHeight } = viewport;

    for (const item of textContent.items) {
      if (!item.str || item.str.length === 0) continue;

      const tx = item.transform;
      // PDF transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
      const x = tx[4];
      const y = tx[5]; // This is the BASELINE position in PDF coords (from bottom)
      const fontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);

      // Convert PDF coordinates (origin bottom-left, y is baseline) to top-left origin
      // 1. pageHeight - y = distance from TOP of page to the baseline
      // 2. Subtract fontSize to get the TOP of the text (ascender is ~80% but we use full for safety)
      // The text extends from (topY) to (topY + fontSize)
      const topY = pageHeight - y - fontSize;

      // Calculate character positions using canvas measurement
      const charPositions = this.#calculateCharPositions(
        item.str,
        item.width,
        fontSize,
      );

      items.push({
        str: item.str,
        x: x,
        y: topY,
        width: item.width || 0,
        height: fontSize,
        charPositions,
        originalY: y, // Keep original for sorting
      });
    }

    return items;
  }

  /**
   * Calculate character positions within a text span
   * Uses font caching and substring measurement for better performance
   * @param {string} text - Text string
   * @param {number} totalWidth - Total width of text span
   * @param {number} fontSize - Font size
   * @returns {number[]} Array of x offsets for each character
   */
  #calculateCharPositions(text, totalWidth, fontSize) {
    if (!text || text.length === 0) return [];
    if (text.length === 1) return [0];

    // Only set font if changed (font caching)
    const fontKey = `${Math.round(fontSize)}px sans-serif`;
    if (this.#currentFont !== fontKey) {
      this.#measureCtx.font = fontKey;
      this.#currentFont = fontKey;
    }

    // Use substring measurement for cumulative positions
    // This is more accurate than summing individual char widths
    const positions = [0];

    // Measure full text width once
    const measuredFullWidth = this.#measureCtx.measureText(text).width;

    // Only measure if we need scaling
    if (measuredFullWidth > 0 && totalWidth > 0) {
      const scale = totalWidth / measuredFullWidth;

      // Measure cumulative widths using substrings
      for (let i = 1; i < text.length; i++) {
        const substringWidth = this.#measureCtx.measureText(
          text.substring(0, i),
        ).width;
        positions.push(substringWidth * scale);
      }
    } else {
      // Fallback: equal distribution
      const charWidth = totalWidth / text.length;
      for (let i = 1; i < text.length; i++) {
        positions.push(i * charWidth);
      }
    }

    return positions;
  }

  /**
   * Reconstruct text with proper word breaks and build char map
   * Uses pre-computed index map for O(1) lookups
   * @param {TextItem[]} items - Text items
   * @param {Object} viewport - PDF.js viewport
   * @returns {{fullText: string, charMap: CharMapEntry[]}}
   */
  #reconstructText(items, viewport) {
    if (items.length === 0) return { fullText: "", charMap: [] };

    // Pre-compute item index map for O(1) lookups
    const itemIndexMap = new Map(items.map((item, idx) => [item, idx]));

    // Group items by line (similar Y position)
    const lines = this.#groupIntoLines(items);

    // Process each line
    let fullText = "";
    const charMap = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineText = this.#processLine(
        line,
        charMap,
        fullText.length,
        itemIndexMap,
      );

      // Check for hyphenation at end of line
      if (lineIdx < lines.length - 1 && lineText.endsWith("-")) {
        const nextLine = lines[lineIdx + 1];
        if (nextLine.length > 0) {
          const nextFirstItem = nextLine[0];
          // Check if next line starts with lowercase (continuation of word)
          if (nextFirstItem.str && /^[a-z]/.test(nextFirstItem.str)) {
            // Remove the hyphen from fullText
            fullText += lineText.slice(0, -1);
            // Remove last charMap entry (the hyphen)
            charMap.pop();
            continue;
          }
        }
      }

      fullText += lineText;

      // Add space or newline between lines
      if (lineIdx < lines.length - 1) {
        fullText += " ";
        // Add a space entry to charMap (maps to nothing specific)
        charMap.push({
          itemIndex: -1,
          charIndex: -1,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        });
      }
    }

    return { fullText, charMap };
  }

  /**
   * Group text items into lines based on Y position
   * @param {TextItem[]} items - Text items
   * @returns {TextItem[][]}
   */
  #groupIntoLines(items) {
    if (items.length === 0) return [];

    // Sort by Y (top to bottom), then X (left to right)
    const sorted = [...items].sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 3) return yDiff;
      return a.x - b.x;
    });

    const lines = [];
    let currentLine = [sorted[0]];
    let currentY = sorted[0].y;

    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i];
      // Same line if Y is within threshold (based on font height)
      const threshold = Math.max(3, currentLine[0].height * 0.5);

      if (Math.abs(item.y - currentY) <= threshold) {
        currentLine.push(item);
      } else {
        // Sort current line by X before pushing
        currentLine.sort((a, b) => a.x - b.x);
        lines.push(currentLine);
        currentLine = [item];
        currentY = item.y;
      }
    }

    // Don't forget the last line
    currentLine.sort((a, b) => a.x - b.x);
    lines.push(currentLine);

    return lines;
  }

  /**
   * Process a single line of text items
   * @param {TextItem[]} lineItems - Items in this line
   * @param {CharMapEntry[]} charMap - Char map to append to
   * @param {number} textOffset - Current offset in fullText
   * @param {Map<TextItem, number>} itemIndexMap - Pre-computed index map for O(1) lookups
   * @returns {string} Processed line text
   */
  #processLine(lineItems, charMap, textOffset, itemIndexMap) {
    let lineText = "";

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      const itemIndex = itemIndexMap.get(item);

      // Check if we need a space before this item
      if (i > 0) {
        const prevItem = lineItems[i - 1];
        const gap = item.x - (prevItem.x + prevItem.width);
        const avgCharWidth = item.width / Math.max(1, item.str.length);

        // Add space if gap is significant (> 30% of average char width)
        if (gap > avgCharWidth * 0.3) {
          lineText += " ";
          charMap.push({
            itemIndex: -1,
            charIndex: -1,
            x: prevItem.x + prevItem.width,
            y: item.y,
            width: gap,
            height: item.height,
          });
        }
      }

      // Add each character to the map
      for (let c = 0; c < item.str.length; c++) {
        const charX = item.x + (item.charPositions[c] || 0);
        const charWidth =
          c < item.str.length - 1
            ? (item.charPositions[c + 1] || 0) - (item.charPositions[c] || 0)
            : item.width - (item.charPositions[c] || 0);

        charMap.push({
          itemIndex,
          charIndex: c,
          x: charX,
          y: item.y,
          width: Math.max(1, charWidth),
          height: item.height,
        });
      }

      lineText += item.str;
    }

    return lineText;
  }

  /**
   * Get highlight rectangles for a character range
   * @param {PageIndex} pageIndex - Page index data
   * @param {number} startIdx - Start character index in fullText
   * @param {number} endIdx - End character index in fullText
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  #getRectsForRange(pageIndex, startIdx, endIdx) {
    const rects = [];
    const charMap = pageIndex.charMap;

    if (startIdx >= charMap.length || endIdx >= charMap.length) {
      return rects;
    }

    // Group consecutive characters into rectangles by line
    let currentRect = null;

    for (let i = startIdx; i <= endIdx && i < charMap.length; i++) {
      const entry = charMap[i];

      // Skip space entries
      if (entry.itemIndex === -1) {
        if (currentRect) {
          rects.push(currentRect);
          currentRect = null;
        }
        continue;
      }

      if (!currentRect) {
        currentRect = {
          x: entry.x,
          y: entry.y,
          width: entry.width,
          height: entry.height,
        };
      } else {
        // Check if same line (similar Y position)
        const sameLine = Math.abs(entry.y - currentRect.y) < 3;
        const adjacent =
          Math.abs(entry.x - (currentRect.x + currentRect.width)) < 5;

        if (sameLine && adjacent) {
          // Extend current rect
          currentRect.width = entry.x + entry.width - currentRect.x;
          currentRect.height = Math.max(currentRect.height, entry.height);
        } else {
          // Start new rect
          rects.push(currentRect);
          currentRect = {
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
          };
        }
      }
    }

    if (currentRect) {
      rects.push(currentRect);
    }

    return rects;
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this.#pageIndices = [];
    this.#isBuilt = false;
    this.#isBuilding = false;
    this.#buildProgress = 0;
    this.#measureCanvas = null;
    this.#measureCtx = null;
    this.#currentFont = null;
  }
}
