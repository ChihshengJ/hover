/**
 * SearchIndex - Handles text extraction, word reconstruction, and substring search
 * Supports multi-column layouts with proper reading order detection.
 *
 * @typedef {Object} TextItem
 * @property {string} str - The text string
 * @property {number} x - X position in PDF coordinates
 * @property {number} y - Y position in PDF coordinates (top of text, converted from baseline)
 * @property {number} width - Width of text
 * @property {number} height - Height of text (font size)
 * @property {number[]} charPositions - X offset for each character
 * @property {string} [fontName] - Font name from PDF (e.g., "CMBX12", "TimesNewRoman-Bold")
 * @property {number} originalY - Original Y in PDF coordinates (baseline, from bottom)
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
 *
 * @typedef {Object} ColumnBoundary
 * @property {number} left - Left X boundary
 * @property {number} right - Right X boundary
 *
 * @typedef {Object} LayoutSegment
 * @property {'full-width'|'columns'} type - Segment type
 * @property {number} yStart - Top Y position
 * @property {number} yEnd - Bottom Y position
 * @property {TextItem[]} [items] - Items for full-width segments
 * @property {TextItem[][]} [columns] - Items per column for multi-column segments
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
  static BATCH_SIZE = 6; // Process 4 pages concurrently

  // Column detection constants
  static MIN_LINES_FOR_COLUMN_DETECTION = 10; // Need enough lines to detect pattern
  static GUTTER_LINE_THRESHOLD = 0.25; // Gap must appear on 25%+ of lines
  static CLUSTER_TOLERANCE_RATIO = 0.04; // 3% of page width for clustering
  static FULL_WIDTH_THRESHOLD = 0.65; // Item spanning >70% of page = full-width

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

    this.#pageIndices = new Array(numPages);

    try {
      let completedPages = 0;
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
        for (let pageNum = batchStart + 1; pageNum <= batchEnd; pageNum++) {
          batchPromises.push(
            this.#buildPageIndex(pageNum).then((pageIndex) => {
              // Store at correct index (0-based)
              this.#pageIndices[pageNum - 1] = pageIndex;
              return pageIndex;
            }),
          );
        }
        await Promise.all(batchPromises);
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

  /**
   * Get total number of indexed pages
   * @returns {number}
   */
  getPageCount() {
    return this.#pageIndices.length;
  }

  /**
   * Get ordered lines for a page with font information
   * Lines are returned in reading order (respecting multi-column layouts)
   * 
   * @typedef {Object} OrderedLine
   * @property {string} text - Combined text of the line
   * @property {number} x - Left X position of first item
   * @property {number} y - Y position (top-left origin)
   * @property {number} originalY - Original Y in PDF coords (baseline, from bottom)
   * @property {number} fontSize - Dominant font size in line
   * @property {string|null} fontName - Dominant font name in line
   * @property {TextItem[]} items - Original text items in this line
   * 
   * @param {number} pageNumber - 1-based page number
   * @returns {OrderedLine[]|null}
   */
  getOrderedLines(pageNumber) {
    const pageIndex = this.#pageIndices[pageNumber - 1];
    if (!pageIndex) return null;

    const items = pageIndex.textItems;
    if (!items || items.length === 0) return [];

    const pageWidth = pageIndex.pageWidth;

    // Detect column gutters for proper reading order
    const gutters = this.#detectColumnGutters(items, pageWidth);

    let orderedItems;
    
    if (gutters.length === 0) {
      // Single column - simple top-to-bottom, left-to-right
      orderedItems = [...items].sort((a, b) => {
        const yDiff = a.y - b.y;
        if (Math.abs(yDiff) > 3) return yDiff;
        return a.x - b.x;
      });
    } else {
      // Multi-column - need to respect column order
      const marginLeft = Math.max(0, Math.min(...items.map(i => i.x)) - 5);
      const marginRight = Math.max(0, pageWidth - Math.max(...items.map(i => i.x + i.width)) - 5);
      const columns = this.#buildColumnBoundaries(gutters, pageWidth, marginLeft, marginRight);
      const segments = this.#segmentPageByLayout(items, columns, pageWidth, marginLeft, marginRight);
      
      orderedItems = [];
      for (const segment of segments) {
        if (segment.type === 'full-width') {
          orderedItems.push(...segment.items);
        } else {
          // Process columns left to right
          for (const columnItems of segment.columns) {
            orderedItems.push(...columnItems);
          }
        }
      }
    }

    // Group into lines
    const lines = this.#groupIntoLines(orderedItems);

    // Convert to OrderedLine format
    return lines.map(lineItems => {
      // Combine text
      const text = lineItems.map(item => item.str).join(' ');
      
      // Find dominant font size (max in line, as headings are larger)
      const fontSize = Math.max(...lineItems.map(item => item.height));
      
      // Find most common font name in line
      const fontNames = lineItems.map(item => item.fontName).filter(Boolean);
      const fontName = fontNames.length > 0 ? this.#getMostCommon(fontNames) : null;
      
      // Get first item's position
      const firstItem = lineItems[0];
      
      return {
        text,
        x: firstItem.x,
        y: firstItem.y,
        originalY: firstItem.originalY,
        fontSize,
        fontName,
        items: lineItems,
      };
    });
  }

  /**
   * Get most common element in array
   * @param {Array} arr
   * @returns {*}
   */
  #getMostCommon(arr) {
    const counts = new Map();
    for (const item of arr) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    let maxCount = 0;
    let mostCommon = arr[0];
    for (const [item, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = item;
      }
    }
    return mostCommon;
  }

  /**
   * Debug method to analyze column detection on a specific page
   * @param {number} pageNumber - 1-based page number
   * @returns {Object} Debug info including detected gutters and line gaps
   */
  debugColumnDetection(pageNumber) {
    const pageIndex = this.#pageIndices[pageNumber - 1];
    if (!pageIndex) return null;

    const items = pageIndex.textItems;
    const pageWidth = pageIndex.pageWidth;

    const lines = this.#groupIntoLines(items);
    const lineGapInfo = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (line.length < 2) continue;

      const sortedLine = [...line].sort((a, b) => a.x - b.x);
      const gaps = [];

      for (let i = 0; i < sortedLine.length - 1; i++) {
        const current = sortedLine[i];
        const next = sortedLine[i + 1];
        const gapWidth = next.x - (current.x + current.width);

        if (gapWidth > 0) {
          gaps.push({
            x: current.x + current.width + gapWidth / 2,
            width: gapWidth,
            between: `"${current.str.slice(-10)}" â†’ "${next.str.slice(0, 10)}"`,
          });
        }
      }

      if (gaps.length > 0) {
        const largest = gaps.reduce((a, b) => (a.width > b.width ? a : b));
        const median = [...gaps].sort((a, b) => a.width - b.width)[
          Math.floor(gaps.length / 2)
        ];

        lineGapInfo.push({
          lineIdx,
          y: line[0].y,
          gapCount: gaps.length,
          largestGap: largest,
          medianGapWidth: median.width,
          ratio: largest.width / median.width,
        });
      }
    }

    const gutters = this.#detectColumnGutters(items, pageWidth);

    return {
      pageNumber,
      pageWidth,
      totalLines: lines.length,
      linesWithGaps: lineGapInfo.length,
      guttersDetected: gutters,
      lineGapInfo: lineGapInfo.slice(0, 20), // First 20 lines for brevity
      thresholds: {
        minLines: SearchIndex.MIN_LINES_FOR_COLUMN_DETECTION,
        gutterLineThreshold: SearchIndex.GUTTER_LINE_THRESHOLD,
        clusterTolerance: pageWidth * SearchIndex.CLUSTER_TOLERANCE_RATIO,
      },
    };
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

    // Reconstruct text with proper word breaks and column handling
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
        fontName: item.fontName || null,
        originalY: y,
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

  // =========================================
  // Column Detection Methods (Line-Gap Based)
  // =========================================

  /**
   * Detect column gutters by finding consistent large gaps across lines.
   *
   * Algorithm:
   * 1. Group items into lines (by Y position)
   * 2. For each line, find all gaps between items
   * 3. Identify the largest gap on each line (potential column gutter)
   * 4. Cluster these large gaps by X position
   * 5. Consistent clusters = column boundaries
   *
   * @param {TextItem[]} items - Text items on the page
   * @param {number} pageWidth - Page width in PDF units
   * @returns {number[]} Array of X positions marking gutter centers
   */
  #detectColumnGutters(items, pageWidth) {
    if (items.length === 0) return [];

    // Group items into lines
    const lines = this.#groupIntoLines(items);
    if (lines.length < SearchIndex.MIN_LINES_FOR_COLUMN_DETECTION) return [];

    // Collect the largest gap from each line
    const candidateGaps = [];
    let validLineCount = 0;

    for (const line of lines) {
      if (line.length < 2) continue;
      validLineCount++;

      // Sort line by X position
      const sortedLine = [...line].sort((a, b) => a.x - b.x);

      // Calculate line metrics
      const lineStart = sortedLine[0].x;
      const lastItem = sortedLine[sortedLine.length - 1];
      const lineEnd = lastItem.x + lastItem.width;
      const lineWidth = lineEnd - lineStart;

      if (lineWidth <= 0) continue;

      // Find all gaps on this line
      const gaps = [];
      for (let i = 0; i < sortedLine.length - 1; i++) {
        const current = sortedLine[i];
        const next = sortedLine[i + 1];
        const gapStart = current.x + current.width;
        const gapEnd = next.x;
        const gapWidth = gapEnd - gapStart;

        if (gapWidth > 0) {
          gaps.push({
            x: (gapStart + gapEnd) / 2, // Center of gap
            width: gapWidth,
            start: gapStart,
            end: gapEnd,
          });
        }
      }

      if (gaps.length === 0) continue;

      // Find the largest gap on this line
      let largestGap = gaps[0];
      for (const gap of gaps) {
        if (gap.width > largestGap.width) {
          largestGap = gap;
        }
      }

      // Calculate median gap (typical word spacing)
      const sortedGapWidths = gaps.map((g) => g.width).sort((a, b) => a - b);
      const medianGapWidth =
        sortedGapWidths[Math.floor(sortedGapWidths.length / 2)];

      // Only consider as column gutter candidate if:
      // - It's significantly larger than median word spacing (1.8x+)
      // - OR it's a significant portion of line width (3%+)
      const isSignificantlyLarger = largestGap.width > medianGapWidth * 1.8;
      const isSignificantPortion = largestGap.width > lineWidth * 0.03;

      if (isSignificantlyLarger || isSignificantPortion) {
        candidateGaps.push(largestGap);
      }
    }


    // Need enough lines with candidate gaps
    const minGapsRequired = validLineCount * SearchIndex.GUTTER_LINE_THRESHOLD;
    if (candidateGaps.length === 0 || candidateGaps.length < minGapsRequired) return [];

    // Cluster candidate gaps by X position
    const tolerance = pageWidth * SearchIndex.CLUSTER_TOLERANCE_RATIO;
    candidateGaps.sort((a, b) => a.x - b.x);

    const clusters = [];
    let currentCluster = [candidateGaps[0]];

    for (let i = 1; i < candidateGaps.length; i++) {
      const gap = candidateGaps[i];
      const clusterAvgX =
        currentCluster.reduce((sum, g) => sum + g.x, 0) / currentCluster.length;

      if (Math.abs(gap.x - clusterAvgX) <= tolerance) {
        currentCluster.push(gap);
      } else {
        // Save cluster if it has enough members
        if (currentCluster.length >= minGapsRequired) {
          clusters.push(currentCluster);
        }
        currentCluster = [gap];
      }
    }

    if (currentCluster.length >= minGapsRequired) {
      clusters.push(currentCluster);
    }

    // Convert clusters to gutter X positions
    const gutters = clusters.map((cluster) => {
      // Use average X of all gaps in cluster
      return cluster.reduce((sum, g) => sum + g.x, 0) / cluster.length;
    });

    // Filter out gutters too close to edges (likely margins, not columns)
    const minEdgeDistance = pageWidth * 0.1; // Must be 10% from edge
    return gutters.filter(
      (x) => x > minEdgeDistance && x < pageWidth - minEdgeDistance,
    );
  }

  /**
   * Build column boundaries from gutter positions
   * @param {number[]} gutters - Array of gutter center X positions
   * @param {number} pageWidth - Page width
   * @param {number} marginLeft - Left margin (estimated from items)
   * @param {number} marginRight - Right margin (estimated from items)
   * @returns {ColumnBoundary[]}
   */
  #buildColumnBoundaries(gutters, pageWidth, marginLeft, marginRight) {
    if (gutters.length === 0) {
      return [{ left: marginLeft, right: pageWidth - marginRight }];
    }

    const boundaries = [];
    const sortedGutters = [...gutters].sort((a, b) => a - b);

    // First column: from left margin to first gutter
    boundaries.push({ left: marginLeft, right: sortedGutters[0] });

    // Middle columns: between gutters
    for (let i = 0; i < sortedGutters.length - 1; i++) {
      boundaries.push({ left: sortedGutters[i], right: sortedGutters[i + 1] });
    }

    // Last column: from last gutter to right margin
    boundaries.push({
      left: sortedGutters[sortedGutters.length - 1],
      right: pageWidth - marginRight,
    });

    return boundaries;
  }

  /**
   * Determine which column an item belongs to based on its center X
   * @param {TextItem} item - Text item
   * @param {ColumnBoundary[]} columns - Column boundaries
   * @returns {number} Column index (0-based)
   */
  #getItemColumn(item, columns) {
    const centerX = item.x + item.width / 2;

    for (let i = 0; i < columns.length; i++) {
      if (centerX >= columns[i].left && centerX <= columns[i].right) {
        return i;
      }
    }

    // Fallback: assign to nearest column
    let minDist = Infinity;
    let nearestCol = 0;

    for (let i = 0; i < columns.length; i++) {
      const colCenter = (columns[i].left + columns[i].right) / 2;
      const dist = Math.abs(centerX - colCenter);

      if (dist < minDist) {
        minDist = dist;
        nearestCol = i;
      }
    }

    return nearestCol;
  }

  /**
   * Check if an item is full-width (spans across columns)
   * @param {TextItem} item - Text item
   * @param {number} pageWidth - Page width
   * @param {number} marginLeft - Left margin
   * @param {number} marginRight - Right margin
   * @returns {boolean}
   */
  #isFullWidthItem(item, pageWidth, marginLeft, marginRight) {
    const contentWidth = pageWidth - marginLeft - marginRight;
    return item.width >= contentWidth * SearchIndex.FULL_WIDTH_THRESHOLD;
  }

  /**
   * Segment page into layout regions (full-width vs multi-column)
   * @param {TextItem[]} items - Text items sorted by Y
   * @param {ColumnBoundary[]} columns - Column boundaries
   * @param {number} pageWidth - Page width
   * @param {number} marginLeft - Left margin
   * @param {number} marginRight - Right margin
   * @returns {LayoutSegment[]}
   */
  #segmentPageByLayout(items, columns, pageWidth, marginLeft, marginRight) {
    if (items.length === 0) return [];
    if (columns.length <= 1) {
      // Single column - treat all as full-width
      return [{ type: "full-width", yStart: 0, yEnd: Infinity, items }];
    }

    // Sort items by Y position
    const sortedByY = [...items].sort((a, b) => a.y - b.y);

    const segments = [];
    let currentSegment = null;
    let currentType = null;

    // Group items into Y bands and determine segment type
    const avgHeight =
      items.reduce((sum, item) => sum + item.height, 0) / items.length;
    const bandThreshold = avgHeight * 1.5;

    for (const item of sortedByY) {
      const isFullWidth = this.#isFullWidthItem(
        item,
        pageWidth,
        marginLeft,
        marginRight,
      );
      const itemType = isFullWidth ? "full-width" : "columns";

      // Check if we need to start a new segment
      const needNewSegment =
        !currentSegment ||
        itemType !== currentType ||
        (currentSegment.items &&
          item.y - currentSegment.yEnd > bandThreshold * 2);

      if (needNewSegment) {
        // Finalize current segment
        if (currentSegment) {
          segments.push(currentSegment);
        }

        // Start new segment
        if (itemType === "full-width") {
          currentSegment = {
            type: "full-width",
            yStart: item.y,
            yEnd: item.y + item.height,
            items: [item],
          };
        } else {
          currentSegment = {
            type: "columns",
            yStart: item.y,
            yEnd: item.y + item.height,
            columns: columns.map(() => []),
          };
          const colIdx = this.#getItemColumn(item, columns);
          currentSegment.columns[colIdx].push(item);
        }
        currentType = itemType;
      } else {
        // Add to current segment
        currentSegment.yEnd = Math.max(
          currentSegment.yEnd,
          item.y + item.height,
        );

        if (itemType === "full-width") {
          currentSegment.items.push(item);
        } else {
          const colIdx = this.#getItemColumn(item, columns);
          currentSegment.columns[colIdx].push(item);
        }
      }
    }

    // Don't forget the last segment
    if (currentSegment) {
      segments.push(currentSegment);
    }

    return segments;
  }

  // =========================================
  // Text Reconstruction Methods
  // =========================================

  /**
   * Reconstruct text with proper reading order for multi-column layouts
   * @param {TextItem[]} items - Text items
   * @param {Object} viewport - PDF.js viewport
   * @returns {{fullText: string, charMap: CharMapEntry[]}}
   */
  #reconstructText(items, viewport) {
    if (items.length === 0) return { fullText: "", charMap: [] };

    const pageWidth = viewport.width;

    // Pre-compute item index map for O(1) lookups
    const itemIndexMap = new Map(items.map((item, idx) => [item, idx]));

    // Estimate margins from item positions
    const marginLeft = Math.max(0, Math.min(...items.map((i) => i.x)) - 5);
    const marginRight = Math.max(
      0,
      pageWidth - Math.max(...items.map((i) => i.x + i.width)) - 5,
    );

    // Detect column gutters
    const gutters = this.#detectColumnGutters(items, pageWidth);

    // If no columns detected, use simple single-column logic
    if (gutters.length === 0) {
      return this.#reconstructSingleColumn(items, itemIndexMap);
    }

    // Build column boundaries
    const columns = this.#buildColumnBoundaries(
      gutters,
      pageWidth,
      marginLeft,
      marginRight,
    );

    // Segment page by layout type
    const segments = this.#segmentPageByLayout(
      items,
      columns,
      pageWidth,
      marginLeft,
      marginRight,
    );

    // Process segments in order
    let fullText = "";
    const charMap = [];

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];

      if (segment.type === "full-width") {
        const result = this.#processSegmentItems(
          segment.items,
          charMap,
          fullText.length,
          itemIndexMap,
        );
        fullText += result.text;
      } else {
        // Process columns left to right
        for (let colIdx = 0; colIdx < segment.columns.length; colIdx++) {
          const columnItems = segment.columns[colIdx];
          if (columnItems.length === 0) continue;

          const result = this.#processSegmentItems(
            columnItems,
            charMap,
            fullText.length,
            itemIndexMap,
          );
          fullText += result.text;

          // Add space between columns (but not after last column)
          if (colIdx < segment.columns.length - 1 && result.text.length > 0) {
            fullText += " ";
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
      }

      // Add space between segments
      if (segIdx < segments.length - 1 && fullText.length > 0) {
        fullText += " ";
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
   * Simple single-column text reconstruction (original algorithm)
   * @param {TextItem[]} items - Text items
   * @param {Map<TextItem, number>} itemIndexMap - Item index map
   * @returns {{fullText: string, charMap: CharMapEntry[]}}
   */
  #reconstructSingleColumn(items, itemIndexMap) {
    const lines = this.#groupIntoLines(items);

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
      if (lineIdx < lines.length - 1 && !!lineText.match(/[-]$/)) {
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

      // Add space between lines
      if (lineIdx < lines.length - 1) {
        fullText += " ";
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
   * Process items within a segment (column or full-width region)
   * @param {TextItem[]} items - Items in the segment
   * @param {CharMapEntry[]} charMap - Char map to append to
   * @param {number} textOffset - Current offset in fullText
   * @param {Map<TextItem, number>} itemIndexMap - Item index map
   * @returns {{text: string}}
   */
  #processSegmentItems(items, charMap, textOffset, itemIndexMap) {
    if (items.length === 0) return { text: "" };

    // Group into lines within this segment
    const lines = this.#groupIntoLines(items);

    let text = "";

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineText = this.#processLine(
        line,
        charMap,
        textOffset + text.length,
        itemIndexMap,
      );

      // Check for hyphenation at end of line
      if (lineIdx < lines.length - 1 && !!lineText.match(/[-]$/)) {
        const nextLine = lines[lineIdx + 1];
        if (nextLine.length > 0) {
          const nextFirstItem = nextLine[0];
          if (nextFirstItem.str && /^[a-z]/.test(nextFirstItem.str)) {
            text += lineText.slice(0, -1);
            charMap.pop();
            continue;
          }
        }
      }

      text += lineText;

      // Add space between lines
      if (lineIdx < lines.length - 1) {
        text += " ";
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

    return { text };
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

  // =========================================
  // Highlight Rectangle Generation
  // =========================================

  /**
   * Get highlight rectangles for a character range
   * Handles multi-line and multi-column matches properly
   * @param {PageIndex} pageIndex - Page index data
   * @param {number} startIdx - Start character index in fullText
   * @param {number} endIdx - End character index in fullText
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  #getRectsForRange(pageIndex, startIdx, endIdx) {
    const charMap = pageIndex.charMap;

    if (startIdx >= charMap.length || endIdx >= charMap.length) {
      return [];
    }

    // Collect all valid character entries in the range
    const entries = [];
    for (let i = startIdx; i <= endIdx && i < charMap.length; i++) {
      const entry = charMap[i];
      // Skip space/separator entries
      if (entry.itemIndex !== -1) {
        entries.push(entry);
      }
    }

    if (entries.length === 0) return [];

    // Group entries into visual runs
    // A new run starts when:
    //   - Y position changes significantly (new line)
    //   - X position jumps backward significantly (new line or new column)
    const runs = [];
    let currentRun = null;

    for (const entry of entries) {
      const shouldStartNewRun =
        !currentRun ||
        // Different line (Y changed)
        Math.abs(entry.y - currentRun.y) > entry.height * 0.5 ||
        // X jumped backward (wrap to new line or column)
        entry.x < currentRun.endX - entry.height;

      if (shouldStartNewRun) {
        if (currentRun) {
          runs.push(currentRun);
        }
        currentRun = {
          x: entry.x,
          y: entry.y,
          endX: entry.x + entry.width,
          height: entry.height,
          minY: entry.y,
          maxY: entry.y + entry.height,
        };
      } else {
        // Extend current run
        currentRun.endX = entry.x + entry.width;
        currentRun.height = Math.max(currentRun.height, entry.height);
        currentRun.minY = Math.min(currentRun.minY, entry.y);
        currentRun.maxY = Math.max(currentRun.maxY, entry.y + entry.height);
      }
    }

    if (currentRun) {
      runs.push(currentRun);
    }

    // Convert runs to rectangles
    return runs.map((run) => ({
      x: run.x,
      y: run.minY,
      width: run.endX - run.x,
      height: run.maxY - run.minY,
    }));
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
