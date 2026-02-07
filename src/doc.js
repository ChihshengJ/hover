/**
 * PDFDocumentModel - Refactored for @embedpdf/engines (PDFium)
 *
 * Annotation system fully integrated with embedPDF's engine APIs.
 * Changes are applied to the engine immediately and saveAsCopy() persists them.
 *
 * @typedef {import('@embedpdf/engines/pdfium').PdfEngine} PdfEngine
 * @typedef {import('@embedpdf/engines/pdfium').PdfiumNative} PdfiumNative
 * @typedef {import('@embedpdf/engines').PdfDocumentObject} PdfDocumentObject
 */

import { initPdfiumEngine } from "./pdfium-init.js";
import { DocumentTextIndex } from "./data/text_index.js";
import {
  buildOutline,
  detectDocumentMetadata,
} from "./data/outline_builder.js";
import {
  buildReferenceIndex,
  findBoundingAnchors,
  findReferenceByIndex,
  matchCitationToReference,
} from "./data/reference_builder.js";
import { PdfiumDocumentFactory } from "./data/text_extractor.js";

import { createInlineExtractor } from "./data/inline_extractor.js";
import { createCitationBuilder } from "./data/citation_builder.js";
import { createCrossReferenceBuilder } from "./data/cross_reference_builder.js";


const COLOR_NAME_TO_HEX = {
  yellow: "#FFB300",
  red: "#E53935",
  blue: "#1E88E5",
  green: "#43A047",
};

const HEX_TO_COLOR_NAME = {
  "#FFB300": "yellow",
  "#E53935": "red",
  "#1E88E5": "blue",
  "#43A047": "green",
};

/**
 * Convert color name to hex string for embedPDF
 * @param {string} colorName
 * @returns {string}
 */
function colorNameToHex(colorName) {
  return COLOR_NAME_TO_HEX[colorName] || COLOR_NAME_TO_HEX.yellow;
}

/**
 * Convert hex color to color name for UI
 * @param {string} hex
 * @returns {string}
 */
function hexToColorName(hex) {
  if (!hex) return "yellow";

  // Normalize hex
  const normalizedHex = hex.toUpperCase();
  if (HEX_TO_COLOR_NAME[normalizedHex]) {
    return HEX_TO_COLOR_NAME[normalizedHex];
  }

  // Try to find closest match by parsing RGB
  const rgb = hexToRgb(hex);
  if (!rgb) return "yellow";

  let closestColor = "yellow";
  let minDistance = Infinity;

  for (const [name, hexVal] of Object.entries(COLOR_NAME_TO_HEX)) {
    const targetRgb = hexToRgb(hexVal);
    if (!targetRgb) continue;

    const distance = Math.sqrt(
      Math.pow(rgb.r - targetRgb.r, 2) +
      Math.pow(rgb.g - targetRgb.g, 2) +
      Math.pow(rgb.b - targetRgb.b, 2),
    );

    if (distance < minDistance) {
      minDistance = distance;
      closestColor = name;
    }
  }

  return closestColor;
}

/**
 * Parse hex color to RGB
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}|null}
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    }
    : null;
}

/**
 * Generate UUID v4
 * @returns {string}
 */
function uuidV4() {
  return crypto.randomUUID();
}

const PdfAnnotationSubtype = {
  HIGHLIGHT: 9,
  UNDERLINE: 10,
  SQUIGGLY: 11,
  STRIKEOUT: 12,
  TEXT: 1, // Sticky note / comment
};

export class PDFDocumentModel {
  constructor() {
    /** @type {PdfEngine|null} */
    this.engine = null;
    /** @type {PdfiumNative|null} */
    this.native = null;
    /** @type {PdfDocumentObject|null} */
    this.pdfDoc = null;
    /** @type {Map<string, any>} */
    this.allNamedDests = new Map();
    /** @type {Array<{width: number, height: number}>} */
    this.pageDimensions = [];

    this.highlights = new Map();
    this.subscribers = new Set();

    /**
     * All annotations (our UI representation)
     * @type {Map<string, AnnotationUI>}
     */
    this.annotations = new Map();

    /**
     * Quick lookup: pageNumber -> Set of annotation IDs on that page
     * @type {Map<number, Set<string>>}
     */
    this.annotationsByPage = new Map();

    this.citationsByPage = new Map();      // Map<pageNum, Citation[]>
    this.crossRefsByPage = new Map();      // Map<pageNum, CrossReference[]>
    this.crossRefTargets = new Map();      // Map<string, CrossRefTarget>
    this.urlsByPage = new Map();           // Map<pageNum, UrlLink[]>

    /**
     * Mapping from our annotation ID to the PDF's native annotation ID
     * Used for updating/removing existing PDF annotations
     * @type {Map<string, string>}
     */
    this.#annotationIdToPdfId = new Map();

    /**
     * Comment annotations (PdfTextAnnoObject) linked to markup annotations
     * markupAnnotationId -> commentAnnotationId
     * @type {Map<string, string>}
     */
    this.#linkedComments = new Map();

    /** @type {Map<number, Array>} - Native annotations cached per page */
    this.nativeAnnotationsByPage = new Map();

    this.anchors = null;

    /** @type {Map<number, Array>} - Citation anchors by page for fast lookup */
    this.citationsByPage = null;

    /** @type {Array<{id: string, title: string, pageIndex: number, left: number, top: number, children: Array}>} */
    this.outline = [];
    /** @type {DocumentTextIndex|null} */
    this.textIndex = null;
    /** @type {import('./reference_builder.js').ReferenceIndex|null} */
    this.referenceIndex = null;
    /** @type {{title: string|null, abstractInfo: Object|null}} */
    this.detectedMetadata = { title: null, abstractInfo: null };

    /** @type {Uint8Array|null} */
    this.pdfData = null;
    /** @type {import('./data/text_extractor.js').PdfiumDocumentHandle|null} */
    this.lowLevelHandle = null;
    /** @type {import('./data/text_extractor.js').PdfiumTextExtractor|null} */
    this.textExtractor = null;
  }

