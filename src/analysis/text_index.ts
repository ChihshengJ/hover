/**
 * DocumentTextIndex - Text extraction and indexing for outline/reference building
 * Optimized for PDFium which provides column-ordered, line-break-aware text slices
 *
 */

/** A glyph run inside a line. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** FontStyle enum value. */
  fontStyle: number;
  fontSize: number;
}

/** A glyph run as it comes off the source, before lines are formed. */
interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string | null;
  fontSize: number;
  originalY: number;
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  originalY: number;
  lineHeight: number;
  lineWidth: number;
  fontSize: number;
  /** FontStyle enum value. */
  fontStyle: number;
  items: TextItem[];
}

export interface PageTextData {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginBottom: number;
  lines: TextLine[];
  headerLines: TextLine[];
  footerLines: TextLine[];
  /** PDF-native y of the header separator rule, if the page has one. */
  headerSepY: number | null;
  footerSepY: number | null;
  multiColumn: boolean;
  /** Column left edges, ascending, when `multiColumn`. */
  columnXs: number[] | null;
}

/**
 * Everything this index needs from whatever produced the document. PDFium
 * implements it in `src/pdf/page_source.js`; a serialized fixture can implement
 * it just as well, which is the point — nothing below this interface knows what
 * a PDF is.
 */
export interface PageSource {
  numPages: number;
  getPageSize(pageNumber: number): { width: number; height: number } | null;
  /** Raw glyph runs, 1-based page. */
  getPageTextSlices(pageNumber: number): Promise<any[]>;
  /** Path objects used for header/footer rules. */
  getPagePaths(pageNumber: number): PathObjectInfo[];
}

export const FontStyle = Object.freeze({
  REGULAR: 0,
  BOLD: 1,
  ITALIC: 2,
  BOLD_ITALIC: 3,
});

export class DocumentTextIndex {
  #source: PageSource = null;
  #pageData = new Map<number, PageTextData>();
  #indexedPages = new Set<number>();
  #bodyFontSize: number | null = null;
  #bodyLineHeight: number | null = null;
  #bodyLineWidth: number | null = null;
  #bodyMarginBottom: number | null = null;
  #bodyFontStyle: number | null = null;
  #bodyFontAnalyzed = false;
  #headerHeight: number | null = null;
  #footerHeight: number | null = null;
  #headerFooterAnalyzed = false;

  constructor(source: PageSource) {
    this.#source = source;
  }

  getPageCount() {
    return this.#source.numPages;
  }

  hasPage(pageNumber: number): boolean {
    return this.#indexedPages.has(pageNumber);
  }

  getPageData(pageNumber: number): PageTextData | null {
    return this.#pageData.get(pageNumber) || null;
  }

  getDocumentData() {
    const info = {
      fontSize: this.getBodyFontSize(),
      fontStyle: this.getBodyFontStyle(),
      lineHeight: this.getBodyLineHeight(),
      lineWidth: this.getBodyLineWidth(),
      marginBottom: this.getBodyMarginBottom(),
      headerHeight: this.getHeaderHeight(),
      footerHeight: this.getFooterHeight(),
      pageData: this.#pageData,
    };
    return info;
  }

  getDocumentMetrics() {
    const info = {
      fontSize: this.getBodyFontSize(),
      fontStyle: this.getBodyFontStyle(),
      lineHeight: this.getBodyLineHeight(),
      lineWidth: this.getBodyLineWidth(),
      marginBottom: this.getBodyMarginBottom(),
      headerHeight: this.getHeaderHeight(),
      footerHeight: this.getFooterHeight(),
    };
    return info;
  }

  getPageLines(pageNumber: number): TextLine[] | null {
    return this.#pageData.get(pageNumber)?.lines || null;
  }

  getPageDimensions(pageNumber: number) {
    const data = this.#pageData.get(pageNumber);
    if (data) {
      return {
        width: data.pageWidth,
        height: data.pageHeight,
        multiColumn: data.multiColumn,
        columnXs: data.columnXs ?? null,
      };
    }
    const size = this.#source.getPageSize(pageNumber);
    if (size) {
      return {
        width: size.width,
        height: size.height,
        multiColumn: false,
        columnXs: null,
      };
    }
    return null;
  }

