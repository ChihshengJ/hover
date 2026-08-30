import { initPdfiumEngine } from "../pdf/pdfium_init.js";
import { DocumentTextIndex } from "../analysis/text_index.js";
import {
  findBoundingAnchors,
  findReferenceByIndex,
  matchCitationToReference,
} from "../analysis/reference_builder.js";
import { PdfiumDocumentFactory } from "../pdf/text_extractor.js";
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
  PdfMetadataObject,
  PdfAnnotationObject,
} from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { DocEventName } from "./doc_events.js";
import type {
  PdfiumDocumentHandle,
  PdfiumTextExtractor,
} from "../pdf/text_extractor.js";
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
  bookmarks: any[] = [];

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
  lowLevelHandle: PdfiumDocumentHandle | null = null;
  textExtractor: PdfiumTextExtractor | null = null;
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
          // The engine does `new Uint8Array(file.content)`, so a typed array
          // works, but PdfFileContent is declared as ArrayBuffer.
          content: this.pdfData as unknown as ArrayBuffer,
        })
        .toPromise();

      reportProgress(35, "setting up text extraction engine");
      this.#setupLowLevelAccess(pdfiumModule);
      this.pdfData = null;

      reportProgress(40, "processing");
      await this.#cachePageDimensions();

      reportProgress(45, "loading bookmarks");
      await this.#loadBookmarksAndDestinations();
      reportProgress(80, "loading annotations");
      await this.annotationStore.loadFromDocument();
      // URLs are the one analysis product that needs no text index, and pages
      // start rendering long before `buildIndex()` runs.
      this.analysis.urlsByPage = indexUrls(this.nativeAnnotationsByPage);
      reportProgress(95, "complete");
      return this.pdfDoc;
    } catch (error) {
      console.error("Error loading PDF:", error);
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
        createPdfPageSource({
          pdfDoc: this.pdfDoc,
          native: this.native,
          lowLevelHandle: this.lowLevelHandle,
        }),
      );
      await this.textIndex.build();

      // if (this.imageExtractor && this.lowLevelHandle) {
      //   this.#scanImages();
      // }

      this.analysis = analyzeDocument({
        textIndex: this.textIndex,
        numPages: this.numPages,
        nativeAnnotationsByPage: this.nativeAnnotationsByPage,
        bookmarks: this.bookmarks,
        allNamedDests: this.allNamedDests,
        pageTextSource: this.lowLevelHandle
          ? createRawPageTextSource(this.lowLevelHandle)
          : null,
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

  #setupLowLevelAccess(pdfiumModule: WrappedPdfiumModule | null) {
    if (!this.pdfData || !pdfiumModule) return;

    try {
      const factory = new PdfiumDocumentFactory(pdfiumModule);
      this.lowLevelHandle = factory.loadFromBuffer(this.pdfData);
      this.textExtractor = this.lowLevelHandle.extractor;
      // this.imageExtractor = new PdfiumImageExtractor(pdfiumModule);
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
    this.bookmarks = [];
    if (!this.pdfDoc || !this.native) return;

    try {
      const bookmarks = await this.native.getBookmarks(this.pdfDoc).toPromise();
      this.bookmarks = bookmarks.bookmarks || [];
      this.allNamedDests = collectNamedDestinations(this.bookmarks);
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

  getPage(pageNumber: number): PdfPageObject | null {
    if (!this.pdfDoc?.pages) return null;
    return this.pdfDoc.pages[pageNumber - 1] || null;
  }

  getPageDimensions(pageNumber: number): { width: number; height: number } | null {
    return this.pageDimensions[pageNumber - 1] || null;
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  async getDocumentTitle(): Promise<string | null> {
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

  async getMetadata(): Promise<PdfMetadataObject> {
    return await this.native.getMetadata(this.pdfDoc).toPromise();
  }

  resolveDestination(destName: string): NamedDestination | null {
    return this.allNamedDests.get(destName) || null;
  }

  extractPageText(pageIndex: number) {
    if (!this.lowLevelHandle) return null;
    return this.lowLevelHandle.extractPageText(pageIndex);
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
      return await this.engine.saveAsCopy(this.pdfDoc).toPromise();
    } catch (error) {
      console.error("Error saving document:", error);
      throw error;
    }
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
  //   const docPtr = this.lowLevelHandle.docPtr;
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
    if (this.lowLevelHandle) {
      this.lowLevelHandle.close();
      this.lowLevelHandle = null;
      this.textExtractor = null;
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
