/**
 * SearchIndex - Refactored for @embedpdf/engines (PDFium)
 *
 * @typedef {Object} TextItem
 * @property {string} str - The text string
 * @property {number} x - X position in PDF coordinates
 * @property {number} y - Y position in PDF coordinates (top of text)
 * @property {number} width - Width of text
 * @property {number} height - Height of text (font size)
 * @property {string} [fontName] - Font name if available
 * @property {number} originalY - Original Y in PDF coordinates (from bottom)
 *
 * @typedef {Object} PageData
 * @property {number} pageNumber - 1-based page number
 * @property {number} pageWidth - Page width in PDF units
 * @property {number} pageHeight - Page height in PDF units
 * @property {TextItem[]} textItems - Extracted text items
 * @property {string} fullText - Full page text
 *
 * @typedef {Object} SearchMatch
 * @property {string} id - Unique match ID
 * @property {number} pageNumber - Page where match occurs
 * @property {string} matchText - The matched text
 * @property {Array<{x: number, y: number, width: number, height: number}>} rects - Highlight rectangles
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
 * @typedef {Object} ColumnAwareLine
 * @property {string} text - Combined text of the line
 * @property {number} x - Left X position of first item
 * @property {number} y - Y position (top-left origin)
 * @property {number} originalY - Original Y in PDF coords
 * @property {number} fontSize - Dominant font size in line
 * @property {string|null} fontName - Dominant font name in line
 * @property {number} columnIndex - -1 for full-width, 0 for col1, 1 for col2, etc.
 * @property {boolean} isAtColumnStart - Whether line is left-aligned within its column
 * @property {TextItem[]} items - Original text items in this line
 */

export class SearchIndex {
  /** @type {import('./doc.js').PDFDocumentModel} */
  #doc = null;

  /** @type {Map<number, PageData>} */
  #pageData = new Map();

  /** @type {boolean} */
  #isBuilt = false;

  /** @type {boolean} */
  #isBuilding = false;

  /** @type {number} */
  #buildProgress = 0;

  /** @type {Set<number>} Pages that have been indexed */
  #indexedPages = new Set();

  // NEW: Low-level PDFium handle for text extraction
  /** @type {import('../../data/text-extractor.js').PdfiumDocumentHandle|null} */
  #lowLevelHandle = null;

  // Column detection constants
  static MIN_LINES_FOR_COLUMN_DETECTION = 5;
  static GUTTER_LINE_THRESHOLD = 0.1;
  static CLUSTER_TOLERANCE_RATIO = 0.008;
  static FULL_WIDTH_THRESHOLD = 0.7;
  static MAX_COLUMN_COUNT = 3;
  static MIN_COLUMN_WIDTH_RATIO = 0.15;
  static MAX_COLUMN_WIDTH_RATIO = 0.7;
  static MIN_VERTICAL_COVERAGE = 0.2;

  constructor(doc) {
    this.#doc = doc;
  }

