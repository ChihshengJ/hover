import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// PDF.js AnnotationEditorType constants (from pdf.js source)
// NOTE: There is NO UNDERLINE type in AnnotationEditorType!
const AnnotationEditorType = {
  DISABLE: -1,
  NONE: 0,
  FREETEXT: 3,
  HIGHLIGHT: 9,
  STAMP: 13,
  INK: 15,
};

// CRITICAL: Keys MUST start with this prefix for SaveDocument to process them
const AnnotationEditorPrefix = "pdfjs_internal_editor_";

// Color name to RGB (0-255 range) mapping for PDF.js annotationStorage
const COLOR_TO_RGB = {
  yellow: [255, 179, 0],
  red: [229, 57, 53],
  blue: [30, 136, 229],
  green: [67, 160, 71],
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

    // Expose for console debugging
    window.__pdfDocModel = this;
  }

  debugAnnotationStorage() {
    const storage = this.pdfDoc?.annotationStorage;
    if (!storage) {
      console.log("No annotationStorage available");
      return;
    }

    console.log("=== AnnotationStorage Debug ===");
    console.log("Size:", storage.size);
    console.log(
      "Has Symbol.iterator:",
      typeof storage[Symbol.iterator] === "function",
    );

    console.log("\n--- Raw storage contents ---");
    for (const [key, value] of storage) {
      console.log("Key:", key);
      console.log(
        "  startsWith prefix:",
        key.startsWith("pdfjs_internal_editor_"),
      );
      console.log("  pageIndex:", value?.pageIndex);
      console.log("  annotationType:", value?.annotationType);
      console.log("  quadPoints:", value?.quadPoints?.slice(0, 8), "...");
      console.log("  rect:", value?.rect);
      console.log("  color:", value?.color);
      console.log("  outlines count:", value?.outlines?.length);
      if (value?.outlines?.[0]) {
        console.log("  first outline:", value.outlines[0]);
      }
    }

    console.log("\n--- Serializable check ---");
    const serializable = storage.serializable;
    console.log("serializable:", serializable);
    console.log(
      "serializable === SerializableEmpty:",
      serializable?.map?.size === 0,
    );

    if (serializable?.map) {
      console.log("Serializable map contents:");
      for (const [key, value] of serializable.map) {
        console.log("  Key:", key, "pageIndex:", value?.pageIndex);
      }
    }

    return { storage, serializable };
  }

  /**
   * Debug helper - test coordinate conversion
   * Call from console: __pdfDocModel.testCoordinates(1)
   */
  async testCoordinates(pageNumber = 1) {
    const pageInfo = await this.#getPageInfo(pageNumber);
    console.log("=== Page Coordinate Info ===");
    console.log("Page:", pageNumber);
    console.log("pageWidth:", pageInfo.pageWidth);
    console.log("pageHeight:", pageInfo.pageHeight);

    // Test a sample rect
    const testRect = {
      leftRatio: 0.1,
      topRatio: 0.1,
      widthRatio: 0.2,
      heightRatio: 0.05,
    };
    const quadPoints = this.#rectToQuadPoints(testRect, pageInfo);
    const outline = this.#rectToOutline(testRect, pageInfo);

    console.log(
      "\nTest rect (10% from left, 10% from top, 20% wide, 5% tall):",
    );
    console.log("QuadPoints:", quadPoints);
    console.log("Outline:", outline);

    // Expected values (now without pageX/pageY offsets)
    const expectedX1 = testRect.leftRatio * pageInfo.pageWidth;
    const expectedX2 =
      (testRect.leftRatio + testRect.widthRatio) * pageInfo.pageWidth;
    const expectedY1 = (1 - testRect.topRatio) * pageInfo.pageHeight;
    const expectedY2 =
      (1 - testRect.topRatio - testRect.heightRatio) * pageInfo.pageHeight;

    console.log("\nExpected PDF coords:");
    console.log(
      "  X range:",
      expectedX1.toFixed(2),
      "to",
      expectedX2.toFixed(2),
    );
    console.log(
      "  Y range:",
      expectedY2.toFixed(2),
      "(bottom) to",
      expectedY1.toFixed(2),
      "(top)",
    );

    return { pageInfo, quadPoints, outline };
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
   * Convert one of our annotations to PDF.js serialized format for a specific page
   * @param {Object} annotation - Our internal annotation
   * @param {Object} pageRange - The pageRange object for this page
   * @returns {Promise<Object>} PDF.js serialized annotation format
   */
  async #annotationToPdfFormat(annotation, pageRange) {
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

    // NOTE: AnnotationEditorType only has HIGHLIGHT (9), not UNDERLINE
    // For underscore, we still use HIGHLIGHT but could customize appearance
    const annotationType = AnnotationEditorType.HIGHLIGHT;

    // Format matching HighlightEditor.serialize() output exactly
    // Based on PDF.js source code analysis
    const serialized = {
      annotationType,
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

    return serialized;
  }

  /**
   * Save PDF with annotations embedded
   * Uses PDF.js native annotation serialization pipeline
   * @returns {Promise<Uint8Array>} PDF data with annotations
   */
  async saveWithAnnotations() {
    if (!this.pdfDoc) {
      throw new Error("No PDF document loaded");
    }

    const allAnnotations = this.getAllAnnotations();

    if (allAnnotations.length === 0) {
      console.log("No annotations to save, returning original PDF");
      return await this.pdfDoc.getData();
    }

    // Access the annotation storage from PDF.js
    const annotationStorage = this.pdfDoc.annotationStorage;

    if (!annotationStorage) {
      console.warn(
        "annotationStorage not available, falling back to original PDF",
      );
      return await this.pdfDoc.getData();
    }

    // Debug: Check initial state
    console.log("=== Initial annotationStorage state ===");
    console.log("annotationStorage type:", annotationStorage.constructor.name);
    console.log("Initial size:", annotationStorage.size);
    console.log(
      "Available methods:",
      Object.getOwnPropertyNames(Object.getPrototypeOf(annotationStorage)),
    );

    // Convert our annotations to PDF.js format and add to storage
    // CRITICAL: Use simple incrementing index for keys
    let editorIndex = 0;

    for (const annotation of allAnnotations) {
      console.log("\n--- Processing annotation ---");
      console.log("ID:", annotation.id);
      console.log("Type:", annotation.type);
      console.log("Color:", annotation.color);
      console.log("Page ranges:", annotation.pageRanges.length);

      for (const pageRange of annotation.pageRanges) {
        const serialized = await this.#annotationToPdfFormat(
          annotation,
          pageRange,
        );

        // CRITICAL: Key MUST be pdfjs_internal_editor_N where N is an integer
        const key = `${AnnotationEditorPrefix}${editorIndex++}`;

        console.log("\nStoring annotation with key:", key);
        console.log("pageIndex:", serialized.pageIndex);
        console.log("annotationType:", serialized.annotationType);
        console.log("rect:", serialized.rect);
        console.log("quadPoints length:", serialized.quadPoints?.length);
        console.log("outlines count:", serialized.outlines?.length);
        console.log("color:", serialized.color);

        // Store in annotation storage
        annotationStorage.setValue(key, serialized);

        // Verify it was stored
        const stored = annotationStorage.getRawValue(key);
        console.log("Verification - stored value exists:", !!stored);
        console.log("Verification - stored pageIndex:", stored?.pageIndex);
      }
    }

    // Debug: Check storage contents after adding
    console.log("\n=== Storage after adding annotations ===");
    console.log("Storage size:", annotationStorage.size);

    // Iterate and log all entries
    console.log("\nAll storage entries:");
    for (const [k, v] of annotationStorage) {
      console.log(`  ${k}:`, {
        pageIndex: v?.pageIndex,
        annotationType: v?.annotationType,
        hasQuadPoints: !!v?.quadPoints,
        hasOutlines: !!v?.outlines,
      });
    }

    // CRITICAL DEBUG: Check what serializable returns
    console.log("\n=== Checking serializable getter ===");
    const serializable = annotationStorage.serializable;
    console.log("serializable type:", typeof serializable);
    console.log("serializable:", serializable);

    if (serializable) {
      console.log("serializable.map:", serializable.map);
      console.log("serializable.hash:", serializable.hash);
      console.log("serializable.transfer:", serializable.transfer);

      if (serializable.map === null) {
        console.error(
          "!!! CRITICAL: serializable.map is NULL - this means PDF.js thinks there's nothing to save !!!",
        );
        console.log("This is likely the root cause of the save issue.");
        console.log(
          "The storage has entries, but serializable is returning empty.",
        );
      } else if (serializable.map) {
        console.log("serializable.map size:", serializable.map.size);
        console.log("serializable.map entries:");
        for (const [k, v] of serializable.map) {
          console.log(`  ${k}:`, {
            pageIndex: v?.pageIndex,
            annotationType: v?.annotationType,
          });
        }
      }
    }

    // Check modifiedIds
    console.log("\n=== Checking modifiedIds ===");
    const modifiedIds = annotationStorage.modifiedIds;
    console.log("modifiedIds:", modifiedIds);
    console.log("modifiedIds.ids:", modifiedIds?.ids);
    console.log("modifiedIds.hash:", modifiedIds?.hash);

    try {
      console.log("\n=== Calling pdfDoc.saveDocument() ===");
      const data = await this.pdfDoc.saveDocument();
      console.log("saveDocument() completed");
      console.log("Returned data type:", data?.constructor?.name);
      console.log("Returned data size:", data?.byteLength, "bytes");

      // Compare to original size
      const originalData = await this.pdfDoc.getData();
      console.log("Original PDF size:", originalData?.byteLength, "bytes");
      console.log(
        "Size difference:",
        (data?.byteLength || 0) - (originalData?.byteLength || 0),
        "bytes",
      );

      if (data?.byteLength === originalData?.byteLength) {
        console.warn(
          "WARNING: Output size equals input size - annotations may not have been embedded!",
        );
      }

      return data;
    } catch (error) {
      console.error("Error saving document with annotations:", error);
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
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
