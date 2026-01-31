/**
 * PDFDocumentModel - Refactored for @embedpdf/engines (PDFium)
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

const COLOR_TO_RGB = {
  yellow: [255, 179, 0],
  red: [229, 57, 53],
  blue: [30, 136, 229],
  green: [67, 160, 71],
};

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
    this.annotations = new Map();
    this.annotationsByPage = new Map();
    this.importedPdfAnnotations = new Map();

    /** @type {Map<number, Array>} - Native annotations cached per page */
    this.nativeAnnotationsByPage = new Map();
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

      reportProgress(55, 100, "setting up text extraction");
      this.#setupLowLevelAccess(pdfiumModule);

      reportProgress(58, 100, "processing");
      await this.#cachePageDimensions();

      reportProgress(60, 100, "loading bookmarks");
      await this.#loadBookmarksAndDestinations();

      reportProgress(70, 100, "loading annotations");
      await this.loadAnnotations();

      reportProgress(80, 100, "indexing text");
      this.textIndex = new DocumentTextIndex(this);
      if (this.lowLevelHandle) {
        this.textIndex.setLowLevelHandle(this.lowLevelHandle);
      }
      await this.textIndex.build();

      this.detectedMetadata = detectDocumentMetadata(this.textIndex);

      reportProgress(85, 100, "indexing references");
      this.referenceIndex = await buildReferenceIndex(this.textIndex);

      reportProgress(90, 100, "building outline");
      await this.#buildOutline();

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

  resolveDestination(destName) {
    return this.allNamedDests.get(destName) || null;
  }

  extractPageText(pageIndex) {
    if (!this.lowLevelHandle) return null;
    return this.lowLevelHandle.extractPageText(pageIndex);
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

  addAnnotation(annotationData) {
    const annotation = {
      id: this.#generateAnnotationId(),
      type: annotationData.type,
      color: annotationData.color,
      pageRanges: annotationData.pageRanges,
      comment: annotationData.comment || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.annotations.set(annotation.id, annotation);

    for (const pageRange of annotation.pageRanges) {
      if (!this.annotationsByPage.has(pageRange.pageNumber)) {
        this.annotationsByPage.set(pageRange.pageNumber, new Set());
      }
      this.annotationsByPage.get(pageRange.pageNumber).add(annotation.id);
    }

    this.notify("annotation-added", { annotation });
    return annotation;
  }

  updateAnnotation(id, updates) {
    const annotation = this.annotations.get(id);
    if (!annotation) return null;

    if (updates.color !== undefined) annotation.color = updates.color;
    if (updates.type !== undefined) annotation.type = updates.type;
    if (updates.comment !== undefined) annotation.comment = updates.comment;
    annotation.updatedAt = new Date().toISOString();

    this.notify("annotation-updated", { annotation });
    return annotation;
  }

  deleteAnnotation(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    for (const pageRange of annotation.pageRanges) {
      const pageAnnotations = this.annotationsByPage.get(pageRange.pageNumber);
      if (pageAnnotations) pageAnnotations.delete(id);
    }

    this.annotations.delete(id);
    this.notify("annotation-deleted", { annotationId: id });
    return true;
  }

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

  deleteAnnotationComment(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    annotation.comment = null;
    annotation.updatedAt = new Date().toISOString();
    this.notify("annotation-updated", { annotation });
    return true;
  }

  exportAnnotations() {
    return Array.from(this.annotations.values());
  }

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

  async loadAnnotations() {
    if (!this.pdfDoc || !this.native) return;

    const importedAnnotations = [];

    for (let pageNum = 1; pageNum <= this.numPages; pageNum++) {
      const page = this.getPage(pageNum);
      if (!page) continue;

      try {
        const annotations = await this.native
          .getPageAnnotations(this.pdfDoc, page)
          .toPromise();

        this.nativeAnnotationsByPage.set(pageNum, annotations);

        const { width: pageWidth, height: pageHeight } = page.size;

        for (const annot of annotations) {
          if (annot.subtype === "Highlight" || annot.type === 9) {
            const converted = this.#convertPdfiumHighlightAnnotation(
              annot,
              pageNum,
              pageWidth,
              pageHeight,
            );
            if (converted) {
              importedAnnotations.push(converted);
              this.importedPdfAnnotations.set(converted.id, {
                pageNumber: pageNum,
                pdfiumAnnotationId: annot.id || null,
                annotationType: "Highlight",
              });
            }
          }
        }
      } catch (error) {
        console.warn(
          `[Doc] Error loading annotations for page ${pageNum}:`,
          error,
        );
      }
    }

    if (importedAnnotations.length > 0) {
      this.importAnnotations(importedAnnotations);
    }
  }

  #convertPdfiumHighlightAnnotation(annot, pageNum, pageWidth, pageHeight) {
    const rects = [];

    if (annot.quadPoints?.length >= 8) {
      for (let i = 0; i < annot.quadPoints.length; i += 8) {
        const quad = annot.quadPoints.slice(i, i + 8);
        if (quad.length < 8) break;

        const tLx = quad[0],
          tLy = quad[1];
        const tRx = quad[2],
          tRy = quad[3];
        const bLx = quad[4],
          bLy = quad[5];
        const bRx = quad[6],
          bRy = quad[7];

        const minX = Math.min(tLx, tRx, bLx, bRx);
        const maxX = Math.max(tLx, tRx, bLx, bRx);
        const minY = Math.min(tLy, tRy, bLy, bRy);
        const maxY = Math.max(tLy, tRy, bLy, bRy);

        rects.push({
          leftRatio: minX / pageWidth,
          topRatio: 1 - maxY / pageHeight,
          widthRatio: (maxX - minX) / pageWidth,
          heightRatio: (maxY - minY) / pageHeight,
        });
      }
    } else if (annot.rect) {
      const rect = annot.rect;
      const minX = Math.min(rect[0], rect[2]);
      const maxX = Math.max(rect[0], rect[2]);
      const minY = Math.min(rect[1], rect[3]);
      const maxY = Math.max(rect[1], rect[3]);

      rects.push({
        leftRatio: minX / pageWidth,
        topRatio: 1 - maxY / pageHeight,
        widthRatio: (maxX - minX) / pageWidth,
        heightRatio: (maxY - minY) / pageHeight,
      });
    }

    if (rects.length === 0) return null;

    const color = rgbToColorName(annot.color);
    const comment = annot.contents || null;

    return {
      id: `imported-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: "highlight",
      color,
      pageRanges: [{ pageNumber: pageNum, rects, text: "" }],
      comment: comment?.trim() || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pdfiumAnnotationId: annot.id || null,
    };
  }

  notify(event, data) {
    for (const subscriber of this.subscribers) {
      subscriber.onDocumentChange?.(event, data);
    }
  }

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

  #colorNameToRgb(colorName) {
    return COLOR_TO_RGB[colorName] || COLOR_TO_RGB.yellow;
  }

  async saveWithAnnotations() {
    if (!this.pdfDoc || !this.engine || !this.native) {
      throw new Error("No PDF document loaded");
    }

    const allAnnotations = this.getAllAnnotations();

    if (allAnnotations.length === 0 && this.importedPdfAnnotations.size === 0) {
      return await this.engine.saveAsCopy(this.pdfDoc).toPromise();
    }

    for (const annotation of allAnnotations) {
      for (let i = 0; i < annotation.pageRanges.length; i++) {
        const pageRange = annotation.pageRanges[i];
        const page = this.getPage(pageRange.pageNumber);
        if (!page) continue;

        const { width: pageWidth, height: pageHeight } = page.size;
        const color = this.#colorNameToRgb(annotation.color);

        const rects = pageRange.rects.map((rect) => ({
          x: rect.leftRatio * pageWidth,
          y: (1 - rect.topRatio - rect.heightRatio) * pageHeight,
          width: rect.widthRatio * pageWidth,
          height: rect.heightRatio * pageHeight,
        }));

        try {
          await this.native
            .createPageAnnotation(this.pdfDoc, page, {
              type: "highlight",
              color,
              opacity: 1,
              rects,
              contents: i === 0 ? annotation.comment : null,
            })
            .toPromise();
        } catch (error) {
          console.warn(`[Doc] Error creating annotation:`, error);
        }
      }
    }

    try {
      return await this.engine.saveAsCopy(this.pdfDoc).toPromise();
    } catch (error) {
      console.error("Error saving document:", error);
      throw error;
    }
  }

  hasAnnotations() {
    return this.annotations.size > 0;
  }

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
    this.textIndex?.destroy();
    this.textIndex = null;
  }
}
