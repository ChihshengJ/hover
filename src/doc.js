/**
 * @typedef {import('pdfjs-dist').PDFDocumentProxy} PDFDocumentProxy;
 */

import { pdfjsLib } from "./pdfjs-init.js";
import { SearchIndex } from "./controls/search/search_index.js";
import { buildOutline } from "./outline_builder.js";

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

// Reverse mapping: find closest color name from RGB values
function rgbToColorName(rgb) {
  if (!rgb || rgb.length < 3) return "yellow";

  const r = rgb[0] > 1 ? rgb[0] : rgb[0] * 255;
  const g = rgb[1] > 1 ? rgb[1] : rgb[1] * 255;
  const b = rgb[2] > 1 ? rgb[2] : rgb[2] * 255;

  let closestColor = "yellow";
  let minDistance = Infinity;

  for (const [name, [cr, cg, cb]] of Object.entries(COLOR_TO_RGB)) {
    const distance = Math.sqrt(
      Math.pow(r - cr, 2) + Math.pow(g - cg, 2) + Math.pow(b - cb, 2),
    );
    if (distance < minDistance) {
      minDistance = distance;
      closestColor = name;
    }
  }

  return closestColor;
}

/**
 * @callback LoadProgressCallback
 * @param {{loaded: number, total: number, percent: number, phase: string}} progress
 */

