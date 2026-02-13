/**
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
import { CitationFlags } from "./data/lexicon.js";
import { AnnotationStore } from "./annotation/annotation_data.js";

const MIN_USABLE_REFERENCES = 5;

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

    /** @type {AnnotationStore} */
    this.annotationStore = new AnnotationStore(this);

    this.citationsByPage = new Map();
    this.citationDetails = new Map();
    this.crossRefsByPage = new Map();
    this.crossRefTargets = new Map();
    this.urlsByPage = new Map();

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

  /** @returns {Map<number, Array>} */
  get nativeAnnotationsByPage() {
    return this.annotationStore.nativeAnnotationsByPage;
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

  /**
   * @param {ArrayBuffer} arrayBuffer
   * @param {(p: {loaded: number, total: number, percent: number, phase: string}) => void} [onProgress]
   */
  async load(arrayBuffer, onProgress) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new Error("PDFDocumentModel.load() requires an ArrayBuffer");
    }

    const reportProgress = (percent, phase) => {
      if (onProgress) {
        onProgress({ loaded: percent, total: 100, percent, phase });
      }
    };

    reportProgress(5, "initializing engine");
    const { engine, native, pdfiumModule } = await initPdfiumEngine((p) => {
      const mapped = 5 + Math.round(p.percent * 0.15);
      reportProgress(mapped, p.phase);
    });

    this.engine = engine;
    this.native = native;

    try {
      reportProgress(20, "parsing");
      this.pdfData = new Uint8Array(arrayBuffer);

      reportProgress(25, "parsing");
      this.pdfDoc = await this.engine
        .openDocumentBuffer({
          id: `doc-${Date.now()}`,
          content: this.pdfData,
        })
        .toPromise();

      reportProgress(35, "setting up text extraction engine");
      this.#setupLowLevelAccess(pdfiumModule);
      this.pdfData = null;

      reportProgress(40, "processing");
      await this.#cachePageDimensions();

      reportProgress(45, "loading bookmarks");
      await this.#loadBookmarksAndDestinations();

      reportProgress(50, "indexing text");
      this.textIndex = new DocumentTextIndex(this);
      if (this.lowLevelHandle) {
        this.textIndex.setLowLevelHandle(this.lowLevelHandle);
      }
      await this.textIndex.build();

      this.detectedMetadata = detectDocumentMetadata(this.textIndex);

      reportProgress(65, "indexing references");
      this.referenceIndex = await buildReferenceIndex(this.textIndex);
      console.log(this.referenceIndex);

      const hasUsableIndex =
        (this.referenceIndex?.anchors?.length || 0) >= MIN_USABLE_REFERENCES;

      reportProgress(75, "building outline");
      await this.#buildOutline();

      reportProgress(80, "loading annotations");
      await this.annotationStore.loadFromDocument();

      reportProgress(88, "processing");
      if (hasUsableIndex) {
        console.log("[Doc] Parsing full text for inline links...");
        await this.#buildInlineElements();
      } else {
        console.warn(
          `[Doc] Reference index insufficient (${this.referenceIndex?.anchors?.length || 0} anchors), using native-only fallback`,
        );
        this.#buildNativeFallback();
      }

      reportProgress(95, "complete");
      return this.pdfDoc;
    } catch (error) {
      console.error("Error loading PDF:", error);
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
    return await this.native.getMetadata(this.pdfDoc).toPromise();
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
  // Annotation Delegates
  // ============================================================================

  async loadAnnotations() {
    return this.annotationStore.loadFromDocument();
  }

  async addAnnotation(data) {
    return this.annotationStore.addAnnotation(data);
  }

  async updateAnnotation(id, updates) {
    return this.annotationStore.updateAnnotation(id, updates);
  }

  async deleteAnnotation(id) {
    return this.annotationStore.deleteAnnotation(id);
  }

  async deleteAnnotationComment(id) {
    return this.annotationStore.deleteAnnotationComment(id);
  }

  getAnnotation(id) {
    return this.annotationStore.getAnnotation(id);
  }

  getAnnotationsForPage(pageNumber) {
    return this.annotationStore.getAnnotationsForPage(pageNumber);
  }

  getNativeAnnotations(pageNumber) {
    return this.annotationStore.getNativeAnnotations(pageNumber);
  }

  getAllAnnotations() {
    return this.annotationStore.getAllAnnotations();
  }

  exportAnnotations() {
    return this.annotationStore.exportAnnotations();
  }

  hasAnnotations() {
    return this.annotationStore.hasAnnotations();
  }

  // ============================================================================
  // Inline Element Building
  // ============================================================================

  async #buildInlineElements() {
    const extractor = createInlineExtractor(this);
    if (!extractor) return;

    const { citations, crossRefs, detectedFormat } = extractor.extract();

    const citationBuilder = createCitationBuilder(this);
    const { byPage: byPageCitations, details } =
      citationBuilder.build(citations);
    this.citationsByPage = byPageCitations;
    this.citationDetails = details;

    const crossRefBuilder = createCrossReferenceBuilder(this);
    const { byPage: byPageCrossRefs, targets } =
      crossRefBuilder.build(crossRefs);
    this.crossRefsByPage = byPageCrossRefs;
    this.crossRefTargets = targets;

    this.#indexUrls();
  }

  /**
   * Fallback when reference section is not found or has too few anchors.
   * Renders native destination links directly as navigable overlays,
   * skipping inline extraction and citation/cross-ref building entirely.
   */
  #buildNativeFallback() {
    this.#indexUrls();

    this.citationsByPage = new Map();
    this.citationDetails = new Map();
    this.crossRefsByPage = new Map();
    this.crossRefTargets = new Map();

    let nextId = 0;

    for (const [pageNum, annotations] of this.nativeAnnotationsByPage) {
      const citRefs = [];

      for (const annot of annotations) {
        if (annot.target?.type !== "destination") continue;

        const dest = annot.target.destination;
        if (!dest || !annot.rect) continue;

        const destPageIndex = dest.pageIndex ?? -1;
        const destX = dest.view?.[0] ?? 0;
        const destY = dest.view?.[1] ?? 0;

        if (destPageIndex < 0 || (destX === 0 && destY === 0)) continue;

        const citationId = nextId++;
        const rect = {
          x: annot.rect.origin?.x || 0,
          y: annot.rect.origin?.y || 0,
          width: annot.rect.size?.width || 0,
          height: annot.rect.size?.height || 0,
        };
        const targetLocation = { pageIndex: destPageIndex, x: destX, y: destY };
        const flags =
          CitationFlags.NATIVE_CONFIRMED | CitationFlags.DEST_CONFIRMED;

        citRefs.push({ citationId, rects: [rect], flags });

        this.citationDetails.set(citationId, {
          type: "native-fallback",
          text: "",
          pageNumber: pageNum,
          rects: [rect],
          refIndices: [],
          refRanges: [],
          refKeys: null,
          confidence: 1.0,
          flags,
          targetLocation,
          allTargets: [
            { refIndex: null, refKey: null, location: targetLocation },
          ],
        });
      }

      if (citRefs.length > 0) {
        this.citationsByPage.set(pageNum, citRefs);
      }
    }

    const total = Array.from(this.citationsByPage.values()).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    console.log(`[Doc] Native fallback: ${total} navigable links`);
  }

  #indexUrls() {
    for (const [pageNum, annotations] of this.nativeAnnotationsByPage) {
      const urls = [];
      for (const annot of annotations) {
        if (annot.target?.type === "action" && annot.target.action?.uri) {
          urls.push({ url: annot.target.action.uri, rect: annot.rect });
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

  getCitationDetails(citationId) {
    return this.citationDetails?.get(citationId) || null;
  }

  // ============================================================================
  // Document Saving
  // ============================================================================

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
    this.annotationStore.clear();
    this.citationsByPage?.clear();
    this.citationsByPage = null;
    this.citationDetails?.clear();
    this.citationDetails = null;
    this.crossRefsByPage?.clear();
    this.crossRefsByPage = null;
    this.crossRefTargets?.clear();
    this.crossRefTargets = null;
    this.urlsByPage?.clear();
    this.urlsByPage = null;
    this.textIndex?.destroy();
    this.textIndex = null;
  }
}
