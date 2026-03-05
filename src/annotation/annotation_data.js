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

function colorNameToHex(colorName) {
  return COLOR_NAME_TO_HEX[colorName] || COLOR_NAME_TO_HEX.yellow;
}

function hexToColorName(hex) {
  if (!hex) return "yellow";
  const normalized = hex.toUpperCase();
  if (HEX_TO_COLOR_NAME[normalized]) return HEX_TO_COLOR_NAME[normalized];

  const rgb = hexToRgb(hex);
  if (!rgb) return "yellow";

  let closest = "yellow";
  let minDist = Infinity;
  for (const [name, val] of Object.entries(COLOR_NAME_TO_HEX)) {
    const t = hexToRgb(val);
    if (!t) continue;
    const d = Math.sqrt(
      (rgb.r - t.r) ** 2 + (rgb.g - t.g) ** 2 + (rgb.b - t.b) ** 2,
    );
    if (d < minDist) {
      minDist = d;
      closest = name;
    }
  }
  return closest;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : null;
}

const PdfAnnotationSubtype = {
  HIGHLIGHT: 9,
  UNDERLINE: 10,
  SQUIGGLY: 11,
  STRIKEOUT: 12,
  TEXT: 1,
};

export class AnnotationStore {
  #doc = null;
  #annotationIdToPdfId = new Map();
  #linkedComments = new Map();

  /** @type {Map<string, Object>} */
  annotations = new Map();

  /** @type {Map<number, Set<string>>} */
  annotationsByPage = new Map();

  /** @type {Map<number, Array>} */
  nativeAnnotationsByPage = new Map();

  constructor(doc) {
    this.#doc = doc;
  }