  /**
   * Map an absolute x position (PDF units, page coordinate space) to a column
   * index for the given page.
   *
   * Returns -1 for single-column pages (full-width), or when column geometry is
   * unavailable, so callers can treat such content as spanning the page. For a
   * multi-column page, returns 0 for the left column, 1 for the next, etc.,
   * using the midpoints between detected column left-edges as boundaries.
   *
   * @param {number} pageNumber - 1-based page number
   * @param {number} x - X position in PDF units
   * @returns {number} Column index, or -1 for full-width/unknown
   */
  getColumnIndexForX(pageNumber: number, x: number): number {
    const data = this.#pageData.get(pageNumber);
    const xs = data?.columnXs;
    if (!data?.multiColumn || !xs || xs.length < 2) return -1;

    let idx = 0;
    for (let i = 1; i < xs.length; i++) {
      const boundary = (xs[i - 1] + xs[i]) / 2;
      if (x >= boundary) idx = i;
      else break;
    }
    return idx;
  }

  getBodyFontSize() {
    this.#ensureBodyFontAnalyzed();
    return this.#bodyFontSize ?? 10;
  }

  getBodyFontStyle() {
    this.#ensureBodyFontAnalyzed();
    return this.#bodyFontStyle ?? FontStyle.REGULAR;
  }

  getBodyLineHeight() {
    this.#ensureBodyFontAnalyzed();
    return this.#bodyLineHeight ?? 10;
  }

  getBodyLineWidth() {
    this.#ensureBodyFontAnalyzed();
    return this.#bodyLineWidth ?? 200;
  }

  getBodyMarginBottom() {
    this.#ensureBodyFontAnalyzed();
    return this.#bodyMarginBottom ?? 0;
  }

  getHeaderHeight() {
    this.#ensureHeaderFooterAnalyzed();
    return this.#headerHeight ?? 0;
  }

  getFooterHeight() {
    this.#ensureHeaderFooterAnalyzed();
    return this.#footerHeight ?? 0;
  }

  async ensurePageIndexed(pageNumber: number) {
    if (this.#indexedPages.has(pageNumber)) {
      return this.#pageData.get(pageNumber);
    }
    await this.#indexPage(pageNumber);
    return this.#pageData.get(pageNumber);
  }