  /**
   * Set the low-level PDFium handle for text extraction
   * This should be called after construction if low-level access is available
   * @param {import('./pdfium-text-extractor.js').PdfiumDocumentHandle} handle
   */
  setLowLevelHandle(handle) {
    this.#lowLevelHandle = handle;
    console.log('[SearchIndex] Low-level handle set for UTF-16LE text extraction');
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
   * Register page data from a rendered page
   * This is called by PageView after rendering a page
   * @param {number} pageNumber - 1-based page number
   * @param {Array} textSlices - Text slices from PDFium getPageTextRects
   * @param {number} pageWidth
   * @param {number} pageHeight
   */
  registerPageData(pageNumber, textSlices, pageWidth, pageHeight) {
    if (this.#indexedPages.has(pageNumber)) {
      return; // Already indexed
    }

    try {
      const textItems = this.#convertTextSlices(textSlices, pageHeight);
      const fullText = textItems.map((item) => item.str).join(" ");

      this.#pageData.set(pageNumber, {
        pageNumber,
        pageWidth,
        pageHeight,
        textItems,
        fullText,
      });

      this.#indexedPages.add(pageNumber);
      this.#updateBuildProgress();
    } catch (error) {
      console.warn(
        `[SearchIndex] Error registering page ${pageNumber}:`,
        error,
      );
      // Store empty data so we don't retry
      this.#pageData.set(pageNumber, {
        pageNumber,
        pageWidth,
        pageHeight,
        textItems: [],
        fullText: "",
      });
      this.#indexedPages.add(pageNumber);
    }
  }

  /**
   * Convert PDFium text slices to our TextItem format
   * @param {Array} textSlices
   * @param {number} pageHeight
   * @returns {TextItem[]}
   */
  #convertTextSlices(textSlices, pageHeight) {
    if (!textSlices || textSlices.length === 0) return [];

    return textSlices
      .map((slice) => {
        const content = slice.content || "";
        if (!content || content.trim().length === 0) {
          return null;
        }

        return {
          str: content,
          x: slice.rect.origin.x,
          y: slice.rect.origin.y,
          width: slice.rect.size.width,
          height: slice.rect.size.height,
          fontName: slice.font?.family || slice.font?.famliy || null,
          fontSize: slice.font?.size || slice.rect.size.height,
          originalY: pageHeight - slice.rect.origin.y,
        };
      })
      .filter(Boolean);
  }

  #updateBuildProgress() {
    const total = this.#doc.numPages;
    const indexed = this.#indexedPages.size;
    this.#buildProgress = Math.round((indexed / total) * 100);

    if (indexed >= total) {
      this.#isBuilt = true;
      this.#isBuilding = false;
    }
  }

  /**
   * Build the search index for all pages
   * This version fetches data on-demand with error handling
   * @param {Function} [onProgress] - Progress callback
   */
  async build(onProgress = null) {
    if (this.#isBuilt || this.#isBuilding) return;
    this.#isBuilding = true;
    this.#buildProgress = 0;

    const numPages = this.#doc.numPages;
    const BATCH_SIZE = 1; // Process pages in batches

    try {
      for (
        let batchStart = 0;
        batchStart < numPages;
        batchStart += BATCH_SIZE
      ) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, numPages);
        const batchPromises = [];

        for (let pageNum = batchStart + 1; pageNum <= batchEnd; pageNum++) {
          // Skip if already indexed (e.g., from page rendering)
          if (this.#indexedPages.has(pageNum)) {
            continue;
          }

          batchPromises.push(this.#buildPageDataSafe(pageNum));
        }

        await Promise.all(batchPromises);

        this.#buildProgress = Math.round((batchEnd / numPages) * 100);

        if (onProgress) {
          onProgress(batchEnd, numPages, this.#buildProgress);
        }

        // Yield to main thread
        await new Promise((r) => requestAnimationFrame(r));
      }

      this.#isBuilt = true;
      this.#buildProgress = 100;
    } finally {
      this.#isBuilding = false;
    }
  }

  /**
   * Build page data with error handling
   * MODIFIED: Uses low-level extraction if available
   * @param {number} pageNumber - 1-based page number
   */
  async #buildPageDataSafe(pageNumber) {
    const page = this.#doc.pdfDoc?.pages?.[pageNumber - 1];

    if (!page) {
      this.#storeEmptyPage(pageNumber);
      return;
    }

    const pageWidth = page.size.width;
    const pageHeight = page.size.height;

    try {
      let textItems = [];
      let fullText = '';

      // Try low-level extraction first (proper UTF-16LE handling)
      if (this.#lowLevelHandle) {
        try {
          const result = this.#lowLevelHandle.extractPageText(pageNumber - 1);
          textItems = this.#convertTextSlices(result.textSlices, pageHeight);
          fullText = result.fullText;
          
        } catch (lowLevelError) {
          console.warn(`[SearchIndex] Low-level extraction failed for page ${pageNumber}, falling back:`, lowLevelError.message);
          textItems = [];
        }
      }

      // Fallback to high-level API if low-level not available or failed
      if (textItems.length === 0) {
        const { native, pdfDoc } = this.#doc;
        if (native && pdfDoc) {
          try {
            const textSlices = await native
              .getPageTextRects(pdfDoc, page)
              .toPromise();
            textItems = this.#convertTextSlices(textSlices, pageHeight);
            fullText = textItems.map((item) => item.str).join(' ');
            
          } catch (highLevelError) {
            console.warn(`[SearchIndex] High-level extraction also failed for page ${pageNumber}:`, highLevelError.message);
          }
        }
      }

      this.#pageData.set(pageNumber, {
        pageNumber,
        pageWidth,
        pageHeight,
        textItems,
        fullText,
      });
      this.#indexedPages.add(pageNumber);
    } catch (error) {
      // Handle UTF-8 and other errors gracefully
      console.warn(
        `[SearchIndex] Error extracting text from page ${pageNumber}:`,
        error.message,
      );
      this.#storeEmptyPage(pageNumber, pageWidth, pageHeight);
    }
  }

  /**
   * Store empty page data for pages that fail to extract
   */
  #storeEmptyPage(pageNumber, pageWidth = 0, pageHeight = 0) {
    if (!pageWidth || !pageHeight) {
      const page = this.#doc.pdfDoc?.pages?.[pageNumber - 1];
      if (page) {
        pageWidth = page.size.width;
        pageHeight = page.size.height;
      }
    }

    this.#pageData.set(pageNumber, {
      pageNumber,
      pageWidth,
      pageHeight,
      textItems: [],
      fullText: "",
    });
    this.#indexedPages.add(pageNumber);
  }

  /**
   * Search using PDFium's native search
   * @param {string} query - Search query
   * @param {number} fromPage - Start page (1-based, inclusive)
   * @param {number} toPage - End page (1-based, inclusive)
   * @returns {Promise<SearchMatch[]>}
   */
  async search(query, fromPage = 1, toPage = this.#doc.numPages) {
    if (!query.trim() || query.length < 2) return [];

    const { native, pdfDoc } = this.#doc;
    if (!native || !pdfDoc) return [];

    const matches = [];
    let matchId = 0;

    for (let pageNum = fromPage; pageNum <= toPage; pageNum++) {
      const page = pdfDoc.pages[pageNum - 1];
      if (!page) continue;

      try {
        // Use PDFium's native search
        const pageMatches = await native
          .searchInPage(pdfDoc, page, query)
          .toPromise();

        for (const match of pageMatches) {
          const rects = match.rects;
          if (!rects || rects.length === 0) continue;
          const pageHeight = page.size.height;
          const convertedRects = rects.map((rect) => ({
            x: rect.origin.x,
            y: rect.origin.y, // Convert to top-left origin
            width: rect.size.width,
            height: rect.size.height,
          }));

          matches.push({
            id: `match-${matchId++}`,
            pageNumber: pageNum,
            rects: convertedRects,
          });
        }
      } catch (error) {
        console.warn(`[Search] Error searching page ${pageNum}:`, error);
      }
    }

    return matches;
  }

  /**
   * Get page data (for outline/reference building)
   * @param {number} pageNumber - 1-based page number
   * @returns {PageData|null}
   */
  getPageIndex(pageNumber) {
    return this.#pageData.get(pageNumber) || null;
  }

  /**
   * Check if a page has been indexed
   * @param {number} pageNumber
   * @returns {boolean}
   */
  hasPage(pageNumber) {
    return this.#indexedPages.has(pageNumber);
  }

  /**
   * Get total number of indexed pages
   * @returns {number}
   */
  getPageCount() {
    return this.#doc.numPages;
  }

  /**
   * Get number of currently indexed pages
   * @returns {number}
   */
  getIndexedPageCount() {
    return this.#indexedPages.size;
  }

  /**
   * Get page dimensions
   * @param {number} pageNumber - 1-based page number
   * @returns {{width: number, height: number}|null}
   */
  getPageDimensions(pageNumber) {
    const pageData = this.#pageData.get(pageNumber);
    if (pageData) {
      return {
        width: pageData.pageWidth,
        height: pageData.pageHeight,
      };
    }

    // Fallback to document model
    const page = this.#doc.pdfDoc?.pages?.[pageNumber - 1];
    if (page) {
      return {
        width: page.size.width,
        height: page.size.height,
      };
    }

    return null;
  }

  /**
   * Get ordered lines for a page
   * @param {number} pageNumber - 1-based page number
   * @returns {OrderedLine[]|null}
   */
  getOrderedLines(pageNumber) {
    const pageData = this.#pageData.get(pageNumber);
    if (!pageData) return null;

    const items = pageData.textItems;
    if (!items || items.length === 0) return [];

    const lines = this.#groupIntoLines(items);

    return lines.map((lineItems) => {
      const text = lineItems.map((item) => item.str).join(" ");
      const fontSize = Math.max(...lineItems.map((item) => item.height));
      const fontNames = lineItems.map((item) => item.fontName).filter(Boolean);
      const fontName =
        fontNames.length > 0 ? this.#getMostCommon(fontNames) : null;
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
   * Get column-aware lines for a page
   * @param {number} pageNumber - 1-based page number
   * @returns {Object|null}
   */
  getColumnAwareLines(pageNumber) {
    const pageData = this.#pageData.get(pageNumber);
    if (!pageData) return null;

    const items = pageData.textItems;
    const pageWidth = pageData.pageWidth;
    const pageHeight = pageData.pageHeight;

    if (!items || items.length === 0) {
      return {
        pageNumber,
        pageWidth,
        pageHeight,
        columns: [{ left: 0, right: pageWidth }],
        marginLeft: 0,
        marginRight: 0,
        segments: [],
      };
    }

    // Filter out arXiv identifiers
    const filteredItems = items.filter(
      (item) => !item.str.startsWith("arXiv:"),
    );

    if (filteredItems.length === 0) {
      return {
        pageNumber,
        pageWidth,
        pageHeight,
        columns: [{ left: 0, right: pageWidth }],
        marginLeft: 0,
        marginRight: 0,
        segments: [],
      };
    }

    // Calculate margins from item positions
    const marginLeft = Math.max(0, Math.min(...filteredItems.map((i) => i.x)));
    const marginRight = Math.max(
      0,
      pageWidth - Math.max(...filteredItems.map((i) => i.x + i.width)),
    );

    // Detect column gutters
    const gutters = this.#detectColumnGutters(
      filteredItems,
      pageWidth,
      pageHeight,
    );

    // Build column boundaries
    const columns = this.#buildColumnBoundaries(
      gutters,
      pageWidth,
      marginLeft,
      marginRight,
    );

    // If single column, return simplified structure
    if (columns.length <= 1) {
      const lines = this.#groupIntoLines(filteredItems);
      const columnAwareLines = lines.map((lineItems) =>
        this.#createColumnAwareLine(
          lineItems,
          -1,
          columns[0]?.left ?? marginLeft,
        ),
      );

      return {
        pageNumber,
        pageWidth,
        pageHeight,
        columns,
        marginLeft,
        marginRight,
        segments: [
          {
            type: "full-width",
            yStart: Math.min(...filteredItems.map((i) => i.y)),
            yEnd: Math.max(...filteredItems.map((i) => i.y + i.height)),
            lines: columnAwareLines,
          },
        ],
      };
    }

    // Multi-column: segment the page
    const rawSegments = this.#segmentPageByLayout(
      filteredItems,
      columns,
      pageWidth,
      marginLeft,
      marginRight,
    );

    const segments = rawSegments.map((segment) => {
      if (segment.type === "full-width") {
        const lines = this.#groupIntoLines(segment.items);
        const columnAwareLines = lines.map((lineItems) =>
          this.#createColumnAwareLine(lineItems, -1, marginLeft),
        );

        return {
          type: "full-width",
          yStart: segment.yStart,
          yEnd: segment.yEnd,
          lines: columnAwareLines,
        };
      } else {
        const allLines = [];

        for (let colIdx = 0; colIdx < segment.columns.length; colIdx++) {
          const columnItems = segment.columns[colIdx];
          if (columnItems.length === 0) continue;

          const columnBoundary = columns[colIdx];
          const lines = this.#groupIntoLines(columnItems);

          for (const lineItems of lines) {
            const columnAwareLine = this.#createColumnAwareLine(
              lineItems,
              colIdx,
              columnBoundary.left,
            );
            allLines.push(columnAwareLine);
          }
        }

        return {
          type: "columns",
          yStart: segment.yStart,
          yEnd: segment.yEnd,
          lines: allLines,
        };
      }
    });

    return {
      pageNumber,
      pageWidth,
      pageHeight,
      columns,
      marginLeft,
      marginRight,
      segments,
    };
  }

  /**
   * Ensure a specific page is indexed
   * Used by outline/reference builders that need specific pages
   * @param {number} pageNumber
   */
  async ensurePageIndexed(pageNumber) {
    if (this.#indexedPages.has(pageNumber)) {
      return this.#pageData.get(pageNumber);
    }

    await this.#buildPageDataSafe(pageNumber);
    return this.#pageData.get(pageNumber);
  }

  /**
   * Ensure a range of pages are indexed
   * @param {number} fromPage
   * @param {number} toPage
   */
  async ensurePagesIndexed(fromPage, toPage) {
    const promises = [];
    for (let pageNum = fromPage; pageNum <= toPage; pageNum++) {
      if (!this.#indexedPages.has(pageNum)) {
        promises.push(this.#buildPageDataSafe(pageNum));
      }
    }
    await Promise.all(promises);
  }

  // =========================================
  // Private helper methods
  // =========================================

  /**
   * Group text items into lines based on Y position
   * @param {TextItem[]} items
   * @returns {TextItem[][]}
   */
  #groupIntoLines(items) {
    if (items.length === 0) return [];

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
      const threshold = Math.max(3, currentLine[0].height * 0.5);

      if (Math.abs(item.y - currentY) <= threshold) {
        currentLine.push(item);
      } else {
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
   * Create a ColumnAwareLine from a group of text items
   * @param {TextItem[]} lineItems
   * @param {number} columnIndex
   * @param {number} columnLeft
   * @returns {ColumnAwareLine}
   */
  #createColumnAwareLine(lineItems, columnIndex, columnLeft) {
    const text = lineItems.map((item) => item.str).join(" ");
    const fontSize = Math.max(...lineItems.map((item) => item.height));
    const fontNames = lineItems.map((item) => item.fontName).filter(Boolean);
    const fontName =
      fontNames.length > 0 ? this.#getMostCommon(fontNames) : null;
    const firstItem = lineItems[0];

    const tolerance = Math.max(5, fontSize * 0.6);
    const isAtColumnStart =
      firstItem.x - columnLeft < tolerance && firstItem.x - columnLeft >= 0;

    return {
      text,
      x: firstItem.x,
      y: firstItem.y,
      originalY: firstItem.originalY,
      fontSize,
      fontName,
      columnIndex,
      isAtColumnStart,
      items: lineItems,
    };
  }

  // =========================================
  // Column Detection Methods
  // =========================================

  /**
   * Detect column gutters
   * @param {TextItem[]} items
   * @param {number} pageWidth
   * @param {number} pageHeight
   * @returns {number[]}
   */
  #detectColumnGutters(items, pageWidth, pageHeight) {
    if (items.length === 0) return [];

    const lines = this.#groupIntoLines(items);
    if (lines.length < SearchIndex.MIN_LINES_FOR_COLUMN_DETECTION) return [];

    const marginLeft = Math.max(0, Math.min(...items.map((i) => i.x)) - 5);
    const marginRight = Math.max(
      0,
      pageWidth - Math.max(...items.map((i) => i.x + i.width)) - 5,
    );

    const candidateGaps = [];
    let validLineCount = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.length < 2) continue;
      validLineCount++;

      const sortedLine = [...line].sort((a, b) => a.x - b.x);

      const lineStart = sortedLine[0].x;
      const lastItem = sortedLine[sortedLine.length - 1];
      const lineEnd = lastItem.x + lastItem.width;
      const lineWidth = lineEnd - lineStart;
      const lineY = sortedLine[0].y;

      if (lineWidth <= 0) continue;

      const gaps = [];
      for (let j = 0; j < sortedLine.length - 1; j++) {
        const current = sortedLine[j];
        const next = sortedLine[j + 1];
        const gapStart = current.x + current.width;
        const gapEnd = next.x;
        const gapWidth = gapEnd - gapStart;

        if (gapWidth > 0) {
          gaps.push({
            x: (gapStart + gapEnd) / 2,
            width: gapWidth,
            start: gapStart,
            end: gapEnd,
          });
        }
      }

      if (gaps.length === 0) continue;

      let largestGap = gaps[0];
      for (const gap of gaps) {
        if (gap.width > largestGap.width) {
          largestGap = gap;
        }
      }

      const sortedGapWidths = gaps.map((g) => g.width).sort((a, b) => a - b);
      const medianGapWidth =
        sortedGapWidths[Math.floor(sortedGapWidths.length / 2)];

      const isSignificantlyLarger = largestGap.width > medianGapWidth * 1.2;
      const isSignificantPortion = largestGap.width > lineWidth * 0.03;

      if (isSignificantlyLarger || isSignificantPortion) {
        candidateGaps.push({
          ...largestGap,
          lineY,
        });
      }
    }

    const minGapsRequired = validLineCount * SearchIndex.GUTTER_LINE_THRESHOLD;
    if (candidateGaps.length === 0 || candidateGaps.length < minGapsRequired)
      return [];

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
        if (currentCluster.length >= minGapsRequired) {
          clusters.push(currentCluster);
        }
        currentCluster = [gap];
      }
    }

    if (currentCluster.length >= minGapsRequired) {
      clusters.push(currentCluster);
    }

    const validClusters = clusters.filter((cluster) => {
      const yValues = cluster.map((g) => g.lineY);
      const minY = Math.min(...yValues);
      const maxY = Math.max(...yValues);
      const coverage = (maxY - minY) / pageHeight;
      return coverage >= SearchIndex.MIN_VERTICAL_COVERAGE;
    });

    let gutters = validClusters.map((cluster) => {
      return cluster.reduce((sum, g) => sum + g.x, 0) / cluster.length;
    });

    const minEdgeDistance = pageWidth * 0.1;
    gutters = gutters.filter(
      (x) => x > minEdgeDistance && x < pageWidth - minEdgeDistance,
    );

    if (gutters.length >= SearchIndex.MAX_COLUMN_COUNT) {
      return [];
    }

    if (gutters.length > 0) {
      const contentWidth = pageWidth - marginLeft - marginRight;
      const sortedGutters = [...gutters].sort((a, b) => a - b);
      const boundaries = [
        marginLeft,
        ...sortedGutters,
        pageWidth - marginRight,
      ];

      for (let i = 0; i < boundaries.length - 1; i++) {
        const colWidth = boundaries[i + 1] - boundaries[i];
        const ratio = colWidth / contentWidth;

        if (
          ratio < SearchIndex.MIN_COLUMN_WIDTH_RATIO ||
          ratio > SearchIndex.MAX_COLUMN_WIDTH_RATIO
        ) {
          return [];
        }
      }
    }

    return gutters;
  }

  /**
   * Build column boundaries from gutter positions
   * @param {number[]} gutters
   * @param {number} pageWidth
   * @param {number} marginLeft
   * @param {number} marginRight
   * @returns {Array<{left: number, right: number}>}
   */
  #buildColumnBoundaries(gutters, pageWidth, marginLeft, marginRight) {
    if (gutters.length === 0) {
      return [{ left: marginLeft, right: pageWidth - marginRight }];
    }

    const boundaries = [];
    const sortedGutters = [...gutters].sort((a, b) => a - b);

    boundaries.push({ left: marginLeft, right: sortedGutters[0] });

    for (let i = 0; i < sortedGutters.length - 1; i++) {
      boundaries.push({ left: sortedGutters[i], right: sortedGutters[i + 1] });
    }

    boundaries.push({
      left: sortedGutters[sortedGutters.length - 1],
      right: pageWidth - marginRight,
    });

    return boundaries;
  }

  /**
   * Determine which column an item belongs to
   * @param {TextItem} item
   * @param {Array<{left: number, right: number}>} columns
   * @returns {number}
   */
  #getItemColumn(item, columns) {
    const centerX = item.x + item.width / 2;

    for (let i = 0; i < columns.length; i++) {
      if (centerX >= columns[i].left && centerX <= columns[i].right) {
        return i;
      }
    }

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
   * Check if an item is full-width
   * @param {TextItem} item
   * @param {number} pageWidth
   * @param {number} marginLeft
   * @param {number} marginRight
   * @returns {boolean}
   */
  #isFullWidthItem(item, pageWidth, marginLeft, marginRight) {
    const contentWidth = pageWidth - marginLeft - marginRight;
    return item.width >= contentWidth * SearchIndex.FULL_WIDTH_THRESHOLD;
  }

  /**
   * Segment page into layout regions
   * @param {TextItem[]} items
   * @param {Array<{left: number, right: number}>} columns
   * @param {number} pageWidth
   * @param {number} marginLeft
   * @param {number} marginRight
   * @returns {Array}
   */
  #segmentPageByLayout(items, columns, pageWidth, marginLeft, marginRight) {
    if (items.length === 0) return [];
    if (columns.length <= 1) {
      return [{ type: "full-width", yStart: 0, yEnd: Infinity, items }];
    }

    const sortedByY = [...items].sort((a, b) => a.y - b.y);

    const segments = [];
    let currentSegment = null;
    let currentType = null;

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

      const needNewSegment =
        !currentSegment ||
        itemType !== currentType ||
        (currentSegment.items &&
          item.y - currentSegment.yEnd > bandThreshold * 2);

      if (needNewSegment) {
        if (currentSegment) {
          segments.push(currentSegment);
        }

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

    if (currentSegment) {
      segments.push(currentSegment);
    }

    return segments;
  }

  /**
   * Debug method for column detection
   * @param {number} pageNumber
   * @returns {Object|null}
   */
  debugColumnDetection(pageNumber) {
    const pageData = this.#pageData.get(pageNumber);
    if (!pageData) return null;

    const items = pageData.textItems;
    const pageWidth = pageData.pageWidth;
    const pageHeight = pageData.pageHeight;

    const lines = this.#groupIntoLines(items);
    const gutters = this.#detectColumnGutters(items, pageWidth, pageHeight);

    return {
      pageNumber,
      pageWidth,
      pageHeight,
      totalLines: lines.length,
      indexedItems: items.length,
      guttersDetected: gutters,
      thresholds: {
        minLines: SearchIndex.MIN_LINES_FOR_COLUMN_DETECTION,
        gutterLineThreshold: SearchIndex.GUTTER_LINE_THRESHOLD,
        clusterTolerance: pageWidth * SearchIndex.CLUSTER_TOLERANCE_RATIO,
        minVerticalCoverage: SearchIndex.MIN_VERTICAL_COVERAGE,
        maxColumnCount: SearchIndex.MAX_COLUMN_COUNT,
        minColumnWidthRatio: SearchIndex.MIN_COLUMN_WIDTH_RATIO,
        maxColumnWidthRatio: SearchIndex.MAX_COLUMN_WIDTH_RATIO,
      },
    };
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this.#pageData.clear();
    this.#indexedPages.clear();
    this.#isBuilt = false;
    this.#isBuilding = false;
    this.#buildProgress = 0;
    this.#lowLevelHandle = null; // Don't close - owned by PDFDocumentModel
  }
}
