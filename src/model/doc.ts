import { initPdfiumEngine } from "../pdf/pdfium_init.js";
import { DocumentTextIndex } from "../analysis/text_index.js";
import {
  findBoundingAnchors,
  findReferenceByIndex,
  matchCitationToReference,
} from "../analysis/reference_builder.js";
import { PdfiumDocument } from "../pdf/document.js";
import { stripEmptyAnnotationNotes } from "../pdf/annotation_export.js";
import {
  createPdfPageSource,
  createRawPageTextSource,
} from "../pdf/page_source.js";
import {
  analyzeDocument,
  indexUrls,
  DocumentAnalysis,
} from "../analysis/pipeline.js";
import { collectNamedDestinations } from "../analysis/outline_builder.js";
import { AnnotationStore } from "./annotation_data.js";
import { DocEvent } from "./doc_events.js";

import type { PdfEngine, PdfiumNative } from "@embedpdf/engines/pdfium";
import type {
  PdfDocumentObject,
  PdfPageObject,
  PdfAnnotationObject,
} from "@embedpdf/models";
import type { DocEventName } from "./doc_events.js";
import type {
  ReferenceAnchor,
  ReferenceIndex,
} from "../analysis/reference_builder.js";
import type {
  NamedDestination,
  OutlineItem,
  DocumentMetadata,
} from "../analysis/outline_builder.js";
import type { Citation } from "../analysis/citation_builder.js";
import type { CitationAnchor } from "../analysis/pipeline.js";

/** Anything that wants to hear about document events. */
export interface DocumentSubscriber {
  onDocumentChange?(event: DocEventName, data?: Record<string, any>): void;
}

/** What `load()` reports as it goes. */
export interface LoadProgress {
  loaded: number;
  total: number;
  percent: number;
  phase: string;
}

/** What `buildIndex()` reports as it goes. */
export interface IndexProgress {
  percent: number;
  phase: string;
}

/** The page span a document's reference section covers. */
export interface ReferenceSectionBounds {
  startPage: number;
  endPage: number;
}

export class PDFDocumentModel {
  engine: PdfEngine | null = null;
  native: PdfiumNative | null = null;
  pdfDoc: PdfDocumentObject | null = null;
  allNamedDests = new Map<string, NamedDestination>();

  /**
   * The document's own bookmark tree, fetched once at load. Both the named
   * destination map and the outline builder read it.
   */
  bookmarks: PdfBookmark[] = [];

  pageDimensions: Array<{ width: number; height: number }> = [];

  subscribers = new Set<DocumentSubscriber>();

  annotationStore = new AnnotationStore(this);

  // imagesByPage = new Map<number, ImageObjectInfo[]>();

  /**
   * Everything the analysis pipeline produced. Replaced wholesale by
   * `buildIndex()`; the query methods below read from it and nothing writes
   * into it piecemeal.
   */
  analysis = new DocumentAnalysis();

  textIndex: DocumentTextIndex | null = null;

  pdfData: Uint8Array | null = null;
  /** The document as Hover reads it, opened from the same bytes as `pdfDoc`. */
  document: PdfiumDocument | null = null;
  /** getPageTextBoxes results, by 0-based page index. */
  #textBoxes = new Map<number, Float32Array>();
  // imageExtractor: PdfiumImageExtractor | null = null;

  indexingState: "pending" | "running" | "complete" = "pending";

  get nativeAnnotationsByPage(): Map<number, PdfAnnotationObject[]> {
    return this.annotationStore.nativeAnnotationsByPage;
  }

  // ============================================================================
  // Analysis results — read-only views onto `this.analysis`
  // ============================================================================

  get outline(): OutlineItem[] {
    return this.analysis.outline;
  }

  get referenceIndex(): ReferenceIndex | null {
    return this.analysis.references;
  }

  get detectedMetadata(): DocumentMetadata {
    return this.analysis.metadata;
  }

  get citationsByPage() {
    return this.analysis.citationsByPage;
  }

  get citationDetails() {
    return this.analysis.citationDetails;
  }

  get crossRefsByPage() {
    return this.analysis.crossRefsByPage;
  }

  get crossRefTargets() {
    return this.analysis.crossRefTargets;
  }

  get urlsByPage() {
    return this.analysis.urlsByPage;
  }