export class PDFDocumentModel {
  constructor() {
    this.pdfDoc = null;
    this.allNamedDests = null;
    this.pageDimensions = [];
    this.highlights = new Map();
    this.subscribers = new Set();

    this.annotations = new Map();
    this.annotationsByPage = new Map();
    this.importedPdfAnnotations = new Map();

    /** @type {Array<{id: string, title: string, pageIndex: number, left: number, top: number, children: Array}>} */
    this.outline = [];

    /** @type {SearchIndex|null} */
    this.searchIndex = null;
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

  /**
   * Load PDF from URL or ArrayBuffer
   * @param {string|ArrayBuffer} source - URL or ArrayBuffer of PDF data
   * @param {LoadProgressCallback} [onProgress] - Optional progress callback
   * @returns {Promise<PDFDocumentProxy>}
   */
  async load(source, onProgress) {
    const reportProgress = (loaded, total, phase) => {
      if (onProgress) {
        const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
        onProgress({ loaded, total, percent, phase });
      }
    };

    if (source instanceof ArrayBuffer) {
      // ArrayBuffer loading - no progress available during PDF.js parsing
      reportProgress(0, 100, "parsing");
      this.pdfDoc = await pdfjsLib.getDocument({ data: source, verbosity: 0 })
        .promise;
      reportProgress(50, 100, "parsing");
    } else {
      try {
        // URL-based loading - progress available during download
        const loadingTask = pdfjsLib.getDocument({ url: source, verbosity: 0 });

        // Set up progress callback for download phase
        loadingTask.onProgress = (progressData) => {
          if (progressData.total > 0) {
            // We have a known total - report actual progress
            reportProgress(
              progressData.loaded,
              progressData.total,
              "downloading",
            );
          } else {
            // Unknown total - report loaded bytes, use -1 for indeterminate
            reportProgress(progressData.loaded, -1, "downloading");
          }
        };

        this.pdfDoc = await loadingTask.promise;
      } catch (error) {
        // Check if it's a CORS or network error
        if (this.#isCorsOrNetworkError(error)) {
          console.log(
            "CORS error detected, falling back to background fetch...",
          );
          reportProgress(0, -1, "downloading");
          const arrayBuffer = await this.#fetchViaBackground(
            source,
            reportProgress,
          );
          reportProgress(50, 100, "parsing");
          this.pdfDoc = await pdfjsLib.getDocument({
            data: arrayBuffer,
            verbosity: 0,
          }).promise;
        } else {
          throw error;
        }
      }
    }

    // Post-download processing phases
    reportProgress(60, 100, "processing");
    this.allNamedDests = await this.pdfDoc.getDestinations();

    reportProgress(70, 100, "caching");
    await this.#cachePageDimensions();

    reportProgress(80, 100, "loading annotations");
    await this.loadAnnotations(this.pdfDoc);

    reportProgress(85, 100, "initializing search");
    this.searchIndex = new SearchIndex(this);
    await this.#buildSearchIndexAsync();

    reportProgress(95, 100, "building outline");
    await this.#buildOutline();

    reportProgress(100, 100, "complete");

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
   * @param {Function} [reportProgress] - Optional progress reporter
   * @returns {Promise<ArrayBuffer>}
   */
  async #fetchViaBackground(url, reportProgress) {
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
            if (reportProgress) {
              reportProgress(
                response.data.length,
                response.data.length,
                "downloading",
              );
            }
            resolve(arrayBuffer);
          } else {
            reject(new Error("No data received from background"));
          }
        },
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

  // ============================================
  // Annotation I/O
  // ============================================

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
   * Load existing annotations from the PDF document
   * Parses Highlight annotations and their associated Popup comments
   * @param {PDFDocumentProxy} pdfDoc
   */
  async loadAnnotations(pdfDoc) {
    const importedAnnotations = [];

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const annotations = await page.getAnnotations({ intent: "display" });
      const viewport = page.getViewport({ scale: 1 });
      const pageHeight = viewport.height;
      const pageWidth = viewport.width;

      for (const annot of annotations) {
        // Currently supporting Highlight annotations
        // Extensible: add more annotation types here (Underline, StrikeOut, etc.)
        if (annot.subtype === "Highlight") {
          // Debug: Log what we're getting from PDF.js
          console.log(
            `[DEBUG] Found Highlight annotation on page ${pageNum}:`,
            {
              id: annot.id,
              popupRef: annot.popupRef,
              rect: annot.rect,
              hasQuadPoints: !!annot.quadPoints,
            },
          );

          const converted = this.#convertHighlightAnnotation(
            annot,
            pageNum,
            pageWidth,
            pageHeight,
          );
          if (converted) {
            importedAnnotations.push(converted);

            // Track original PDF annotation info for removal during save
            this.importedPdfAnnotations.set(converted.id, {
              pageNumber: pageNum,
              pdfAnnotationId: annot.id || null,
              pdfPopupRef: annot.popupRef || null,
              annotationType: annot.subtype,
            });

            console.log(`[DEBUG] Tracking for removal:`, {
              ourId: converted.id,
              pdfId: annot.id,
              popupRef: annot.popupRef,
            });
          }
        }
        // TODO: Future annotation types can be added here
        // else if (annot.subtype === "Underline") { ... }
        // else if (annot.subtype === "StrikeOut") { ... }
      }
    }

    if (importedAnnotations.length > 0) {
      console.log(`Loaded ${importedAnnotations.length} annotations from PDF`);
      console.log(
        `Tracked ${this.importedPdfAnnotations.size} original PDF annotations for removal`,
      );
      this.importAnnotations(importedAnnotations);
    }
  }

  /**
   * Convert a PDF Highlight annotation to our internal format
   * @param {Object} annot - PDF.js annotation object
   * @param {number} pageNum - 1-based page number
   * @param {number} pageWidth - Page width in PDF units
   * @param {number} pageHeight - Page height in PDF units
   * @returns {Object|null} Our internal annotation format
   */
  #convertHighlightAnnotation(annot, pageNum, pageWidth, pageHeight) {
    // quadPoints: array of 8 values per quad [tL.x, tL.y, tR.x, tR.y, bL.x, bL.y, bR.x, bR.y]
    // PDF coordinate system: origin at bottom-left, Y increases upward
    const quadPoints = annot.quadPoints;
    if (!quadPoints || quadPoints.length < 8) {
      // Fall back to rect if no quadPoints
      return this.#convertRectAnnotation(annot, pageNum, pageWidth, pageHeight);
    }

    const rects = [];

    // Process each quad (8 values per quad)
    for (let i = 0; i < quadPoints.length; i += 8) {
      const quad = quadPoints.slice(i, i + 8);
      if (quad.length < 8) break;

      // Extract coordinates from quad
      // [tL.x, tL.y, tR.x, tR.y, bL.x, bL.y, bR.x, bR.y]
      const tLx = quad[0],
        tLy = quad[1];
      const tRx = quad[2],
        tRy = quad[3];
      const bLx = quad[4],
        bLy = quad[5];
      const bRx = quad[6],
        bRy = quad[7];

      // Calculate bounding box
      const minX = Math.min(tLx, tRx, bLx, bRx);
      const maxX = Math.max(tLx, tRx, bLx, bRx);
      const minY = Math.min(tLy, tRy, bLy, bRy); // Bottom in PDF coords
      const maxY = Math.max(tLy, tRy, bLy, bRy); // Top in PDF coords

      // Convert to our ratio format (top-left origin)
      // Our topRatio=0 means page top, which is maxY in PDF coords
      const leftRatio = minX / pageWidth;
      const topRatio = 1 - maxY / pageHeight;
      const widthRatio = (maxX - minX) / pageWidth;
      const heightRatio = (maxY - minY) / pageHeight;

      rects.push({
        leftRatio,
        topRatio,
        widthRatio,
        heightRatio,
      });
    }

    if (rects.length === 0) return null;

    // Determine color from annotation
    const color = rgbToColorName(annot.color);

    // Get comment from the Contents field (standard PDF annotation comment)
    // This is where Popup/anchored notes store their text
    const comment = annot.contentsObj?.str || annot.contents || null;

    return {
      id: `imported-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: "highlight",
      color,
      pageRanges: [
        {
          pageNumber: pageNum,
          rects,
          text: "", // Text extraction would require more work
        },
      ],
      comment: comment && comment.trim() ? comment.trim() : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Store original PDF annotation references for deletion on save
      pdfAnnotationId: annot.id || null,
      pdfPopupRef: annot.popupRef || null,
    };
  }

  /**
   * Convert a PDF annotation using just its rect (fallback)
   * @param {Object} annot - PDF.js annotation object
   * @param {number} pageNum - 1-based page number
   * @param {number} pageWidth - Page width in PDF units
   * @param {number} pageHeight - Page height in PDF units
   * @returns {Object|null} Our internal annotation format
   */
  #convertRectAnnotation(annot, pageNum, pageWidth, pageHeight) {
    const rect = annot.rect;
    if (!rect || rect.length < 4) return null;

    // rect: [x1, y1, x2, y2] in PDF coords
    const minX = Math.min(rect[0], rect[2]);
    const maxX = Math.max(rect[0], rect[2]);
    const minY = Math.min(rect[1], rect[3]);
    const maxY = Math.max(rect[1], rect[3]);

    const leftRatio = minX / pageWidth;
    const topRatio = 1 - maxY / pageHeight;
    const widthRatio = (maxX - minX) / pageWidth;
    const heightRatio = (maxY - minY) / pageHeight;

    const color = rgbToColorName(annot.color);

    // Get comment from the Contents field
    const comment = annot.contentsObj?.str || annot.contents || null;

    return {
      id: `imported-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: "highlight",
      color,
      pageRanges: [
        {
          pageNumber: pageNum,
          rects: [
            {
              leftRatio,
              topRatio,
              widthRatio,
              heightRatio,
            },
          ],
          text: "",
        },
      ],
      comment: comment && comment.trim() ? comment.trim() : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Store original PDF annotation references for deletion on save
      pdfAnnotationId: annot.id || null,
      pdfPopupRef: annot.popupRef || null,
    };
  }

  notify(event, data) {
    for (const subscriber of this.subscribers) {
      subscriber.onDocumentChange?.(event, data);
    }
  }

  // ============================================
  // Outline Building
  // ============================================

  async #buildOutline() {
    this.outline = await buildOutline(
      this.pdfDoc,
      this.searchIndex,
      this.allNamedDests
    );
  }

  // ============================================
  // Search Index Building
  // ============================================

  async #buildSearchIndexAsync() {
    if (!this.searchIndex) return;

    try {
      console.log("[Search] Building search index...");
      const startTime = performance.now();

      // Emit start event
      this.notify("search-index-start", { totalPages: this.numPages });

      await this.searchIndex.build((completedPages, totalPages, percent) => {
        this.notify("search-index-progress", {
          completedPages,
          totalPages,
          percent,
        });

        if (completedPages % 10 === 0 || completedPages === totalPages) {
          console.log(
            `[Search] Indexed ${completedPages}/${totalPages} pages (${percent}%)`,
          );
        }
      });

      const elapsed = performance.now() - startTime;
      console.log(`[Search] Index built in ${elapsed.toFixed(0)}ms`);

      this.notify("search-index-ready", { elapsedMs: elapsed });
    } catch (error) {
      console.error("[Search] Error building search index:", error);
      this.notify("search-index-error", { error: error.message });
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
   * If the annotation has a comment, it includes popup information for anchored notes
   * @param {Object} annotation - Our internal annotation
   * @param {Object} pageRange - The pageRange object for this page
   * @param {boolean} isFirstPage - Whether this is the first page of the annotation (for popup)
   * @returns {Promise<Object>} PDF.js serialized annotation format
   */
  async #annotationToHighlightFormat(
    annotation,
    pageRange,
    isFirstPage = false,
  ) {
    const pageInfo = await this.#getPageInfo(pageRange.pageNumber);
    const { pageWidth, pageHeight } = pageInfo;

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
    const highlightData = {
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

    // If this annotation has a comment and this is the first page,
    // add popup information for anchored note support
    if (annotation.comment && isFirstPage) {
      // Calculate popup rect - positioned at right margin near the highlight
      const firstRect = pageRange.rects[0];
      const topY = (1 - firstRect.topRatio) * pageHeight;

      // Popup dimensions (standard sticky note size)
      const popupWidth = 200;
      const popupHeight = 100;
      const rightMargin = 10;

      const popupX1 = pageWidth - popupWidth - rightMargin;
      const popupX2 = pageWidth - rightMargin;
      const popupY1 = topY - popupHeight;
      const popupY2 = topY;

      highlightData.popup = {
        contents: annotation.comment,
        rect: [popupX1, popupY1, popupX2, popupY2],
      };
    }

    return highlightData;
  }

  /**
   * Save PDF with annotations embedded
   * Serializes highlights and underlines as PDF annotations
   * Comments are saved as anchored notes (popup annotations) linked to their parent highlight
   * Original imported annotations are removed through post-processing
   * @returns {Promise<Uint8Array>} PDF data with annotations
   */
  async saveWithAnnotations() {
    if (!this.pdfDoc) {
      throw new Error("No PDF document loaded");
    }

    const allAnnotations = this.getAllAnnotations();

    // If no annotations and nothing to remove, return original
    if (allAnnotations.length === 0 && this.importedPdfAnnotations.size === 0) {
      return await this.pdfDoc.getData();
    }

    const annotationStorage = this.pdfDoc.annotationStorage;

    if (!annotationStorage) {
      console.warn(
        "annotationStorage not available, falling back to original PDF",
      );
      return await this.pdfDoc.getData();
    }

    // Add our annotations to the storage
    // Note: We don't try to mark imported annotations as deleted here
    // because PDF.js doesn't support deletion of existing non-widget annotations
    // through annotationStorage. We'll handle removal via post-processing.

    let editorIndex = 0;

    for (const annotation of allAnnotations) {
      // Process each page range for highlight/underscore annotations
      for (let i = 0; i < annotation.pageRanges.length; i++) {
        const pageRange = annotation.pageRanges[i];
        const isFirstPage = i === 0;

        // Both 'highlight' and 'underscore' types serialize as HIGHLIGHT
        // Comments are included as popup annotations on the first page
        const highlightData = await this.#annotationToHighlightFormat(
          annotation,
          pageRange,
          isFirstPage,
        );

        const highlightKey = `${AnnotationEditorPrefix}${editorIndex++}`;
        annotationStorage.setValue(highlightKey, highlightData);
      }
    }

    try {
      // Get PDF with new annotations added
      let data = await this.pdfDoc.saveDocument();

      // Post-process to remove original imported annotations
      if (this.importedPdfAnnotations.size > 0) {
        console.log(
          `\n[PDF Save] Post-processing PDF to remove ${this.importedPdfAnnotations.size} original annotations`,
        );

        // Log what we're trying to remove
        console.log("[PDF Save] Annotations to remove:");
        for (const [annotId, info] of this.importedPdfAnnotations) {
          console.log(
            `  - ID: ${annotId}, PDF ref: ${info.pdfAnnotationId}, popup: ${info.pdfPopupRef}, page: ${info.pageNumber}`,
          );
        }

        data = this.#removeImportedAnnotationsFromPdf(data);
      }

      return data;
    } catch (error) {
      console.error("Error saving document with annotations:", error);
      return await this.pdfDoc.getData();
    }
  }

  /**
   * Post-process PDF bytes to remove imported annotation references
   * This is necessary because PDF.js doesn't support deleting existing annotations
   * through its public API for non-widget annotation types.
   *
   * @param {Uint8Array} pdfData - The PDF bytes from saveDocument()
   * @returns {Uint8Array} - Modified PDF bytes with original annotations removed
   */
  #removeImportedAnnotationsFromPdf(pdfData) {
    // Collect all refs to remove, grouped by page for debugging
    const refsToRemove = new Map(); // pageNumber -> Set of refs

    for (const [annotId, info] of this.importedPdfAnnotations) {
      const pageRefs = refsToRemove.get(info.pageNumber) || new Set();

      if (info.pdfAnnotationId) {
        pageRefs.add(info.pdfAnnotationId);
      }
      if (info.pdfPopupRef) {
        pageRefs.add(info.pdfPopupRef);
      }

      refsToRemove.set(info.pageNumber, pageRefs);
    }

    const allRefs = new Set();
    for (const refs of refsToRemove.values()) {
      for (const ref of refs) {
        allRefs.add(ref);
      }
    }

    if (allRefs.size === 0) {
      console.log("[PDF Cleanup] No annotation refs to remove");
      return pdfData;
    }

    console.log(
      `[PDF Cleanup] Attempting to remove ${allRefs.size} annotation refs:`,
      Array.from(allRefs),
    );

    // Normalize all refs to multiple possible formats for matching
    const refPatterns = [];
    for (const ref of allRefs) {
      const parsed = this.#parseRef(ref);
      if (parsed) {
        // PDF standard format: "5 0 R"
        refPatterns.push(`${parsed.objNum} ${parsed.genNum} R`);
        // Sometimes with different spacing
        refPatterns.push(`${parsed.objNum}  ${parsed.genNum}  R`);
        // Compact format that might appear: "5 0R" (unlikely but possible)
        refPatterns.push(`${parsed.objNum} ${parsed.genNum}R`);
      }
    }

    console.log("[PDF Cleanup] Looking for ref patterns:", refPatterns);

    // Convert PDF bytes to string for manipulation
    // Using latin1 (ISO-8859-1) to preserve binary data integrity
    let str = "";
    for (let i = 0; i < pdfData.length; i++) {
      str += String.fromCharCode(pdfData[i]);
    }

    let modified = false;
    let annotsFound = 0;
    let refsRemoved = 0;

    // Find ALL /Annots arrays in the document (including incremental updates)
    // Pattern: /Annots [ref1 ref2 ref3...]
    // Also handles /Annots[...] without space
    const annotsPattern = /(\/Annots\s*)\[([^\]]*)\]/g;

    str = str.replace(annotsPattern, (match, prefix, arrayContent) => {
      annotsFound++;
      let newContent = arrayContent;
      let thisMatchModified = false;

      // Try to remove each ref pattern
      for (const refToRemove of refPatterns) {
        // Escape special regex chars in the ref (the space is the main concern)
        const escapedRef = refToRemove.replace(/([.*+?^${}()|[\]\\])/g, "\\$1");

        // Match the ref with flexible whitespace, ensuring it's a complete ref
        // (not part of a larger number)
        const refPattern = new RegExp(
          `(^|\\s)(${escapedRef})(?=\\s|$|\\])`,
          "g",
        );

        const before = newContent;
        newContent = newContent.replace(refPattern, "$1"); // Keep leading whitespace

        if (before !== newContent) {
          thisMatchModified = true;
          refsRemoved++;
          console.log(
            `[PDF Cleanup] Removed ref '${refToRemove}' from /Annots array #${annotsFound}`,
          );
        }
      }

      if (thisMatchModified) {
        modified = true;
        // Clean up extra whitespace but preserve at least one space between refs
        newContent = newContent.replace(/\s+/g, " ").trim();
        console.log(
          `[PDF Cleanup] /Annots array #${annotsFound} after cleanup: [${newContent.substring(0, 100)}${newContent.length > 100 ? "..." : ""}]`,
        );
      }

      return `${prefix}[${newContent}]`;
    });

    console.log(
      `[PDF Cleanup] Found ${annotsFound} /Annots arrays, removed ${refsRemoved} refs`,
    );

    if (!modified) {
      console.log("[PDF Cleanup] No refs were found/removed. This could mean:");
      console.log("  1. The ref format in the PDF differs from expected");
      console.log("  2. The annotations use indirect /Annots references");
      console.log("  3. The PDF uses object streams (compressed)");

      // Debug: Search for any occurrence of our ref patterns
      for (const pattern of refPatterns.slice(0, 3)) {
        // Check first few
        const idx = str.indexOf(pattern);
        if (idx !== -1) {
          const context = str.substring(
            Math.max(0, idx - 50),
            Math.min(str.length, idx + 50),
          );
          console.log(
            `[PDF Cleanup] Found '${pattern}' at position ${idx}, context: ...${context}...`,
          );
        }
      }

      return pdfData;
    }

    console.log(
      "[PDF Cleanup] Successfully modified PDF to remove original annotation refs",
    );

    // Convert back to bytes, preserving binary data
    const result = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      result[i] = str.charCodeAt(i) & 0xff;
    }

    // Verify the modification by searching for the removed refs in the result
    const resultStr = String.fromCharCode.apply(
      null,
      result.slice(0, Math.min(result.length, 100000)),
    );
    for (const pattern of refPatterns.slice(0, 3)) {
      if (resultStr.includes(pattern)) {
        console.warn(
          `[PDF Cleanup] Warning: '${pattern}' may still be in PDF (found in first 100KB)`,
        );
      }
    }

    return result;
  }

  /**
   * Debug helper: dump info about /Annots arrays in PDF
   * Call this before and after save to compare
   */
  #debugAnnotsArrays(pdfData, label = "") {
    let str = "";
    for (let i = 0; i < pdfData.length; i++) {
      str += String.fromCharCode(pdfData[i]);
    }

    console.log(`\n[PDF Debug ${label}] Searching for /Annots arrays...`);

    // Find all /Annots occurrences
    let idx = 0;
    let count = 0;
    while ((idx = str.indexOf("/Annots", idx)) !== -1) {
      count++;
      // Get context around this occurrence
      const start = Math.max(0, idx - 20);
      const end = Math.min(str.length, idx + 150);
      const context = str
        .substring(start, end)
        .replace(/[\x00-\x1f]/g, "Â·") // Replace control chars for display
        .replace(/\n/g, "â†µ");

      console.log(
        `[PDF Debug ${label}] /Annots occurrence #${count} at byte ${idx}:`,
      );
      console.log(`  Context: ...${context}...`);

      idx++;
    }

    console.log(`[PDF Debug ${label}] Total /Annots occurrences: ${count}`);
  }

  /**
   * Parse a PDF reference string like "20R", "20 0 R", or just "20" into components
   * PDF.js returns annotation IDs in formats like "5R" for object reference 5 0 R
   * @param {string} refStr - Reference string
   * @returns {{objNum: number, genNum: number} | null}
   */
  #parseRef(refStr) {
    if (!refStr) return null;

    const strVal = String(refStr).trim();

    // Handle "20R" format (PDF.js internal - most common for annotation IDs)
    const simpleMatch = strVal.match(/^(\d+)R$/i);
    if (simpleMatch) {
      return { objNum: parseInt(simpleMatch[1], 10), genNum: 0 };
    }

    // Handle "20 0 R" format (PDF standard)
    const fullMatch = strVal.match(/^(\d+)\s+(\d+)\s*R$/i);
    if (fullMatch) {
      return {
        objNum: parseInt(fullMatch[1], 10),
        genNum: parseInt(fullMatch[2], 10),
      };
    }

    // Handle pure number (just object number, assume gen 0)
    const numMatch = strVal.match(/^(\d+)$/);
    if (numMatch) {
      return { objNum: parseInt(numMatch[1], 10), genNum: 0 };
    }

    // Handle "annot_5R" format (prefixed)
    const prefixedMatch = strVal.match(/(\d+)R$/i);
    if (prefixedMatch) {
      return { objNum: parseInt(prefixedMatch[1], 10), genNum: 0 };
    }

    console.warn(`[PDF Cleanup] Could not parse ref format: '${refStr}'`);
    return null;
  }

  /**
   * Check if there are any annotations to save
   * @returns {boolean}
   */
  hasAnnotations() {
    return this.annotations.size > 0;
  }
}
