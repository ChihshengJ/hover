/**
 * @typedef {import('pdfjs-dist').PDFDocumentProxy} PDFDocumentProxy;
 */

import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const AnnotationEditorType = {
  DISABLE: -1,
  NONE: 0,
  FREETEXT: 3,
  HIGHLIGHT: 9,
  STAMP: 13,
  INK: 15,
};

const AnnotationEditorPrefix = "pdfjs_internal_editor_";

// Color name to RGB (0-255 range) mapping for PDF.js annotationStorage
const COLOR_TO_RGB = {
  yellow: [255, 179, 0],
  red: [229, 57, 53],
  blue: [30, 136, 229],
  green: [67, 160, 71],
};

// FreeText annotation settings
const FREETEXT_CONFIG = {
  fontSize: 10,
  fontColor: [0, 0, 0], // Black text
  width: 100, // Width of comment box in PDF points
  rightMargin: 0, // Distance from right edge
  padding: 5, // Internal padding
};

export class PDFDocumentModel {
  constructor() {
    this.pdfDoc = null;
    this.allNamedDests = null;
    this.pageDimensions = [];
    this.highlights = new Map();
    this.subscribers = new Set();

    this.annotations = new Map();
    this.annotationsByPage = new Map();
  }

  /**
   * Check if there's a locally uploaded PDF in sessionStorage
   * @returns {boolean}
   */
  static hasLocalPdf() {
    return sessionStorage.getItem("hover_pdf_data") !== null;
  }

  /**
   * Get locally uploaded PDF data from sessionStorage
   * @returns {{data: ArrayBuffer, name: string} | null}
   */
  static getLocalPdf() {
    const base64 = sessionStorage.getItem("hover_pdf_data");
    const name = sessionStorage.getItem("hover_pdf_name") || "document.pdf";
    
    if (!base64) return null;
    
    try {
      // Convert base64 back to ArrayBuffer
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { data: bytes.buffer, name };
    } catch (error) {
      console.error("Error parsing local PDF from sessionStorage:", error);
      return null;
    }
  }

  /**
   * Clear locally uploaded PDF from sessionStorage
   */
  static clearLocalPdf() {
    sessionStorage.removeItem("hover_pdf_data");
    sessionStorage.removeItem("hover_pdf_name");
  }

  async load(source) {
    if (source instanceof ArrayBuffer) {
      this.pdfDoc = await pdfjsLib.getDocument({ data: source }).promise;
    } else {
      try {
        // Try direct fetch first
        this.pdfDoc = await pdfjsLib.getDocument(source).promise;
      } catch (error) {
        // Check if it's a CORS or network error
        if (this.#isCorsOrNetworkError(error)) {
          console.log("CORS error detected, falling back to background fetch...");
          const arrayBuffer = await this.#fetchViaBackground(source);
          this.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        } else {
          throw error;
        }
      }
    }
    this.allNamedDests = await this.pdfDoc.getDestinations();
    this.loadAnnotations(this.pdfDoc);
    await this.#cachePageDimensions();
    return this.pdfDoc;
  }