  #annotationIdToPdfId = new Map();
  #linkedComments = new Map();

  static hasLocalPdf() {
    return sessionStorage.getItem("hover_pdf_data") !== null;
  }

  static getLocalPdf() {
    const base64 = sessionStorage.getItem("hover_pdf_data");
    const name = sessionStorage.getItem("hover_pdf_name") || "document.pdf";
    if (!base64) return null;

    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { data: bytes.buffer, name };
    } catch (error) {
      console.error("Error parsing local PDF:", error);
      return null;
    }
  }

  static clearLocalPdf() {
    sessionStorage.removeItem("hover_pdf_data");
    sessionStorage.removeItem("hover_pdf_name");
  }

  async load(source, onProgress) {
    const reportProgress = (loaded, total, phase) => {
      if (onProgress) {
        const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
        onProgress({ loaded, total, percent, phase });
      }
    };

    reportProgress(0, 100, "initializing engine");
    const { engine, native, pdfiumModule } = await initPdfiumEngine((p) => {
      reportProgress(p.percent * 0.2, 100, p.phase);
    });

    this.engine = engine;
    this.native = native;

    try {
      let arrayBuffer;

      if (source instanceof ArrayBuffer) {
        arrayBuffer = source;
        reportProgress(25, 100, "parsing");
      } else {
        reportProgress(20, -1, "downloading");
        arrayBuffer = await this.#fetchPdfAsArrayBuffer(source, reportProgress);
        reportProgress(45, 100, "downloaded");
      }

      this.pdfData = new Uint8Array(arrayBuffer);

      reportProgress(50, 100, "parsing");
      this.pdfDoc = await this.engine
        .openDocumentBuffer({
          id: `doc-${Date.now()}`,
          content: this.pdfData,
        })
        .toPromise();

      reportProgress(55, 100, "setting up text extraction engine");
      this.#setupLowLevelAccess(pdfiumModule);

      reportProgress(58, 100, "processing");
      await this.#cachePageDimensions();

      reportProgress(60, 100, "loading bookmarks");
      await this.#loadBookmarksAndDestinations();

      reportProgress(70, 100, "indexing text");
      this.textIndex = new DocumentTextIndex(this);
      if (this.lowLevelHandle) {
        this.textIndex.setLowLevelHandle(this.lowLevelHandle);
      }
      await this.textIndex.build();

      this.detectedMetadata = detectDocumentMetadata(this.textIndex);

      reportProgress(75, 100, "indexing references");
      this.referenceIndex = await buildReferenceIndex(this.textIndex);

      reportProgress(80, 100, "building outline");
      await this.#buildOutline();

      reportProgress(90, 100, "loading annotations");
      await this.loadAnnotations();

      console.log("[Doc] Parsing full text for inline links...");
      await this.#buildInlineElements();

      reportProgress(100, 100, "complete");

      return this.pdfDoc;
    } catch (error) {
      console.error("Error loading PDF:", error);
      throw error;
    }
  }

  async #fetchPdfAsArrayBuffer(url, reportProgress) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers.get("content-length");
      const total = contentLength ? parseInt(contentLength, 10) : -1;

      if (total > 0 && response.body) {
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          loaded += value.length;

          if (reportProgress) {
            const scaledPercent = 20 + Math.round((loaded / total) * 25);
            reportProgress(scaledPercent, 100, "downloading");
          }
        }

        const combined = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        return combined.buffer;
      } else {
        return await response.arrayBuffer();
      }
    } catch (error) {
      if (this.#isCorsOrNetworkError(error)) {
        return await this.#fetchViaBackground(url, reportProgress);
      }
      throw error;
    }
  }

  #setupLowLevelAccess(pdfiumModule) {
    if (!this.pdfData || !pdfiumModule) return;

    try {
      const factory = new PdfiumDocumentFactory(pdfiumModule);
      this.lowLevelHandle = factory.loadFromBuffer(this.pdfData);
      this.textExtractor = this.lowLevelHandle.extractor;
    } catch (error) {
      console.error("[Doc] Error setting up low-level access:", error);
    }
  }

  #isCorsOrNetworkError(error) {
    const message = error?.message?.toLowerCase() || "";
    return (
      message.includes("cors") ||
      message.includes("cross-origin") ||
      message.includes("network") ||
      message.includes("failed to fetch") ||
      message.includes("load pdf")
    );
  }

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
            if (reportProgress) reportProgress(45, 100, "downloaded");
            resolve(arrayBuffer);
          } else {
            reject(new Error("No data received from background"));
          }
        },
      );
    });
  }

  async #cachePageDimensions() {
    this.pageDimensions = [];
    if (!this.pdfDoc?.pages) return;

    for (const page of this.pdfDoc.pages) {
      this.pageDimensions.push({
        width: page.size.width,
        height: page.size.height,
      });
    }
  }

  async #loadBookmarksAndDestinations() {
    this.allNamedDests = new Map();
    if (!this.pdfDoc || !this.native) return;

    try {
      const bookmarks = await this.native.getBookmarks(this.pdfDoc).toPromise();

      const processBookmarks = async (items, prefix = "") => {
        if (!items || !Array.isArray(items)) return;

        for (let i = 0; i < items.length; i++) {
          const bookmark = items[i];

          if (bookmark.target.type === "action") {
            const destName = bookmark.title || `${prefix}bookmark_${i}`;
            this.allNamedDests.set(destName, {
              pageIndex: bookmark.target.action.destination.pageIndex ?? 0,
              left: bookmark.target.action.destination.view[0] ?? 0,
              top: bookmark.target.action.destination.view[1] ?? 0,
              zoom: bookmark.target.action.destination.zoom.mode ?? null,
            });
          }

          if (bookmark.children?.length > 0) {
            await processBookmarks(bookmark.children, `${prefix}${i}_`);
          }
        }
      };

      await processBookmarks(bookmarks.bookmarks);
    } catch (error) {
      console.warn("[Doc] Error loading bookmarks:", error);
    }
  }

  // ============================================================================
  // Page access
  // ============================================================================

  get numPages() {
    return this.pdfDoc?.pages?.length || 0;
  }

  getPage(pageNumber) {
    if (!this.pdfDoc?.pages) return null;
    return this.pdfDoc.pages[pageNumber - 1] || null;
  }

  getPageDimensions(pageNumber) {
    return this.pageDimensions[pageNumber - 1] || null;
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  async getDocumentTitle() {
    if (this.pdfDoc && this.native) {
      try {
        const metadata = await this.native.getMetadata(this.pdfDoc).toPromise();
        const metadataTitle = metadata?.title?.trim();
        const detectedTitle = this.detectedMetadata?.title;
        const useDetected =
          detectedTitle &&
          detectedTitle?.length >= (metadataTitle?.length || 0);
        return useDetected ? detectedTitle : metadataTitle;
      } catch (error) {
        console.warn("[Doc] Error getting PDF metadata:", error);
      }
    }
    return this.detectedMetadata?.title || null;
  }

  async getMetadata() {
    const result = await this.native.getMetadata(this.pdfDoc).toPromise();
    return result;
  }

  resolveDestination(destName) {
    return this.allNamedDests.get(destName) || null;
  }

  extractPageText(pageIndex) {
    if (!this.lowLevelHandle) return null;
    return this.lowLevelHandle.extractPageText(pageIndex);
  }

  // ============================================================================
  // Subscribers
  // ============================================================================

  subscribe(pane) {
    this.subscribers.add(pane);
  }

  unsubscribe(pane) {
    this.subscribers.delete(pane);
  }

  notify(event, data) {
    for (const subscriber of this.subscribers) {
      subscriber.onDocumentChange?.(event, data);
    }
  }

  // ============================================================================
  // Annotation Loading (from PDF)
  // ============================================================================

  /**
   * Load annotations from the PDF document.
   * Converts embedPDF annotation format to our UI format.
   */
  async loadAnnotations() {
    if (!this.pdfDoc || !this.engine) return;

    // Clear existing state
    this.annotations.clear();
    this.annotationsByPage.clear();
    this.#annotationIdToPdfId.clear();
    this.#linkedComments.clear();
    this.nativeAnnotationsByPage.clear();

    // Temporary storage to link comments to their parent annotations
    const textAnnotations = [];

    for (let pageNum = 1; pageNum <= this.numPages; pageNum++) {
      const page = this.getPage(pageNum);
      if (!page) continue;

      try {
        const annotations = await this.engine
          .getPageAnnotations(this.pdfDoc, page)
          .toPromise();

        this.nativeAnnotationsByPage.set(pageNum, annotations);

        const { width: pageWidth, height: pageHeight } = page.size;

        for (const annot of annotations) {
          if (
            annot.type === PdfAnnotationSubtype.HIGHLIGHT ||
            annot.type === PdfAnnotationSubtype.UNDERLINE
          ) {
            const converted = this.#convertPdfAnnotationToUI(
              annot,
              pageNum,
              pageWidth,
              pageHeight,
            );
            if (converted) {
              this.annotations.set(converted.id, converted);
              this.#addToPageIndex(converted.id, pageNum);
              this.#annotationIdToPdfId.set(converted.id, annot.id);
            }
          }
          // Collect text (sticky note) annotations to link later
          else if (annot.type === PdfAnnotationSubtype.TEXT) {
            textAnnotations.push({
              pdfAnnot: annot,
              pageNum,
              pageWidth,
              pageHeight,
            });
          }
        }
      } catch (error) {
        console.warn(
          `[Doc] Error loading annotations for page ${pageNum}:`,
          error,
        );
      }
    }

    // Link text annotations to their parent markup annotations
    this.#linkTextAnnotationsToMarkup(textAnnotations);

    if (this.annotations.size > 0) {
      this.notify("annotations-imported", { count: this.annotations.size });
    }
  }

  /**
   * Convert a PDF annotation to our UI representation
   */
  #convertPdfAnnotationToUI(annot, pageNum, pageWidth, pageHeight) {
    const rects = [];

    if (annot.segmentRects?.length > 0) {
      for (const segRect of annot.segmentRects) {
        const x = segRect.origin?.x ?? 0;
        const y = segRect.origin?.y ?? 0;
        const width = segRect.size?.width ?? 0;
        const height = segRect.size?.height ?? 0;

        rects.push({
          leftRatio: x / pageWidth,
          topRatio: 1 - (y + height) / pageHeight,
          widthRatio: width / pageWidth,
          heightRatio: height / pageHeight,
        });
      }
    } else if (annot.rect) {
      const x = annot.rect.origin?.x ?? 0;
      const y = annot.rect.origin?.y ?? 0;
      const width = annot.rect.size?.width ?? 0;
      const height = annot.rect.size?.height ?? 0;

      rects.push({
        leftRatio: x / pageWidth,
        topRatio: 1 - (y + height) / pageHeight,
        widthRatio: width / pageWidth,
        heightRatio: height / pageHeight,
      });
    }

    if (rects.length === 0) return null;

    const type =
      annot.type === PdfAnnotationSubtype.UNDERLINE ? "underline" : "highlight";

    const color = hexToColorName(annot.color);

    return {
      id: annot.id || uuidV4(),
      type,
      color,
      pageRanges: [{ pageNumber: pageNum, rects, text: "" }],
      comment: annot.contents?.trim() || null,
      createdAt: annot.created?.toISOString() || new Date().toISOString(),
      updatedAt: annot.modified?.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * Link text (sticky note) annotations to their parent markup annotations
   * by checking if the text annotation's position is near a markup annotation
   */
  #linkTextAnnotationsToMarkup(textAnnotations) {
    for (const { pdfAnnot, pageNum } of textAnnotations) {
      // Check if this text annotation has a linkedAnnotationId in custom data
      const linkedId = pdfAnnot.custom?.linkedAnnotationId;

      if (linkedId && this.annotations.has(linkedId)) {
        // Direct link via custom data
        const markup = this.annotations.get(linkedId);
        if (markup && pdfAnnot.contents) {
          markup.comment = pdfAnnot.contents.trim();
          this.#linkedComments.set(linkedId, pdfAnnot.id);
        }
      } else if (pdfAnnot.contents) {
        // Try to find nearby markup annotation on same page
        const nearbyMarkup = this.#findNearbyMarkupAnnotation(
          pdfAnnot,
          pageNum,
        );
        if (nearbyMarkup) {
          nearbyMarkup.comment = pdfAnnot.contents.trim();
          this.#linkedComments.set(nearbyMarkup.id, pdfAnnot.id);
        }
      }
    }
  }

  /**
   * Find a markup annotation near the text annotation's position
   */
  #findNearbyMarkupAnnotation(textAnnot, pageNum) {
    const textX = textAnnot.rect?.origin?.x ?? 0;
    const textY = textAnnot.rect?.origin?.y ?? 0;
    const pageDims = this.getPageDimensions(pageNum);
    if (!pageDims) return null;

    const threshold = Math.max(pageDims.width, pageDims.height) * 0.1;

    let closest = null;
    let closestDist = Infinity;

    for (const annotation of this.annotations.values()) {
      if (annotation.comment) continue; // Already has a comment

      const pageRange = annotation.pageRanges.find(
        (pr) => pr.pageNumber === pageNum,
      );
      if (!pageRange || pageRange.rects.length === 0) continue;

      // Get first rect position
      const rect = pageRange.rects[0];
      const markupX = rect.leftRatio * pageDims.width;
      const markupY = (1 - rect.topRatio) * pageDims.height;

      const dist = Math.sqrt(
        Math.pow(textX - markupX, 2) + Math.pow(textY - markupY, 2),
      );

      if (dist < threshold && dist < closestDist) {
        closestDist = dist;
        closest = annotation;
      }
    }

    return closest;
  }

  #addToPageIndex(annotationId, pageNumber) {
    if (!this.annotationsByPage.has(pageNumber)) {
      this.annotationsByPage.set(pageNumber, new Set());
    }
    this.annotationsByPage.get(pageNumber).add(annotationId);
  }

  #removeFromPageIndex(annotationId, pageNumber) {
    const pageSet = this.annotationsByPage.get(pageNumber);
    if (pageSet) {
      pageSet.delete(annotationId);
    }
  }

  async #buildInlineElements() {
    // Single-pass extraction
    const extractor = createInlineExtractor(this);
    if (!extractor) return;
    
    const { citations, crossRefs, detectedFormat } = extractor.extract();
    
    // Build merged citations
    const citationBuilder = createCitationBuilder(this);
    this.citationsByPage = citationBuilder.build(citations);
    
    // Build merged cross-references
    const crossRefBuilder = createCrossReferenceBuilder(this);
    const { byPage, targets } = crossRefBuilder.build(crossRefs);
    this.crossRefsByPage = byPage;
    this.crossRefTargets = targets;
    
    // Extract URLs from native annotations
    this.#indexUrls();
  }

  #indexUrls() {
    for (const [pageNum, annotations] of this.nativeAnnotationsByPage) {
      const urls = [];
      for (const annot of annotations) {
        if (annot.target?.type === "action" && annot.target.action?.uri) {
          urls.push({
            url: annot.target.action.uri,
            rect: annot.rect,
          });
        }
      }
      if (urls.length > 0) {
        this.urlsByPage.set(pageNum, urls);
      }
    }
  }


  getCitationAnchorsForPage(pageNumber) {
    return this.citationsByPage?.get(pageNumber) || [];
  }

  // ============================================================================
  // Annotation CRUD Operations
  // ============================================================================

  /**
   * Add a new annotation.
   * Creates it in the PDF engine immediately.
   *
   * @param {Object} annotationData
   * @param {string} annotationData.type - 'highlight' or 'underline'
   * @param {string} annotationData.color - Color name ('yellow', 'red', 'blue', 'green')
   * @param {Array} annotationData.pageRanges - Array of {pageNumber, rects, text}
   * @param {string} [annotationData.comment] - Optional comment text
   * @returns {Object} The created annotation
   */
  async addAnnotation(annotationData) {
    const id = uuidV4();
    const now = new Date().toISOString();

    const annotation = {
      id,
      type: annotationData.type,
      color: annotationData.color,
      pageRanges: annotationData.pageRanges,
      comment: annotationData.comment || null,
      createdAt: now,
      updatedAt: now,
    };

    this.annotations.set(id, annotation);
    for (const pageRange of annotation.pageRanges) {
      this.#addToPageIndex(id, pageRange.pageNumber);
    }
    await this.#createAnnotationInEngine(annotation);

    this.notify("annotation-added", { annotation });
    return annotation;
  }

  async #createAnnotationInEngine(annotation) {
    if (!this.pdfDoc || !this.engine) return;

    for (const pageRange of annotation.pageRanges) {
      const page = this.getPage(pageRange.pageNumber);
      if (!page) continue;

      const { width: pageWidth, height: pageHeight } = page.size;

      const segmentRects = pageRange.rects.map((rect) =>
        this.#uiRectToEngineRect(rect, pageWidth, pageHeight),
      );

      const boundingRect = this.#calculateBoundingRect(segmentRects);

      const type =
        annotation.type === "underline"
          ? PdfAnnotationSubtype.UNDERLINE
          : PdfAnnotationSubtype.HIGHLIGHT;

      const pdfAnnotation = {
        id: annotation.id,
        type,
        pageIndex: pageRange.pageNumber - 1,
        rect: boundingRect,
        segmentRects,
        color: colorNameToHex(annotation.color),
        opacity: annotation.type === "highlight" ? 0.5 : 1.0,
        contents: annotation.comment || undefined,
        custom: {
          colorName: annotation.color,
          text: pageRange.text || "",
        },
      };

      try {
        const resultId = await this.engine
          .createPageAnnotation(this.pdfDoc, page, pdfAnnotation)
          .toPromise();

        // Store mapping if engine returns a different ID
        if (resultId && resultId !== annotation.id) {
          this.#annotationIdToPdfId.set(annotation.id, resultId);
        } else {
          this.#annotationIdToPdfId.set(annotation.id, annotation.id);
        }
      } catch (error) {
        console.warn("[Doc] Error creating annotation in engine:", error);
      }
    }

    // Create linked comment annotation if comment exists
    if (annotation.comment) {
      await this.#createCommentAnnotation(annotation);
    }
  }

  /**
   * Create a PdfTextAnnoObject (sticky note) for a comment
   */
  async #createCommentAnnotation(annotation) {
    if (!this.pdfDoc || !this.engine || !annotation.comment) return;

    const firstPageRange = annotation.pageRanges[0];
    if (!firstPageRange || firstPageRange.rects.length === 0) return;

    const page = this.getPage(firstPageRange.pageNumber);
    if (!page) return;

    const { width: pageWidth, height: pageHeight } = page.size;

    // Position the comment to the right of the first highlight rect
    const firstRect = firstPageRange.rects[0];
    const highlightRight =
      (firstRect.leftRatio + firstRect.widthRatio) * pageWidth;
    const highlightTop = (1 - firstRect.topRatio) * pageHeight;

    // Comment note icon size and position
    const noteSize = 20;
    const noteX = Math.min(highlightRight + 5, pageWidth - noteSize - 5);
    const noteY = highlightTop - noteSize / 2;

    const commentId = uuidV4();

    const commentAnnotation = {
      id: commentId,
      type: PdfAnnotationSubtype.TEXT,
      pageIndex: firstPageRange.pageNumber - 1,
      rect: {
        origin: { x: noteX, y: Math.max(5, noteY) },
        size: { width: noteSize, height: noteSize },
      },
      contents: annotation.comment,
      color: colorNameToHex(annotation.color),
      opacity: 1.0,
      icon: "Comment",
      custom: {
        linkedAnnotationId: annotation.id,
      },
    };

    try {
      const resultId = await this.engine
        .createPageAnnotation(this.pdfDoc, page, commentAnnotation)
        .toPromise();

      this.#linkedComments.set(annotation.id, resultId || commentId);
    } catch (error) {
      console.warn("[Doc] Error creating comment annotation:", error);
    }
  }

  /**
   * @param {string} id - Annotation ID
   * @param {Object} updates - Properties to update
   * @returns {Object|null} The updated annotation
   */
  async updateAnnotation(id, updates) {
    const annotation = this.annotations.get(id);
    if (!annotation) return null;

    const oldComment = annotation.comment;

    // Apply updates
    if (updates.color !== undefined) annotation.color = updates.color;
    if (updates.type !== undefined) annotation.type = updates.type;
    if (updates.comment !== undefined) annotation.comment = updates.comment;
    annotation.updatedAt = new Date().toISOString();

    // Update in PDF engine
    await this.#updateAnnotationInEngine(annotation, oldComment);

    this.notify("annotation-updated", { annotation });
    return annotation;
  }

  async #updateAnnotationInEngine(annotation, oldComment) {
    if (!this.pdfDoc || !this.engine) return;

    const pdfId = this.#annotationIdToPdfId.get(annotation.id);

    for (const pageRange of annotation.pageRanges) {
      const page = this.getPage(pageRange.pageNumber);
      if (!page) continue;

      const { width: pageWidth, height: pageHeight } = page.size;

      const segmentRects = pageRange.rects.map((rect) =>
        this.#uiRectToEngineRect(rect, pageWidth, pageHeight),
      );

      const boundingRect = this.#calculateBoundingRect(segmentRects);

      const type =
        annotation.type === "underline"
          ? PdfAnnotationSubtype.UNDERLINE
          : PdfAnnotationSubtype.HIGHLIGHT;

      const pdfAnnotation = {
        id: pdfId || annotation.id,
        type,
        pageIndex: pageRange.pageNumber - 1,
        rect: boundingRect,
        segmentRects,
        color: colorNameToHex(annotation.color),
        opacity: annotation.type === "highlight" ? 0.5 : 1.0,
        contents: annotation.comment || undefined,
        custom: {
          colorName: annotation.color,
          text: pageRange.text || "",
        },
      };

      try {
        await this.engine
          .updatePageAnnotation(this.pdfDoc, page, pdfAnnotation)
          .toPromise();
      } catch (error) {
        console.warn("[Doc] Error updating annotation in engine:", error);
      }
    }

    // Handle comment annotation changes
    await this.#updateCommentAnnotation(annotation, oldComment);
  }

  async #updateCommentAnnotation(annotation, oldComment) {
    const existingCommentId = this.#linkedComments.get(annotation.id);

    if (annotation.comment && !existingCommentId) {
      // Create new comment annotation
      await this.#createCommentAnnotation(annotation);
    } else if (!annotation.comment && existingCommentId) {
      // Remove comment annotation
      await this.#removeCommentAnnotation(annotation.id);
    } else if (annotation.comment && existingCommentId) {
      // Update existing comment annotation
      const firstPageRange = annotation.pageRanges[0];
      if (!firstPageRange) return;

      const page = this.getPage(firstPageRange.pageNumber);
      if (!page) return;

      try {
        // Get the existing comment annotation to preserve position
        const annotations = await this.engine
          .getPageAnnotations(this.pdfDoc, page)
          .toPromise();

        const existingComment = annotations.find(
          (a) => a.id === existingCommentId,
        );

        if (existingComment) {
          const updatedComment = {
            ...existingComment,
            contents: annotation.comment,
            color: colorNameToHex(annotation.color),
          };

          await this.engine
            .updatePageAnnotation(this.pdfDoc, page, updatedComment)
            .toPromise();
        }
      } catch (error) {
        console.warn("[Doc] Error updating comment annotation:", error);
      }
    }
  }

  async #removeCommentAnnotation(annotationId) {
    const commentId = this.#linkedComments.get(annotationId);
    if (!commentId) return;

    const annotation = this.annotations.get(annotationId);
    if (!annotation) return;

    const firstPageRange = annotation.pageRanges[0];
    if (!firstPageRange) return;

    const page = this.getPage(firstPageRange.pageNumber);
    if (!page) return;

    try {
      await this.engine
        .removePageAnnotation(this.pdfDoc, page, { id: commentId })
        .toPromise();

      this.#linkedComments.delete(annotationId);
    } catch (error) {
      console.warn("[Doc] Error removing comment annotation:", error);
    }
  }

  /**
   * @param {string} id - Annotation ID
   * @returns {boolean} Success
   */
  async deleteAnnotation(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    // Remove from PDF engine
    await this.#deleteAnnotationFromEngine(annotation);

    // Remove from local state
    for (const pageRange of annotation.pageRanges) {
      this.#removeFromPageIndex(id, pageRange.pageNumber);
    }

    this.annotations.delete(id);
    this.#annotationIdToPdfId.delete(id);

    this.notify("annotation-deleted", { annotationId: id });
    return true;
  }

  async #deleteAnnotationFromEngine(annotation) {
    if (!this.pdfDoc || !this.engine) return;

    const pdfId = this.#annotationIdToPdfId.get(annotation.id);

    for (const pageRange of annotation.pageRanges) {
      const page = this.getPage(pageRange.pageNumber);
      if (!page) continue;

      try {
        await this.engine
          .removePageAnnotation(this.pdfDoc, page, {
            id: pdfId || annotation.id,
          })
          .toPromise();
      } catch (error) {
        console.warn("[Doc] Error removing annotation from engine:", error);
      }
    }

    // Also remove linked comment annotation
    await this.#removeCommentAnnotation(annotation.id);
  }

  async deleteAnnotationComment(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    annotation.comment = null;
    annotation.updatedAt = new Date().toISOString();

    // Remove comment annotation from PDF
    await this.#removeCommentAnnotation(id);

    // Update the markup annotation to clear contents
    await this.#updateAnnotationInEngine(annotation, annotation.comment);

    this.notify("annotation-updated", { annotation });
    return true;
  }

  // ============================================================================
  // Annotation Accessors
  // ============================================================================

  getAnnotation(id) {
    return this.annotations.get(id) || null;
  }

  getAnnotationsForPage(pageNumber) {
    const annotationIds = this.annotationsByPage.get(pageNumber);
    if (!annotationIds) return [];
    return Array.from(annotationIds)
      .map((id) => this.annotations.get(id))
      .filter(Boolean);
  }

  getNativeAnnotations(pageNumber) {
    return this.nativeAnnotationsByPage.get(pageNumber) || [];
  }

  getAllAnnotations() {
    return Array.from(this.annotations.values());
  }

  exportAnnotations() {
    return Array.from(this.annotations.values());
  }

  hasAnnotations() {
    return this.annotations.size > 0;
  }

  // ============================================================================
  // Coordinate Conversion Utilities
  // ============================================================================

  /**
   * Convert UI rect (ratio-based, origin top-left) to engine Rect (PDF coords, origin bottom-left)
   */
  #uiRectToEngineRect(uiRect, pageWidth, pageHeight) {
    const x = uiRect.leftRatio * pageWidth;
    const width = uiRect.widthRatio * pageWidth;
    const height = uiRect.heightRatio * pageHeight;
    // Convert Y: UI has origin at top, PDF has origin at bottom
    const y = (1 - uiRect.topRatio - uiRect.heightRatio) * pageHeight;

    return {
      origin: { x, y },
      size: { width, height },
    };
  }

  /**
   * Calculate bounding rect from an array of rects
   */
  #calculateBoundingRect(rects) {
    if (rects.length === 0) {
      return { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
    }

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of rects) {
      const x = rect.origin.x;
      const y = rect.origin.y;
      const right = x + rect.size.width;
      const top = y + rect.size.height;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, top);
    }

    return {
      origin: { x: minX, y: minY },
      size: { width: maxX - minX, height: maxY - minY },
    };
  }

  // ============================================================================
  // Document Saving
  // ============================================================================

  /**
   * Save the document with all annotation changes.
   * Since we apply changes to the engine immediately, this just calls saveAsCopy.
   *
   * @returns {Promise<ArrayBuffer>} The saved PDF as ArrayBuffer
   */
  async saveWithAnnotations() {
    if (!this.pdfDoc || !this.engine) {
      throw new Error("No PDF document loaded");
    }

    try {
      return await this.engine.saveAsCopy(this.pdfDoc).toPromise();
    } catch (error) {
      console.error("Error saving document:", error);
      throw error;
    }
  }

  // ============================================================================
  // Outline Building
  // ============================================================================

  async #buildOutline() {
    this.outline = await buildOutline(
      this.pdfDoc,
      this.native,
      this.textIndex,
      this.allNamedDests,
    );

    this.#injectAbstractIntoOutline();
  }

  #injectAbstractIntoOutline() {
    const abstractInfo = this.detectedMetadata?.abstractInfo;
    if (!abstractInfo) return;

    if (this.#outlineContainsAbstract(this.outline)) return;

    const abstractItem = {
      id: crypto.randomUUID(),
      title: "Abstract",
      pageIndex: abstractInfo.pageIndex,
      left: abstractInfo.left,
      top: abstractInfo.top,
      children: [],
    };

    let insertIndex = 0;
    for (let i = 0; i < this.outline.length; i++) {
      const item = this.outline[i];
      if (item.pageIndex > abstractInfo.pageIndex) break;
      if (
        item.pageIndex === abstractInfo.pageIndex &&
        item.top <= abstractInfo.top
      )
        break;
      insertIndex = i + 1;
    }

    this.outline.splice(insertIndex, 0, abstractItem);
  }

  #outlineContainsAbstract(items) {
    for (const item of items) {
      const title = item.title?.toLowerCase().trim() || "";
      if (
        title === "abstract" ||
        /^\d+\.?\s*abstract$/i.test(item.title?.trim() || "")
      ) {
        return true;
      }
      if (
        item.children?.length > 0 &&
        this.#outlineContainsAbstract(item.children)
      ) {
        return true;
      }
    }
    return false;
  }

  // ============================================================================
  // Reference Index
  // ============================================================================

  getReferenceAnchors(pageNumber) {
    if (!this.referenceIndex?.anchors) return [];
    return this.referenceIndex.anchors.filter(
      (a) => a.pageNumber === pageNumber,
    );
  }

  getAllReferenceAnchors() {
    return this.referenceIndex?.anchors || [];
  }

  getReferenceByIndex(index) {
    if (!this.referenceIndex?.anchors) return null;
    return findReferenceByIndex(this.referenceIndex.anchors, index);
  }

  findBoundingReferenceAnchors(pageNumber, x, y) {
    if (!this.referenceIndex?.anchors) return { current: null, next: null };
    return findBoundingAnchors(this.referenceIndex.anchors, pageNumber, x, y);
  }

  matchCitationToReference(author, year) {
    if (!this.referenceIndex?.anchors) return null;
    return matchCitationToReference(author, year, this.referenceIndex.anchors);
  }

  hasReferenceIndex() {
    return this.referenceIndex?.anchors?.length > 0;
  }

  getReferenceSectionBounds() {
    if (!this.referenceIndex?.sectionStart) return null;
    return {
      startPage: this.referenceIndex.sectionStart.pageNumber,
      endPage: this.referenceIndex.sectionEnd?.pageNumber || this.numPages,
    };
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async close() {
    if (this.lowLevelHandle) {
      this.lowLevelHandle.close();
      this.lowLevelHandle = null;
      this.textExtractor = null;
    }

    if (this.pdfDoc && this.engine) {
      try {
        await this.engine.closeDocument(this.pdfDoc).toPromise();
      } catch (error) {
        console.warn("[Doc] Error closing document:", error);
      }
    }
    this.pdfDoc = null;
    this.pdfData = null;
    this.nativeAnnotationsByPage.clear();
    this.annotations.clear();
    this.annotationsByPage.clear();
    this.#annotationIdToPdfId.clear();
    this.#linkedComments.clear();
    this.citationsByPage?.clear();
    this.citationsByPage = null;
    this.anchors = null;
    this.textIndex?.destroy();
    this.textIndex = null;
  }
}