  async ensurePagesIndexed(fromPage: number, toPage: number) {
    const promises = [];
    for (let p = fromPage; p <= toPage; p++) {
      if (!this.#indexedPages.has(p)) {
        promises.push(this.#indexPage(p));
      }
    }
    await Promise.all(promises);
  }

  async build(
    onProgress: ((page: number, total: number, percent: number) => void) | null = null,
  ) {
    const numPages = this.#source.numPages;
    for (let p = 1; p <= numPages; p++) {
      if (!this.#indexedPages.has(p)) {
        await this.#indexPage(p);
      }
      if (onProgress) {
        onProgress(p, numPages, Math.round((p / numPages) * 100));
      }
    }
  }

  async #indexPage(pageNumber: number) {
    const size = this.#source.getPageSize(pageNumber);
    if (!size) {
      this.#storeEmpty(pageNumber);
      return;
    }

    const pageWidth = size.width;
    const pageHeight = size.height;

    try {
      const textSlices =
        (await this.#source.getPageTextSlices(pageNumber)) || [];

      const items = this.#convertSlices(textSlices, pageHeight);
      const lines = this.#groupIntoLines(items, pageHeight);
      const marginLeft = this.#estimateMarginLeft(lines, pageWidth);
      const marginBottom =
        lines.length > 0 ? Math.min(...lines.map((l) => l.y)) : 0;

      const paths = this.#source.getPagePaths(pageNumber) || [];
      const { headerLines, footerLines, headerSepY, footerSepY } =
        this.#detectHeaderFooter(lines, paths, pageWidth, pageHeight);

      this.#headerFooterAnalyzed = false;

      const { multiColumn, columnXs } = this.#detectMultiColumn(
        lines,
        headerLines,
        footerLines,
        pageWidth,
      );

      this.#pageData.set(pageNumber, {
        pageNumber,
        pageWidth,
        pageHeight,
        marginLeft,
        marginBottom,
        lines,
        headerLines,
        footerLines,
        headerSepY,
        footerSepY,
        multiColumn,
        columnXs,
      });
      this.#indexedPages.add(pageNumber);
    } catch (error) {
      console.warn(
        `[TextIndex] Error indexing page ${pageNumber}:`,
        error instanceof Error ? error.message : error,
      );
      this.#storeEmpty(pageNumber, pageWidth, pageHeight);
    }
  }

  #convertSlices(slices: any[], pageHeight: number): RawItem[] {
    if (!slices?.length) return [];

    const items: RawItem[] = [];
    for (const slice of slices) {
      const content = slice.content || "";
      if (!content || !content.trim()) continue;

      items.push({
        str: content,
        x: slice.rect.origin.x,
        y: slice.rect.origin.y,
        width: slice.rect.size.width,
        height: slice.rect.size.height,
        fontName: slice.font?.family || slice.font?.famliy || null,
        fontSize: slice.font.size || slice.rect.size.height,
        originalY: pageHeight - slice.rect.origin.y + 1,
      });
    }
    return items;
  }

  #groupIntoLines(items: RawItem[], pageHeight: number): TextLine[] {
    if (items.length === 0) return [];

    const lines: TextLine[] = [];
    let currentLine = [items[0]];
    let currentY = items[0].y;

    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      const threshold = Math.max(5, currentLine[0].height);

      if (Math.abs(item.y - currentY) <= threshold) {
        currentLine.push(item);
      } else {
        lines.push(this.#createLine(currentLine));
        currentLine = [item];
        currentY = item.y;
      }
    }
    lines.push(this.#createLine(currentLine));

    return lines;
  }

  #createLine(items: RawItem[]): TextLine {
    const first = items[0];
    const text = items.map((it) => it.str).join("");
    const fontStyle = this.#extractFontStyle(items);
    const fontSize = this.#findMedian(items.map((i) => i.fontSize));

    const lineHeight = this.#findMedian(
      items.filter((i) => i.height > 2).map((i) => i.height),
    );
    const lineWidth = items.at(-1).x + items.at(-1).width - items[0].x;
    const lineBottom = this.#findMedian(items.map((i) => i.originalY));

    const lineItems = items.map((it) => ({
      str: it.str,
      x: it.x,
      y: it.y,
      width: it.width,
      height: it.height,
      fontStyle: this.#extractItemFontStyle(it.fontName),
      fontSize: it.fontSize,
    }));

    return {
      text,
      x: first.x,
      y: first.y,
      originalY: lineBottom,
      lineHeight,
      lineWidth,
      fontSize,
      fontStyle,
      items: lineItems,
    };
  }

  #extractItemFontStyle(fontName: string | null): number {
    if (!fontName) return FontStyle.REGULAR;
    const lower = fontName.toLowerCase();

    const isBold =
      lower.includes("bold") ||
      lower.includes("black") ||
      lower.includes("heavy") ||
      lower.includes("semibold") ||
      lower.includes("-bd") ||
      lower.includes("-medi") ||
      fontName.includes("SFSX") ||
      /cmbx/.test(lower);

    const isItalic =
      lower.includes("italic") ||
      lower.includes("ital") ||
      lower.includes("oblique") ||
      lower.includes("slant") ||
      lower.includes("-it");

    if (isBold && isItalic) return FontStyle.BOLD_ITALIC;
    if (isBold) return FontStyle.BOLD;
    if (isItalic) return FontStyle.ITALIC;
    return FontStyle.REGULAR;
  }

  #extractFontStyle(items: RawItem[]): number {
    let hasBold = false;
    let hasItalic = false;

    for (const item of items) {
      const style = this.#extractItemFontStyle(item.fontName);
      if (style === FontStyle.BOLD || style === FontStyle.BOLD_ITALIC)
        hasBold = true;
      if (style === FontStyle.ITALIC || style === FontStyle.BOLD_ITALIC)
        hasItalic = true;
      if (hasBold && hasItalic) break;
    }

    if (hasBold && hasItalic) return FontStyle.BOLD_ITALIC;
    if (hasBold) return FontStyle.BOLD;
    if (hasItalic) return FontStyle.ITALIC;
    return FontStyle.REGULAR;
  }

  /**
   * Detect header/footer lines and separator positions for a single page.
   * All Y coordinates use PDF native bottom-left origin (higher Y = top of page).
   *
   * @param paths from extractPagePaths
   */
  #detectHeaderFooter(
    lines: TextLine[],
    paths: PathObjectInfo[],
    pageWidth: number,
    pageHeight: number,
  ): {
    headerLines: TextLine[];
    footerLines: TextLine[];
    headerSepY: number | null;
    footerSepY: number | null;
  } {
    // Separator-rule y positions, not lines — the lines are collected below.
    const headerCandidates: number[] = [];
    const footerCandidates: number[] = [];

    for (const path of paths) {
      const { pdfRect } = path;
      const pathWidth = pdfRect.right - pdfRect.left;

      // extractPagePaths has already applied the thickness test; all that is
      // left here is "spans enough of the page to be a separator".
      if (pathWidth <= pageWidth * 0.6) continue;

      // Header zone (top 15%): high Y in PDF coords
      if (pdfRect.bottom > pageHeight * 0.85) {
        headerCandidates.push(pdfRect.bottom);
      }
      // Footer zone (bottom 15%): low Y in PDF coords
      if (pdfRect.top < pageHeight * 0.15) {
        footerCandidates.push(pdfRect.top);
      }
    }
    // Use median so a stray rule (e.g. a table border that leaks into the
    // header/footer zone) can't drag the separator away from the true one.
    const headerSepY =
      headerCandidates.length > 0 ? this.#findMedian(headerCandidates) : null;
    const footerSepY =
      footerCandidates.length > 0 ? this.#findMedian(footerCandidates) : null;

    const headerThreshold = headerSepY ?? pageHeight * 0.9;
    const footerThreshold = footerSepY ?? pageHeight * 0.1;

    const headerLines: TextLine[] = [];
    const footerLines: TextLine[] = [];

    for (const line of lines) {
      if (line.y > headerThreshold) {
        if (this.#isHeaderFooterCandidate(line, pageWidth)) {
          headerLines.push(line);
        }
      } else if (line.y < footerThreshold) {
        if (this.#isHeaderFooterCandidate(line, pageWidth)) {
          footerLines.push(line);
        }
      }
    }

    return { headerLines, footerLines, headerSepY, footerSepY };
  }

  /**
   * Check if a line looks like a header/footer (short, not spanning full width).
   */
  #isHeaderFooterCandidate(line: TextLine, pageWidth: number): boolean {
    if (line.text.trim().length > 120) return false;
    if (line.lineWidth > pageWidth * 0.7) return false;
    return true;
  }

  /**
   * Detect whether a page has a multi-column layout by clustering x-positions
   * of body-text lines.
   *
   * Returns both the boolean flag and, when multi-column, the column left-edge
   * x-positions (sorted ascending, in PDF units). Callers can map any x to a
   * column index via {@link getColumnIndexForX}.
   *
   */
  #detectMultiColumn(
    lines: TextLine[],
    headerLines: TextLine[],
    footerLines: TextLine[],
    pageWidth: number,
  ): { multiColumn: boolean; columnXs: number[] | null } {
    const excludeSet = new Set<TextLine>();
    for (const hl of headerLines) excludeSet.add(hl);
    for (const fl of footerLines) excludeSet.add(fl);

    const bodyLines = lines.filter(
      (l) =>
        !excludeSet.has(l) &&
        l.text.trim().length > 10 &&
        l.lineWidth < pageWidth * 0.6,
    );

    if (bodyLines.length < 6) return { multiColumn: false, columnXs: null };

    const quantize = (v: number) => Math.round(v / 2) * 2;
    const xCounts = new Map<number, number>();
    for (const line of bodyLines) {
      const qx = quantize(line.x);
      xCounts.set(qx, (xCounts.get(qx) || 0) + 1);
    }

    // Find the two most frequent x-positions
    const sorted = [...xCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length < 2) return { multiColumn: false, columnXs: null };

    const [x1, count1] = sorted[0];
    const [x2, count2] = sorted[1];

    const multiColumn =
      count1 >= 3 && count2 >= 3 && Math.abs(x1 - x2) > pageWidth * 0.2;

    return {
      multiColumn,
      columnXs: multiColumn ? [x1, x2].sort((a, b) => a - b) : null,
    };
  }

  /**
   * Estimate the true body-text left margin using mode of x positions,
   * filtering out outlier lines (short page numbers, wide banners, etc.).
   */
  #estimateMarginLeft(lines: TextLine[], pageWidth: number): number {
    if (lines.length === 0) return 0;

    const quantize = (v: number) => Math.round(v * 2) / 2;
    const xCounts = new Map<number, number>();
    const filteredLines = lines.filter((l) => l.text.length > 10).slice(0, 10);

    for (const line of filteredLines) {
      if (line.text.length < 10) continue;
      if (line.lineWidth > pageWidth * 0.9) continue;

      const qx = quantize(line.x);
      xCounts.set(qx, (xCounts.get(qx) || 0) + 1);
    }

    if (xCounts.size === 0) {
      for (const line of lines) {
        const qx = quantize(line.x);
        xCounts.set(qx, (xCounts.get(qx) || 0) + 1);
      }
    }

    if (xCounts.size === 0) return 0;

    let bestX = 0;
    let bestCount = 0;
    for (const [x, count] of xCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestX = x;
      }
    }

    return bestX;
  }

  #storeEmpty(pageNumber: number, pageWidth = 0, pageHeight = 0) {
    if (!pageWidth || !pageHeight) {
      const size = this.#source.getPageSize(pageNumber);
      if (size) {
        pageWidth = size.width;
        pageHeight = size.height;
      }
    }
    this.#pageData.set(pageNumber, {
      pageNumber,
      pageWidth,
      pageHeight,
      marginLeft: 0,
      marginBottom: 0,
      lines: [],
      headerLines: [],
      footerLines: [],
      headerSepY: null,
      footerSepY: null,
      multiColumn: false,
      columnXs: null,
    });
    this.#indexedPages.add(pageNumber);
  }

  #ensureBodyFontAnalyzed() {
    if (this.#bodyFontAnalyzed) return;
    this.#bodyFontAnalyzed = true;

    const fontSizes: number[] = [];
    const fontStyles: number[] = [];
    const lineHeights: number[] = [];
    const lineWidths: number[] = [];
    const marginBottoms: number[] = [];
    let count = 0;

    for (const [, data] of this.#pageData) {
      if (count > 5) break;
      if (data.marginBottom > 0) marginBottoms.push(data.marginBottom);

      const excludeSet = new Set<TextLine>();
      if (data.headerLines) {
        for (const hl of data.headerLines) excludeSet.add(hl);
      }
      if (data.footerLines) {
        for (const fl of data.footerLines) excludeSet.add(fl);
      }

      const bodyLines =
        excludeSet.size > 0
          ? data.lines.filter((l) => !excludeSet.has(l)).slice(5, 40)
          : data.lines.slice(5, 40);

      for (const line of bodyLines) {
        if (line.fontSize > 0) fontSizes.push(line.fontSize);
        if (line.lineHeight > 0) lineHeights.push(line.lineHeight);
        if (line.lineWidth > 0) lineWidths.push(Math.floor(line.lineWidth));
        fontStyles.push(line.fontStyle);
      }
      count++;
    }

    if (fontSizes.length === 0) return;

    this.#bodyFontSize = this.#findMostCommon(
      fontSizes.map((s) => Math.round(s * 10) / 10),
    );
    this.#bodyFontStyle = this.#findMostCommon(fontStyles);
    this.#bodyLineHeight = this.#findMedian(lineHeights);
    this.#bodyLineWidth = this.#findMostCommon(lineWidths);
    this.#bodyMarginBottom = this.#findMostCommon(marginBottoms);
  }

  #ensureHeaderFooterAnalyzed() {
    if (this.#headerFooterAnalyzed) return;
    this.#headerFooterAnalyzed = true;

    const headerExtents: number[] = [];
    const footerExtents: number[] = [];
    let count = 0;

    for (const [pageNum, data] of this.#pageData) {
      if (count >= 10) break;
      // Skip the first page: titles, abstracts, and author blocks live there
      // and would otherwise be classified as header/footer text.
      if (pageNum === 1) continue;
      count++;

      // Only count a page when it has a confirmed separator rule. Short text
      // near the top/bottom isn't enough — papers without running headers
      // should report 0 height.
      if (data.headerSepY !== null && data.headerSepY !== undefined) {
        headerExtents.push(data.pageHeight - data.headerSepY);
      }
      if (data.footerSepY !== null && data.footerSepY !== undefined) {
        footerExtents.push(data.footerSepY);
      }
    }

    if (headerExtents.length >= 2) {
      this.#headerHeight = this.#findMostCommon(headerExtents);
    }
    if (footerExtents.length >= 2) {
      this.#footerHeight = this.#findMostCommon(footerExtents);
    }
  }

  #findMedian(arr: number[]): number {
    const sortedArr = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sortedArr.length / 2);
    return sortedArr[mid];
  }

  #findMostCommon(arr: number[]): number {
    const counts = new Map<number, number>();
    for (const val of arr) {
      counts.set(val, (counts.get(val) || 0) + 1);
    }
    let maxCount = 0;
    let result = arr[0];
    for (const [val, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        result = val;
      }
    }
    return result;
  }

  destroy() {
    this.#pageData.clear();
    this.#indexedPages.clear();
    this.#bodyFontSize = null;
    this.#bodyLineHeight = null;
    this.#bodyFontStyle = null;
    this.#bodyFontAnalyzed = false;
    this.#headerHeight = null;
    this.#footerHeight = null;
    this.#headerFooterAnalyzed = false;
  }
}
