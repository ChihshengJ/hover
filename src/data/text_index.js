/**
 * DocumentTextIndex - Text extraction and indexing for outline/reference building
 * Optimized for PDFium which provides column-ordered, line-break-aware text slices
 *
 * @typedef {Object} TextItem
 * @property {string} str
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} fontStyle - FontStyle enum value
 *
 * @typedef {Object} TextLine
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} originalY
 * @property {number} fontSize
 * @property {number} fontStyle - FontStyle enum value
 * @property {number} isCommonFont - 0 or 1
 * @property {boolean} isAtLineStart
 * @property {TextItem[]} items
 *
 * @typedef {Object} PageTextData
 * @property {number} pageNumber
 * @property {number} pageWidth
 * @property {number} pageHeight
 * @property {number} marginLeft
 * @property {TextLine[]} lines
 * @property {string} fullText
 */

export const FontStyle = Object.freeze({
  REGULAR: 0,
  BOLD: 1,
  ITALIC: 2,
  BOLD_ITALIC: 3,
});

export class DocumentTextIndex {
  #doc = null;
  #pageData = new Map();
  #indexedPages = new Set();
  #lowLevelHandle = null;
  #bodyFontSize = null;
  #bodyLineHeight = null;
  #bodyFontStyle = null;
  #bodyFontAnalyzed = false;

  constructor(doc) {
    this.#doc = doc;
  }

  setLowLevelHandle(handle) {
    this.#lowLevelHandle = handle;
  }

  getPageCount() {
    return this.#doc.numPages;
  }

  hasPage(pageNumber) {
    return this.#indexedPages.has(pageNumber);
  }

  getPageData(pageNumber) {
    return this.#pageData.get(pageNumber) || null;
  }

  getPageLines(pageNumber) {
    return this.#pageData.get(pageNumber)?.lines || null;
  }

  getPageDimensions(pageNumber) {
    const data = this.#pageData.get(pageNumber);
    if (data) {
      return { width: data.pageWidth, height: data.pageHeight };
    }
    const page = this.#doc.pdfDoc?.pages?.[pageNumber - 1];
    if (page) {
      return { width: page.size.width, height: page.size.height };
    }
    return null;
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
    return this.#bodyLineHeight ?? FontStyle.REGULAR;
  }

  async ensurePageIndexed(pageNumber) {
    if (this.#indexedPages.has(pageNumber)) {
      return this.#pageData.get(pageNumber);
    }
    await this.#indexPage(pageNumber);
    return this.#pageData.get(pageNumber);
  }