  /**
   * Check if error is likely a CORS or network error
   * @param {Error} error
   * @returns {boolean}
   */
  #isCorsOrNetworkError(error) {
    const message = error?.message?.toLowerCase() || "";
    return (
      message.includes("cors") ||
      message.includes("cross-origin") ||
      message.includes("network") ||
      message.includes("failed to fetch") ||
      message.includes("load pdf") ||
      error.name === "MissingPDFException" ||
      error.name === "UnexpectedResponseException"
    );
  }

  /**
   * Fetch PDF via background script to bypass CORS
   * @param {string} url
   * @returns {Promise<ArrayBuffer>}
   */
  async #fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        reject(new Error("Chrome runtime not available"));
        return;
      }

      chrome.runtime.sendMessage(
        { type: "FETCH_PDF", query: url },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          if (response?.data) {
            const arrayBuffer = new Uint8Array(response.data).buffer;
            resolve(arrayBuffer);
          } else {
            reject(new Error("No data received from background"));
          }
        }
      );
    });
  }

  async #cachePageDimensions() {
    const numPages = this.pdfDoc.numPages;
    this.pageDimensions = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      this.pageDimensions.push({
        width: viewport.width,
        height: viewport.height,
      });
    }
  }

  get numPages() {
    return this.pdfDoc?.numPages || 0;
  }

  subscribe(pane) {
    this.subscribers.add(pane);
  }

  unsubscribe(pane) {
    this.subscribers.delete(pane);
  }

  addHighlight(pageNum, highlight) {
    if (!this.highlights.has(pageNum)) {
      this.highlights.set(pageNum, []);
    }
    this.highlights.get(pageNum).push({
      id: crypto.randomUUID(),
      ...highlight,
      timestamp: Date.now(),
    });
    this.notify("highlight-added", { pageNum, highlight });
  }

  #generateAnnotationId() {
    return `annotation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add a new annotation
   * @param {Object} annotationData
   * @returns {Object} The created annotation
   */
  addAnnotation(annotationData) {
    const annotation = {
      id: this.#generateAnnotationId(),
      type: annotationData.type, // 'highlight' or 'underscore'
      color: annotationData.color, // 'yellow', 'red', 'blue', 'green'
      pageRanges: annotationData.pageRanges, // [{pageNumber, rects, text}]
      comment: annotationData.comment || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.annotations.set(annotation.id, annotation);

    // Index by page
    for (const pageRange of annotation.pageRanges) {
      if (!this.annotationsByPage.has(pageRange.pageNumber)) {
        this.annotationsByPage.set(pageRange.pageNumber, new Set());
      }
      this.annotationsByPage.get(pageRange.pageNumber).add(annotation.id);
    }

    // Notify subscribers
    this.notify("annotation-added", { annotation });

    return annotation;
  }

  /**
   * Update an existing annotation
   * @param {string} id
   * @param {Object} updates
   * @returns {Object|null} The updated annotation
   */
  updateAnnotation(id, updates) {
    const annotation = this.annotations.get(id);
    if (!annotation) return null;

    // Apply updates
    if (updates.color !== undefined) annotation.color = updates.color;
    if (updates.type !== undefined) annotation.type = updates.type;
    if (updates.comment !== undefined) annotation.comment = updates.comment;
    annotation.updatedAt = new Date().toISOString();

    // Notify subscribers
    this.notify("annotation-updated", { annotation });

    return annotation;
  }

  /**
   * Delete an annotation
   * @param {string} id
   * @returns {boolean} Success
   */
  deleteAnnotation(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    // Remove from page index
    for (const pageRange of annotation.pageRanges) {
      const pageAnnotations = this.annotationsByPage.get(pageRange.pageNumber);
      if (pageAnnotations) {
        pageAnnotations.delete(id);
      }
    }

    this.annotations.delete(id);

    // Notify subscribers
    this.notify("annotation-deleted", { annotationId: id });

    return true;
  }

  /**
   * Get a single annotation by ID
   * @param {string} id
   * @returns {Object|null}
   */
  getAnnotation(id) {
    return this.annotations.get(id) || null;
  }

  /**
   * Get all annotations for a specific page
   * @param {number} pageNumber
   * @returns {Array<Object>}
   */
  getAnnotationsForPage(pageNumber) {
    const annotationIds = this.annotationsByPage.get(pageNumber);
    if (!annotationIds) return [];

    return Array.from(annotationIds)
      .map((id) => this.annotations.get(id))
      .filter(Boolean);
  }

  /**
   * Get all annotations
   * @returns {Array<Object>}
   */
  getAllAnnotations() {
    return Array.from(this.annotations.values());
  }

  /**
   * Delete only the comment from an annotation (keep the highlight/underscore)
   * @param {string} id
   * @returns {boolean}
   */
  deleteAnnotationComment(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    annotation.comment = null;
    annotation.updatedAt = new Date().toISOString();

    // Notify subscribers
    this.notify("annotation-updated", { annotation });

    return true;
  }

  /**
   * Export annotations for saving
   * @returns {Array<Object>}
   */
  exportAnnotations() {
    return Array.from(this.annotations.values());
  }

  /**
   * Import annotations (e.g., from saved file)
   * @param {Array<Object>} annotations
   */
  importAnnotations(annotations) {
    for (const annotation of annotations) {
      this.annotations.set(annotation.id, annotation);

      for (const pageRange of annotation.pageRanges) {
        if (!this.annotationsByPage.has(pageRange.pageNumber)) {
          this.annotationsByPage.set(pageRange.pageNumber, new Set());
        }
        this.annotationsByPage.get(pageRange.pageNumber).add(annotation.id);
      }
    }

    this.notify("annotations-imported", { count: annotations.length });
  }

  /**
   * @param { PDFDocumentProxy } pdfDoc
   */
  loadAnnotations(pdfDoc) {
    const existingAnnotations = pdfDoc.getAnnotationsByType(new Set([3,9]));
    console.log(existingAnnotations);

  }

  notify(event, data) {
    for (const subscriber of this.subscribers) {
      subscriber.onDocumentChange?.(event, data);
    }
  }

  // ============================================
  // PDF.js Native Annotation Save/Export Methods
  // ============================================

  /**
   * Convert our color name to RGB array (0-1 range)
   * @param {string} colorName - 'yellow', 'red', 'blue', 'green'
   * @returns {number[]} RGB array [r, g, b] with values 0-1
   */
  #colorNameToRgb(colorName) {
    return COLOR_TO_RGB[colorName] || COLOR_TO_RGB.yellow;
  }

  /**
   * Get page dimensions for coordinate conversion
   * @param {number} pageNumber - 1-based page number
   * @returns {Promise<{pageWidth: number, pageHeight: number}>}
   */
  async #getPageInfo(pageNumber) {
    const page = await this.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    // We only need the page dimensions, not the transform offsets
    // PDF coordinates: origin at bottom-left, Y increases upward
    return {
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    };
  }

  /**
   * Convert our rect format to PDF.js QuadPoints
   * Our format: { leftRatio, topRatio, widthRatio, heightRatio } (top-origin, 0-1 ratios)
   * PDF format: [tL.x, tL.y, tR.x, tR.y, bL.x, bL.y, bR.x, bR.y] (bottom-origin, absolute coords)
   *
   * @param {Object} rect - Our internal rect format
   * @param {Object} pageInfo - Page dimensions
   * @returns {number[]} 8 values for one quad in PDF.js order
   */
  #rectToQuadPoints(rect, pageInfo) {
    const { pageWidth, pageHeight } = pageInfo;
    const { leftRatio, topRatio, widthRatio, heightRatio } = rect;

    // Convert ratios to absolute PDF coordinates
    // X: straightforward scaling (0 = left edge)
    const x1 = leftRatio * pageWidth;
    const x2 = (leftRatio + widthRatio) * pageWidth;

    // Y: flip from top-origin to bottom-origin
    // Our topRatio=0 means top of page = PDF's Y = pageHeight
    // Our topRatio=1 means bottom of page = PDF's Y = 0
    const y1 = (1 - topRatio) * pageHeight;
    const y2 = (1 - topRatio - heightRatio) * pageHeight;

    // PDF.js QuadPoints order: topLeft, topRight, bottomLeft, bottomRight
    return [
      x1,
      y1, // top-left
      x2,
      y1, // top-right
      x1,
      y2, // bottom-left
      x2,
      y2, // bottom-right
    ];
  }

  /**
   * Convert our rect to an outline path for the appearance stream
   * @param {Object} rect - Our internal rect format
   * @param {Object} pageInfo - Page dimensions
   * @returns {number[]} Outline as [x1, y1, x2, y2, x3, y3, x4, y4]
   */
  #rectToOutline(rect, pageInfo) {
    const { pageWidth, pageHeight } = pageInfo;
    const { leftRatio, topRatio, widthRatio, heightRatio } = rect;

    const x1 = leftRatio * pageWidth;
    const x2 = (leftRatio + widthRatio) * pageWidth;
    const y1 = (1 - topRatio) * pageHeight;
    const y2 = (1 - topRatio - heightRatio) * pageHeight;

    // Path order: top-left, top-right, bottom-right, bottom-left
    return [x1, y1, x2, y1, x2, y2, x1, y2];
  }

  /**
   * Calculate bounding rect from all rects
   * @param {Array} rects - Array of our internal rect format
   * @param {Object} pageInfo - Page dimensions
   * @returns {number[]} [minX, minY, maxX, maxY]
   */
  #calculateBoundingRect(rects, pageInfo) {
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of rects) {
      const quadPoints = this.#rectToQuadPoints(rect, pageInfo);

      minX = Math.min(minX, quadPoints[0], quadPoints[4]);
      maxX = Math.max(maxX, quadPoints[2], quadPoints[6]);
      minY = Math.min(minY, quadPoints[5], quadPoints[7]); // bottom Y values
      maxY = Math.max(maxY, quadPoints[1], quadPoints[3]); // top Y values
    }

    return [minX, minY, maxX, maxY];
  }

  /**
   * Convert one of our annotations to PDF.js HIGHLIGHT format for a specific page
   * Works for both 'highlight' and 'underscore' annotation types
   * @param {Object} annotation - Our internal annotation
   * @param {Object} pageRange - The pageRange object for this page
   * @returns {Promise<Object>} PDF.js serialized annotation format
   */
  async #annotationToHighlightFormat(annotation, pageRange) {
    const pageInfo = await this.#getPageInfo(pageRange.pageNumber);

    const quadPoints = [];
    const outlines = [];

    for (const rect of pageRange.rects) {
      const quad = this.#rectToQuadPoints(rect, pageInfo);
      quadPoints.push(...quad);

      const outline = this.#rectToOutline(rect, pageInfo);
      outlines.push(outline);
    }

    const rect = this.#calculateBoundingRect(pageRange.rects, pageInfo);
    const color = this.#colorNameToRgb(annotation.color);

    // Both 'highlight' and 'underscore' use HIGHLIGHT annotationType
    // PDF.js doesn't have a separate UNDERLINE editor type
    return {
      annotationType: AnnotationEditorType.HIGHLIGHT,
      color,
      opacity: 1,
      thickness: 12,
      quadPoints,
      outlines,
      rect,
      pageIndex: pageRange.pageNumber - 1,
      rotation: 0,
      structTreeParentId: null,
      id: null,
    };
  }

  /**
   * Convert a comment to PDF.js FreeText annotation format
   * Positions the comment box at the right side of the page, aligned with the first highlight rect
   * @param {Object} annotation - Our internal annotation with comment
   * @param {Object} pageRange - The pageRange object for the page where comment should appear
   * @returns {Promise<Object>} PDF.js serialized FreeText annotation format
   */
  async #commentToFreeTextFormat(annotation, pageRange) {
    const pageInfo = await this.#getPageInfo(pageRange.pageNumber);
    const { pageWidth, pageHeight } = pageInfo;

    // Get the vertical position from the first rect of the annotation
    const firstRect = pageRange.rects[0];
    const topY = (1 - firstRect.topRatio) * pageHeight;

    // Position the comment box at the right margin
    const { fontSize, fontColor, width, rightMargin, padding } =
      FREETEXT_CONFIG;
    const x1 = pageWidth - width - rightMargin;
    const x2 = pageWidth - rightMargin;

    // Calculate height based on text content
    // Rough estimate: ~2.5 chars per point width, fontSize height per line
    const charsPerLine = Math.floor((width - 2 * padding) / (fontSize * 0.5));
    const commentText = annotation.comment || "";
    const lines = Math.ceil(commentText.length / charsPerLine) || 1;
    const textHeight = lines * fontSize * 1.2 + 2 * padding;

    // Position box so top aligns with the highlight
    const y1 = topY;
    const y2 = topY - textHeight;

    const rect = [x1, y2, x2, y1];

    return {
      annotationType: AnnotationEditorType.FREETEXT,
      color: fontColor,
      fontSize,
      value: commentText,
      rect,
      pageIndex: pageRange.pageNumber - 1,
      rotation: 0,
      structTreeParentId: null,
      id: null,
    };
  }

  /**
   * Save PDF with annotations embedded
   * Serializes highlights, underlines, and comments as PDF annotations
   * @returns {Promise<Uint8Array>} PDF data with annotations
   */
  async saveWithAnnotations() {
    if (!this.pdfDoc) {
      throw new Error("No PDF document loaded");
    }

    const allAnnotations = this.getAllAnnotations();

    if (allAnnotations.length === 0) {
      return await this.pdfDoc.getData();
    }

    const annotationStorage = this.pdfDoc.annotationStorage;

    if (!annotationStorage) {
      console.warn(
        "annotationStorage not available, falling back to original PDF",
      );
      return await this.pdfDoc.getData();
    }

    let editorIndex = 0;

    for (const annotation of allAnnotations) {
      // Process each page range for highlight/underscore annotations
      for (const pageRange of annotation.pageRanges) {
        // Both 'highlight' and 'underscore' types serialize as HIGHLIGHT
        const highlightData = await this.#annotationToHighlightFormat(
          annotation,
          pageRange,
        );

        const highlightKey = `${AnnotationEditorPrefix}${editorIndex++}`;
        annotationStorage.setValue(highlightKey, highlightData);
      }

      if (annotation.comment && annotation.pageRanges.length > 0) {
        const firstPageRange = annotation.pageRanges[0];
        const freeTextData = await this.#commentToFreeTextFormat(
          annotation,
          firstPageRange,
        );

        const freeTextKey = `${AnnotationEditorPrefix}${editorIndex++}`;
        annotationStorage.setValue(freeTextKey, freeTextData);
      }
    }

    try {
      const data = await this.pdfDoc.saveDocument();
      return data;
    } catch (error) {
      console.error("Error saving document with annotations:", error);
      return await this.pdfDoc.getData();
    }
  }

  /**
   * Check if there are any annotations to save
   * @returns {boolean}
   */
  hasAnnotations() {
    return this.annotations.size > 0;
  }
}