  async load(
    arrayBuffer: ArrayBuffer,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<PdfDocumentObject> {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new Error("PDFDocumentModel.load() requires an ArrayBuffer");
    }

    const reportProgress = (percent: number, phase: string) => {
      if (onProgress) {
        onProgress({ loaded: percent, total: 100, percent, phase });
      }
    };

    reportProgress(5, "initializing engine");
    const { engine, native, bindings } = await initPdfiumEngine((p) => {
      const mapped = 5 + Math.round(p.percent * 0.15);
      reportProgress(mapped, p.phase);
    });

    this.engine = engine;
    this.native = native;

    try {
      reportProgress(20, "parsing");
      this.pdfData = new Uint8Array(arrayBuffer);
      // Opened first, so a file PDFium refuses fails with a PdfOpenError.
      this.document = PdfiumDocument.open(bindings, this.pdfData);

      reportProgress(25, "parsing");
      this.pdfDoc = await this.engine
        .openDocumentBuffer({
          id: `doc-${Date.now()}`,
          // The engine does `new Uint8Array(file.content)`, so a typed array
          // works, but PdfFileContent is declared as ArrayBuffer.
          content: this.pdfData as unknown as ArrayBuffer,
        })
        .toPromise();

      this.pdfData = null;

      reportProgress(40, "processing");
      this.#cachePageDimensions();

      reportProgress(45, "loading bookmarks");
      this.#loadBookmarksAndDestinations();
      reportProgress(80, "loading annotations");
      await this.annotationStore.loadFromDocument();
      // URLs are the one analysis product that needs no text index, and pages
      // start rendering long before `buildIndex()` runs.
      this.analysis.urlsByPage = indexUrls(this.nativeAnnotationsByPage);
      reportProgress(95, "complete");
      return this.pdfDoc;
    } catch (error) {
      console.error("Error loading PDF:", error);
      // Refused by the engine after Hover opened it: don't keep half a load.
      if (!this.pdfDoc) {
        this.document?.close();
        this.document = null;
      }
      throw error;
    }
  }

  async buildIndex(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.indexingState !== "pending") return;
    this.indexingState = "running";

    const reportProgress = (percent: number, phase: string) => {
      if (onProgress) {
        onProgress({ percent, phase });
      }
    };