  async ensurePagesIndexed(fromPage, toPage) {
    const promises = [];
    for (let p = fromPage; p <= toPage; p++) {
      if (!this.#indexedPages.has(p)) {
        promises.push(this.#indexPage(p));
      }
    }
    await Promise.all(promises);
  }

  async build(onProgress = null) {
    const numPages = this.#doc.numPages;
    for (let p = 1; p <= numPages; p++) {
      if (!this.#indexedPages.has(p)) {
        await this.#indexPage(p);
      }
      if (onProgress) {
        onProgress(p, numPages, Math.round((p / numPages) * 100));
      }
    }
  }

  async #indexPage(pageNumber) {
    const page = this.#doc.pdfDoc?.pages?.[pageNumber - 1];
    if (!page) {
      this.#storeEmpty(pageNumber);
      return;
    }

    const pageWidth = page.size.width;
    const pageHeight = page.size.height;

    try {
      let textSlices = [];
      let fullText = "";

      if (this.#lowLevelHandle) {
        const result = this.#lowLevelHandle.extractPageText(pageNumber - 1);
        textSlices = result.textSlices || [];
        fullText = result.fullText || "";
      } else {
        const { native, pdfDoc } = this.#doc;
        if (native && pdfDoc) {
          textSlices = await native.getPageTextRects(pdfDoc, page).toPromise();
          fullText = textSlices.map((s) => s.content || "").join(" ");
        }
      }

      const items = this.#convertSlices(textSlices, pageHeight);
      const lines = this.#groupIntoLines(items, pageHeight);
      const marginLeft =
        lines.length > 0 ? Math.min(...lines.map((l) => l.x)) : 0;

      for (const line of lines) {
        line.isAtLineStart = true;
        // line.x - marginLeft < Math.max(5, line.fontSize * 0.6);
      }

      this.#pageData.set(pageNumber, {
        pageNumber,
        pageWidth,
        pageHeight,
        marginLeft,
        lines,
        fullText: fullText || lines.map((l) => l.text).join(" "),
      });
      this.#indexedPages.add(pageNumber);
    } catch (error) {
      console.warn(
        `[TextIndex] Error indexing page ${pageNumber}:`,
        error.message,
      );
      this.#storeEmpty(pageNumber, pageWidth, pageHeight);
    }
  }

  #convertSlices(slices, pageHeight) {
    if (!slices?.length) return [];

    const items = [];
    for (const slice of slices) {
      const content = slice.content || "";
      if (!content || !content.trim()) continue;
      if (/\p{Cc}/gu.test(content)) continue;

      items.push({
        str: content,
        x: slice.rect.origin.x,
        y: slice.rect.origin.y,
        width: slice.rect.size.width,
        height: slice.rect.size.height,
        fontName: slice.font?.family || slice.font?.famliy || null,
        fontSize: slice.font.size || slice.rect.size.height,
        originalY: pageHeight - slice.rect.origin.y,
      });
    }
    return items;
  }

  #groupIntoLines(items, pageHeight) {
    if (items.length === 0) return [];

    const lines = [];
    let currentLine = [items[0]];
    let currentY = items[0].y;

    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      if (item.str.startsWith("arXiv:")) continue;
      const threshold = Math.max(4, currentLine[0].height * 1.2);

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

  #createLine(items) {
    // Use median height to get line height as the font size for better accuracy
    const first = items[0];
    const text = items.map((it) => it.str).join("");
    const fontStyle = this.#extractFontStyle(items);
    const fontSize = this.#findMedian(items.map(i => i.fontSize));

    const lineHeight = this.#findMedian(items.map(i => i.height));

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
      originalY: first.originalY,
      lineHeight,
      fontSize,
      fontStyle,
      isCommonFont: 0,
      isAtLineStart: false,
      items: lineItems,
    };
  }

  #extractItemFontStyle(fontName) {
    if (!fontName) return FontStyle.REGULAR;
    const lower = fontName.toLowerCase();

    const isBold =
      lower.includes("bold") ||
      lower.includes("black") ||
      lower.includes("heavy") ||
      lower.includes("semibold") ||
      lower.includes("-bd") ||
      lower.includes("-medi") ||
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

  #extractFontStyle(items) {
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

  #storeEmpty(pageNumber, pageWidth = 0, pageHeight = 0) {
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
      marginLeft: 0,
      lines: [],
      fullText: "",
    });
    this.#indexedPages.add(pageNumber);
  }

  #ensureBodyFontAnalyzed() {
    if (this.#bodyFontAnalyzed) return;
    this.#bodyFontAnalyzed = true;

    const fontSizes = [];
    const fontStyles = [];
    const lineHeights = [];

    for (const [, data] of this.#pageData) {
      for (const line of data.lines) {
        if (line.fontSize > 0) fontSizes.push(line.fontSize);
        if (line.lineHeight > 0) lineHeights.push(line.lineHeight);
        fontStyles.push(line.fontStyle);
      }
    }

    if (fontSizes.length === 0) return;

    this.#bodyFontSize = this.#findMostCommon(
      fontSizes.map((s) => Math.round(s * 10) / 10),
    );
    this.#bodyFontStyle = this.#findMostCommon(fontStyles);
    this.#bodyLineHeight = this.#findMedian(lineHeights);

    for (const [, data] of this.#pageData) {
      for (const line of data.lines) {
        const sizeMatch = Math.abs(line.fontSize - this.#bodyFontSize) < 0.5;
        const styleMatch = line.fontStyle === this.#bodyFontStyle;
        line.isCommonFont = sizeMatch && styleMatch ? 1 : 0;
      }
    }
  }

  #findMedian(arr) {
    const sortedArr = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sortedArr.length / 2);
    return sortedArr[mid];
  }

  #findMostCommon(arr) {
    const counts = new Map();
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
    this.#lowLevelHandle = null;
    this.#bodyFontSize = null;
    this.#bodyLineHeight = null;
    this.#bodyFontStyle = null;
    this.#bodyFontAnalyzed = false;
  }
}