  get #engine() {
    return this.#doc.engine;
  }

  get #pdfDoc() {
    return this.#doc.pdfDoc;
  }

  // ============================================
  // Loading
  // ============================================

  async loadFromDocument() {
    if (!this.#pdfDoc || !this.#engine) return;

    this.annotations.clear();
    this.annotationsByPage.clear();
    this.#annotationIdToPdfId.clear();
    this.#linkedComments.clear();
    this.nativeAnnotationsByPage.clear();

    const textAnnotations = [];

    for (let pageNum = 1; pageNum <= this.#doc.numPages; pageNum++) {
      const page = this.#doc.getPage(pageNum);
      if (!page) continue;

      try {
        const annotations = await this.#engine
          .getPageAnnotations(this.#pdfDoc, page)
          .toPromise();

        const { width: pageWidth, height: pageHeight } = page.size;
        this.#normalizeAnnotationRects(annotations, pageNum - 1, pageHeight);
        this.nativeAnnotationsByPage.set(pageNum, annotations);

        for (const annot of annotations) {
          if (
            annot.type === PdfAnnotationSubtype.HIGHLIGHT ||
            annot.type === PdfAnnotationSubtype.UNDERLINE
          ) {
            const converted = this.#convertPdfAnnotation(
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
          } else if (annot.type === PdfAnnotationSubtype.TEXT) {
            textAnnotations.push({
              pdfAnnot: annot,
              pageNum,
              pageWidth,
              pageHeight,
            });
          }
        }
      } catch (error) {
        console.warn(`[AnnotationStore] Error loading page ${pageNum}:`, error);
      }
    }

    this.#linkTextAnnotationsToMarkup(textAnnotations);

    if (this.annotations.size > 0) {
      this.#doc.notify("annotations-imported", {
        count: this.annotations.size,
      });
    }
  }

  // ============================================
  // CRUD
  // ============================================

  async addAnnotation(annotationData) {
    const id = crypto.randomUUID();
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
    for (const pr of annotation.pageRanges) {
      this.#addToPageIndex(id, pr.pageNumber);
    }
    await this.#createInEngine(annotation);

    this.#doc.notify("annotation-added", { annotation });
    return annotation;
  }

  async updateAnnotation(id, updates) {
    const annotation = this.annotations.get(id);
    if (!annotation) return null;

    const oldComment = annotation.comment;
    const oldType = annotation.type;
    if (updates.color !== undefined) annotation.color = updates.color;
    if (updates.type !== undefined) annotation.type = updates.type;
    if (updates.comment !== undefined) annotation.comment = updates.comment;
    annotation.updatedAt = new Date().toISOString();

    const typeChanged = oldType !== annotation.type;
    await this.#updateInEngine(annotation, oldComment, typeChanged);
    this.#doc.notify("annotation-updated", { annotation });
    return annotation;
  }

  async deleteAnnotation(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    await this.#deleteFromEngine(annotation);

    for (const pr of annotation.pageRanges) {
      this.#removeFromPageIndex(id, pr.pageNumber);
    }
    this.annotations.delete(id);
    this.#annotationIdToPdfId.delete(id);

    this.#doc.notify("annotation-deleted", { annotationId: id });
    return true;
  }

  async deleteAnnotationComment(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    annotation.comment = null;
    annotation.updatedAt = new Date().toISOString();

    await this.#removeCommentAnnotation(id);
    await this.#updateInEngine(annotation, annotation.comment);

    this.#doc.notify("annotation-updated", { annotation });
    return true;
  }

  // ============================================
  // Accessors
  // ============================================

  getAnnotation(id) {
    return this.annotations.get(id) || null;
  }

  getAnnotationsForPage(pageNumber) {
    const ids = this.annotationsByPage.get(pageNumber);
    if (!ids) return [];
    return Array.from(ids)
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

  clear() {
    this.annotations.clear();
    this.annotationsByPage.clear();
    this.nativeAnnotationsByPage.clear();
    this.#annotationIdToPdfId.clear();
    this.#linkedComments.clear();
  }

  // ============================================
  // Page Index
  // ============================================

  #addToPageIndex(annotationId, pageNumber) {
    if (!this.annotationsByPage.has(pageNumber)) {
      this.annotationsByPage.set(pageNumber, new Set());
    }
    this.annotationsByPage.get(pageNumber).add(annotationId);
  }

  #removeFromPageIndex(annotationId, pageNumber) {
    this.annotationsByPage.get(pageNumber)?.delete(annotationId);
  }

  // ============================================
  // PDF Annotation Conversion
  // ============================================

  #convertPdfAnnotation(annot, pageNum, pageWidth, pageHeight) {
    const rects = [];

    if (annot.segmentRects?.length > 0) {
      for (const seg of annot.segmentRects) {
        rects.push({
          leftRatio: (seg.origin?.x ?? 0) / pageWidth,
          topRatio: (seg.origin?.y ?? 0) / pageHeight,
          widthRatio: (seg.size?.width ?? 0) / pageWidth,
          heightRatio: (seg.size?.height ?? 0) / pageHeight,
        });
      }
    } else if (annot.rect) {
      rects.push({
        leftRatio: (annot.rect.origin?.x ?? 0) / pageWidth,
        topRatio: (annot.rect.origin?.y ?? 0) / pageHeight,
        widthRatio: (annot.rect.size?.width ?? 0) / pageWidth,
        heightRatio: (annot.rect.size?.height ?? 0) / pageHeight,
      });
    }

    if (rects.length === 0) return null;

    // Determine type: prefer engine type, fall back to custom field
    let annotationType;
    if (annot.type === PdfAnnotationSubtype.UNDERLINE) {
      annotationType = "underline";
    } else if (
      annot.custom?.annotationType === "underline" ||
      annot.custom?.annotationType === "highlight"
    ) {
      annotationType = annot.custom.annotationType;
    } else {
      annotationType = "highlight";
    }

    return {
      id: annot.id || crypto.randomUUID(),
      type: annotationType,
      color: hexToColorName(annot.color),
      pageRanges: [{ pageNumber: pageNum, rects, text: "" }],
      comment: annot.contents?.trim() || null,
      createdAt: annot.created?.toISOString() || new Date().toISOString(),
      updatedAt: annot.modified?.toISOString() || new Date().toISOString(),
    };
  }

  // ============================================
  // Comment Linking
  // ============================================

  #linkTextAnnotationsToMarkup(textAnnotations) {
    for (const { pdfAnnot, pageNum } of textAnnotations) {
      const linkedId = pdfAnnot.custom?.linkedAnnotationId;
      const storedType = pdfAnnot.custom?.annotationType;

      if (linkedId && this.annotations.has(linkedId)) {
        const markup = this.annotations.get(linkedId);
        if (markup && pdfAnnot.contents) {
          markup.comment = pdfAnnot.contents.trim();
          if (
            storedType &&
            (storedType === "highlight" || storedType === "underline")
          ) {
            markup.type = storedType;
          }
          this.#linkedComments.set(linkedId, pdfAnnot.id);
        }
      } else if (pdfAnnot.contents) {
        const nearby = this.#findNearbyMarkup(pdfAnnot, pageNum);
        if (nearby) {
          nearby.comment = pdfAnnot.contents.trim();
          if (
            storedType &&
            (storedType === "highlight" || storedType === "underline")
          ) {
            nearby.type = storedType;
          }
          this.#linkedComments.set(nearby.id, pdfAnnot.id);
        }
      }
    }
  }

  #findNearbyMarkup(textAnnot, pageNum) {
    const textX = textAnnot.rect?.origin?.x ?? 0;
    const textY = textAnnot.rect?.origin?.y ?? 0;
    const pageDims = this.#doc.getPageDimensions(pageNum);
    if (!pageDims) return null;

    const threshold = Math.max(pageDims.width, pageDims.height) * 0.1;
    let closest = null;
    let closestDist = Infinity;

    for (const annotation of this.annotations.values()) {
      if (annotation.comment) continue;
      const pr = annotation.pageRanges.find((p) => p.pageNumber === pageNum);
      if (!pr || pr.rects.length === 0) continue;

      const rect = pr.rects[0];
      const markupX = rect.leftRatio * pageDims.width;
      const markupY = (1 - rect.topRatio) * pageDims.height;
      const dist = Math.hypot(textX - markupX, textY - markupY);

      if (dist < threshold && dist < closestDist) {
        closestDist = dist;
        closest = annotation;
      }
    }

    return closest;
  }

  // ============================================
  // Engine Operations
  // ============================================

  async #createInEngine(annotation) {
    if (!this.#pdfDoc || !this.#engine) return;

    for (const pr of annotation.pageRanges) {
      const page = this.#doc.getPage(pr.pageNumber);
      if (!page) continue;

      const { width: pw, height: ph } = page.size;
      const segmentRects = pr.rects.map((r) =>
        this.#toEngineRect(r, pw, ph),
      );
      const boundingRect = this.#boundingRect(segmentRects);

      const pdfAnnotation = {
        id: annotation.id,
        type:
          annotation.type === "underline"
            ? PdfAnnotationSubtype.UNDERLINE
            : PdfAnnotationSubtype.HIGHLIGHT,
        pageIndex: pr.pageNumber - 1,
        rect: boundingRect,
        segmentRects,
        color: colorNameToHex(annotation.color),
        opacity: annotation.type === "highlight" ? 0.5 : 1.0,
        contents: annotation.comment || undefined,
        custom: {
          colorName: annotation.color,
          annotationType: annotation.type,
          text: pr.text || "",
        },
      };

      try {
        const resultId = await this.#engine
          .createPageAnnotation(this.#pdfDoc, page, pdfAnnotation)
          .toPromise();

        this.#annotationIdToPdfId.set(
          annotation.id,
          resultId && resultId !== annotation.id ? resultId : annotation.id,
        );
      } catch (error) {
        console.warn("[AnnotationStore] Error creating in engine:", error);
      }
    }

    if (annotation.comment) {
      await this.#createCommentAnnotation(annotation);
    }
  }

  async #createCommentAnnotation(annotation) {
    if (!this.#pdfDoc || !this.#engine || !annotation.comment) return;

    const firstPr = annotation.pageRanges[0];
    if (!firstPr || firstPr.rects.length === 0) return;

    const page = this.#doc.getPage(firstPr.pageNumber);
    if (!page) return;

    const { width: pw, height: ph } = page.size;
    const firstRect = firstPr.rects[0];
    const highlightRight =
      (firstRect.leftRatio + firstRect.widthRatio) * pw;
    const highlightTop = firstRect.topRatio * ph;
    const noteSize = 20;
    const noteX = Math.min(highlightRight + 5, pw - noteSize - 5);
    const noteY = highlightTop - noteSize / 2;

    const commentId = crypto.randomUUID();
    const commentAnnotation = {
      id: commentId,
      type: PdfAnnotationSubtype.TEXT,
      pageIndex: firstPr.pageNumber - 1,
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
        annotationType: annotation.type,
      },
    };

    try {
      const resultId = await this.#engine
        .createPageAnnotation(this.#pdfDoc, page, commentAnnotation)
        .toPromise();
      this.#linkedComments.set(annotation.id, resultId || commentId);
    } catch (error) {
      console.warn("[AnnotationStore] Error creating comment:", error);
    }
  }

  async #updateInEngine(annotation, oldComment, typeChanged = false) {
    if (!this.#pdfDoc || !this.#engine) return;
    if (typeChanged) {
      await this.#deleteFromEngine(annotation);
      await this.#createInEngine(annotation);
      return;
    }

    const pdfId = this.#annotationIdToPdfId.get(annotation.id);

    for (const pr of annotation.pageRanges) {
      const page = this.#doc.getPage(pr.pageNumber);
      if (!page) continue;

      const { width: pw, height: ph } = page.size;
      const segmentRects = pr.rects.map((r) =>
        this.#toEngineRect(r, pw, ph),
      );
      const boundingRect = this.#boundingRect(segmentRects);

      const pdfAnnotation = {
        id: pdfId || annotation.id,
        type:
          annotation.type === "underline"
            ? PdfAnnotationSubtype.UNDERLINE
            : PdfAnnotationSubtype.HIGHLIGHT,
        pageIndex: pr.pageNumber - 1,
        rect: boundingRect,
        segmentRects,
        color: colorNameToHex(annotation.color),
        opacity: annotation.type === "highlight" ? 0.5 : 1.0,
        contents: annotation.comment || undefined,
        custom: {
          colorName: annotation.color,
          annotationType: annotation.type,
          text: pr.text || "",
        },
      };

      try {
        await this.#engine
          .updatePageAnnotation(this.#pdfDoc, page, pdfAnnotation)
          .toPromise();
      } catch (error) {
        console.warn("[AnnotationStore] Error updating in engine:", error);
      }
    }

    await this.#syncCommentAnnotation(annotation, oldComment);
  }

  async #syncCommentAnnotation(annotation, oldComment) {
    const existingId = this.#linkedComments.get(annotation.id);

    if (annotation.comment && !existingId) {
      await this.#createCommentAnnotation(annotation);
    } else if (!annotation.comment && existingId) {
      await this.#removeCommentAnnotation(annotation.id);
    } else if (annotation.comment && existingId) {
      const firstPr = annotation.pageRanges[0];
      if (!firstPr) return;

      const page = this.#doc.getPage(firstPr.pageNumber);
      if (!page) return;

      try {
        const annotations = await this.#engine
          .getPageAnnotations(this.#pdfDoc, page)
          .toPromise();

        const existing = annotations.find((a) => a.id === existingId);
        if (existing) {
          await this.#engine
            .updatePageAnnotation(this.#pdfDoc, page, {
              ...existing,
              contents: annotation.comment,
              color: colorNameToHex(annotation.color),
              custom: {
                ...(existing.custom || {}),
                linkedAnnotationId: annotation.id,
                annotationType: annotation.type,
              },
            })
            .toPromise();
        }
      } catch (error) {
        console.warn("[AnnotationStore] Error updating comment:", error);
      }
    }
  }

  async #removeCommentAnnotation(annotationId) {
    const commentId = this.#linkedComments.get(annotationId);
    if (!commentId) return;

    const annotation = this.annotations.get(annotationId);
    if (!annotation) return;

    const firstPr = annotation.pageRanges[0];
    if (!firstPr) return;

    const page = this.#doc.getPage(firstPr.pageNumber);
    if (!page) return;

    try {
      await this.#engine
        .removePageAnnotation(this.#pdfDoc, page, { id: commentId })
        .toPromise();
      this.#linkedComments.delete(annotationId);
    } catch (error) {
      console.warn("[AnnotationStore] Error removing comment:", error);
    }
  }

  async #deleteFromEngine(annotation) {
    if (!this.#pdfDoc || !this.#engine) return;

    const pdfId = this.#annotationIdToPdfId.get(annotation.id);

    for (const pr of annotation.pageRanges) {
      const page = this.#doc.getPage(pr.pageNumber);
      if (!page) continue;

      try {
        await this.#engine
          .removePageAnnotation(this.#pdfDoc, page, {
            id: pdfId || annotation.id,
          })
          .toPromise();
      } catch (error) {
        console.warn("[AnnotationStore] Error deleting from engine:", error);
      }
    }

    await this.#removeCommentAnnotation(annotation.id);
  }

  // ============================================
  // Annotation Rect Normalization
  // ============================================

  /**
   * Normalize engine annotation rects using raw Pdfium data.
   * @param {Array} annotations - Engine annotation objects (mutated in place)
   * @param {number} pageIndex - 0-based page index
   * @param {number} pageHeight - Page height in PDF units
   */
  #normalizeAnnotationRects(annotations, pageIndex, pageHeight) {
    if (!annotations || annotations.length === 0) return;

    const handle = this.#doc.lowLevelHandle;
    if (!handle) return;

    const pdfium = handle.pdfium;
    const docPtr = handle.docPtr;

    const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
    if (!pagePtr) return;

    try {
      const rawAnnotCount = pdfium.FPDFPage_GetAnnotCount(pagePtr);
      if (rawAnnotCount === 0) return;

      const rectPtr = pdfium.pdfium.wasmExports.malloc(16);
      let needsCorrection = false;

      try {
        const samplesToCheck = Math.min(rawAnnotCount, 5);
        for (let i = 0; i < samplesToCheck; i++) {
          const annotPtr = pdfium.FPDFPage_GetAnnot(pagePtr, i);
          if (!annotPtr) continue;

          const success = pdfium.FPDFAnnot_GetRect(annotPtr, rectPtr);
          pdfium.FPDFPage_CloseAnnot(annotPtr);

          if (!success) continue;

          const bottom = pdfium.pdfium.HEAPF32[(rectPtr + 4) >> 2];
          const top    = pdfium.pdfium.HEAPF32[(rectPtr + 12) >> 2];

          if (top > bottom) {
            needsCorrection = true;
            break;
          }
        }
      } finally {
        pdfium.pdfium.wasmExports.free(rectPtr);
      }

      if (!needsCorrection) return;

      for (const annot of annotations) {
        if (!annot.target) continue;

        if (annot.rect?.origin && annot.rect?.size) {
          annot.rect.origin.y -= annot.rect.size.height;
        }
      }
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  // ============================================
  // Coordinate Conversion
  // ============================================

  #toEngineRect(uiRect, pageWidth, pageHeight) {
    return {
      origin: {
        x: uiRect.leftRatio * pageWidth,
        y: uiRect.topRatio * pageHeight,
      },
      size: {
        width: uiRect.widthRatio * pageWidth,
        height: uiRect.heightRatio * pageHeight,
      },
    };
  }

  #boundingRect(rects) {
    if (rects.length === 0) {
      return { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
    }

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const r of rects) {
      minX = Math.min(minX, r.origin.x);
      minY = Math.min(minY, r.origin.y);
      maxX = Math.max(maxX, r.origin.x + r.size.width);
      maxY = Math.max(maxY, r.origin.y + r.size.height);
    }

    return {
      origin: { x: minX, y: minY },
      size: { width: maxX - minX, height: maxY - minY },
    };
  }
}