    try {
      reportProgress(10, "indexing text");
      this.textIndex = new DocumentTextIndex(
        createPdfPageSource({ document: this.document }),
      );
      await this.textIndex.build();

      // if (this.imageExtractor && this.document) {
      //   this.#scanImages();
      // }

      this.analysis = analyzeDocument({
        textIndex: this.textIndex,
        nativeAnnotationsByPage: this.nativeAnnotationsByPage,
        bookmarks: this.bookmarks,
        allNamedDests: this.allNamedDests,
        pageTextSource: createRawPageTextSource(this.document),
        onProgress: reportProgress,
      });

      this.indexingState = "complete";
      reportProgress(100, "complete");
      this.notify(DocEvent.INDEX_READY);
    } catch (error) {
      console.error("[Doc] Error during background indexing:", error);
      this.indexingState = "complete";
      this.notify(DocEvent.INDEX_READY);
    }
  }

  #cachePageDimensions() {
    this.pageDimensions = (this.document?.pages ?? []).map((page) => ({
      width: page.size.width,
      height: page.size.height,
    }));
  }

  #loadBookmarksAndDestinations() {
    this.allNamedDests = new Map();
    this.bookmarks = [];
    if (!this.document) return;

    try {
      this.bookmarks = this.document.bookmarks();
      this.allNamedDests = collectNamedDestinations(this.bookmarks);
    } catch (error) {
      console.warn("[Doc] Error loading bookmarks:", error);
    }
  }

  // ============================================================================
  // Page access
  // ============================================================================

  get numPages() {
    return this.document?.pageCount || 0;
  }

  getPage(pageNumber: number): PdfPage | null {
    return this.document?.page(pageNumber - 1) ?? null;
  }

  /**
   * The engine's page object, for the calls that still go to the engine:
   * rendering, and annotation reads and writes.
   * TODO(own-pdf-engine): gone once rendering and annotations have moved
   * (docs/plan_own_pdf_engine.md phases 3–5).
   */
  enginePage(pageNumber: number): PdfPageObject | null {
    return this.pdfDoc?.pages?.[pageNumber - 1] ?? null;
  }

  getPageDimensions(
    pageNumber: number,
  ): { width: number; height: number } | null {
    return this.pageDimensions[pageNumber - 1] || null;
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  async getDocumentTitle(): Promise<string | null> {
    if (this.document) {
      try {
        const metadataTitle = this.document.metadata().title?.trim();
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

  async getMetadata(): Promise<PdfMetadata> {
    if (!this.document) throw new Error("No PDF document loaded");
    return this.document.metadata();
  }

  resolveDestination(destName: string): NamedDestination | null {
    return this.allNamedDests.get(destName) || null;
  }

  /**
   * Cached visible-text boxes for a page; null with no document open.
   *
   * @param pageIndex 0-based
   */
  getPageTextBoxes(pageIndex: number): Float32Array | null {
    if (!this.document) return null;
    let boxes = this.#textBoxes.get(pageIndex);
    if (!boxes) {
      boxes = this.document.extractTextBoxes(pageIndex);
      this.#textBoxes.set(pageIndex, boxes);
    }
    return boxes;
  }

  // ============================================================================
  // Subscribers
  // ============================================================================

  /**
   * Anything with an `onDocumentChange` may subscribe — not just panes. A
   * component that needs to react to `index-ready` should say so itself rather
   * than have `main.js` poke it after the fact.
   *
   */
  subscribe(subscriber: DocumentSubscriber) {
    this.subscribers.add(subscriber);
  }

  unsubscribe(subscriber: DocumentSubscriber) {
    this.subscribers.delete(subscriber);
  }

  notify(event: DocEventName, data?: Record<string, any>) {
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

  async addAnnotation(data: any) {
    return this.annotationStore.addAnnotation(data);
  }

  async updateAnnotation(id: string, updates: any) {
    return this.annotationStore.updateAnnotation(id, updates);
  }

  async deleteAnnotation(id: string) {
    return this.annotationStore.deleteAnnotation(id);
  }

  async deleteAnnotationComment(id: string) {
    return this.annotationStore.deleteAnnotationComment(id);
  }

  getAnnotation(id: string) {
    return this.annotationStore.getAnnotation(id);
  }

  getAnnotationsForPage(pageNumber: number) {
    return this.annotationStore.getAnnotationsForPage(pageNumber);
  }

  getNativeAnnotations(pageNumber: number) {
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
  // Analysis queries
  // ============================================================================

  getCitationAnchorsForPage(pageNumber: number): CitationAnchor[] {
    return this.citationsByPage?.get(pageNumber) || [];
  }

  getCitationDetails(citationId: number): Citation | null {
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
      const bytes = await this.engine.saveAsCopy(this.pdfDoc).toPromise();
      // Without this, Preview and Skim show a blank note on every highlight.
      // TODO(embedpdf v3): drop with the move off engines 2.x; see
      // pdf/annotation_export.ts.
      return stripEmptyAnnotationNotes(new Uint8Array(bytes));
    } catch (error) {
      console.error("Error saving document:", error);
      throw error;
    }
  }

  /** The file as it was opened, before any annotation was added or removed. */
  saveOriginal(): Uint8Array<ArrayBuffer> {
    // PDFium still holds the file the document was opened from, so the
    // original needs no copy of its own until it's asked for.
    if (!this.document) throw new Error("No PDF document loaded");
    return this.document.fileBytes() as Uint8Array<ArrayBuffer>;
  }

  // ============================================================================
  // Reference Index
  // ============================================================================

  getReferenceAnchors(pageNumber: number): ReferenceAnchor[] {
    if (!this.referenceIndex?.anchors) return [];
    return this.referenceIndex.anchors.filter(
      (a) => a.pageNumber === pageNumber,
    );
  }

  getAllReferenceAnchors(): ReferenceAnchor[] {
    return this.referenceIndex?.anchors || [];
  }

  getReferenceByIndex(index: RefIndex): ReferenceAnchor | null {
    if (!this.referenceIndex?.anchors) return null;
    return findReferenceByIndex(this.referenceIndex.anchors, index);
  }

  findBoundingReferenceAnchors(pageNumber: number, x: number, y: number) {
    if (!this.referenceIndex?.anchors) return { current: null, next: null };
    return findBoundingAnchors(this.referenceIndex.anchors, pageNumber, x, y);
  }

  matchCitationToReference(
    author: string | null,
    year: string | null,
  ): ReferenceAnchor | null {
    if (!this.referenceIndex?.anchors) return null;
    return matchCitationToReference(author, year, this.referenceIndex.anchors);
  }

  hasReferenceIndex() {
    return this.analysis.hasReferenceIndex;
  }

  getReferenceSectionBounds(): ReferenceSectionBounds | null {
    if (!this.referenceIndex?.sectionStart) return null;
    return {
      startPage: this.referenceIndex.sectionStart.pageNumber,
      endPage: this.referenceIndex.sectionEnd?.pageNumber || this.numPages,
    };
  }

  // ============================================================================
  // Image Extraction
  // ============================================================================

  // Parked along with `imageExtractor` / `imagesByPage` and the call site in
  // #buildIndex(); it was the only live half left of that feature.
  // #scanImages() {
  //   const docPtr = this.document.docPtr;
  //   for (let i = 0; i < this.numPages; i++) {
  //     const { images } = this.imageExtractor.getPageImageInfos(docPtr, i);
  //     if (images.length > 0) {
  //       this.imagesByPage.set(i + 1, images);
  //     }
  //   }
  // }

  // getPageImages(pageNumber) {
  //   return this.imagesByPage?.get(pageNumber) || [];
  // }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async close() {
    if (this.document) {
      this.document.close();
      this.document = null;
      this.#textBoxes.clear();
      // this.imageExtractor = null;
    }

    if (this.pdfDoc && this.engine) {
      try {
        await this.engine.closeDocument(this.pdfDoc).toPromise();
      } catch (error) {
        console.warn("[Doc] Error closing document:", error);
      }
    }

    this.pdfDoc = null;
    this.bookmarks = [];
    this.annotationStore.clear();
    this.analysis.destroy();
    // this.imagesByPage?.clear();
    // this.imagesByPage = null;
    this.textIndex?.destroy();
    this.textIndex = null;
  }
}
