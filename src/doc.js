import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

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

  async load(url) {
    this.pdfDoc = await pdfjsLib.getDocument(url).promise;
    this.allNamedDests = await this.pdfDoc.getDestinations();
    await this.#cachePageDimensions();
    return this.pdfDoc;
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

  /**
   * Generate a unique annotation ID
   */
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

  notify(event, data) {
    for (const subscriber of this.subscribers) {
      subscriber.onDocumentChange?.(event, data);
    }
  }
}
