/**
 * The annotation store: the app's own annotation model, and the two-way
 * translation between it and the PDF's.
 *
 * The two vocabularies differ on purpose. The app stores geometry as
 * page-relative ratios so an annotation survives a zoom or a re-render, and
 * names its colours; the PDF wants page points and hex. Everything below the
 * "PDF translation" divider is that translation, read through
 * `pdf/annotation_reader.ts` and written through `pdf/annotation_writer.ts`.
 *
 * In the file, an annotation is one PDF annotation per page it covers, each
 * with the app's id as its `/NM`. Its comment is the first one's `/Contents`.
 *
 * Edits never touch the open document. The store remembers what the file held
 * when it was loaded and which annotations changed since, and each save writes
 * that net change into a fresh copy of the file (`writeChanges`). Writing an
 * edit through to the open document instead would leave garbage in the saved
 * file: PDFium writes every object created since load, even one a later edit
 * removed, so a deleted comment's text and every replaced appearance stream
 * would still be in the bytes (docs/plan_upstream_pdfium.md, phase 0 item 5).
 */

import { DocEvent } from "./doc_events.js";
import { readPageAnnotations } from "../pdf/annotation_reader.js";
import {
  createAnnotation,
  removeAnnotation,
  updateAnnotation,
} from "../pdf/annotation_writer.js";
import type {
  MarkupWrite,
  UnnamedLocator,
} from "../pdf/annotation_writer.js";
import type { PdfiumDocument } from "../pdf/document.js";
import type { PDFDocumentModel } from "./doc.js";

/** One colour from the palette the UI offers. */
export type AnnotationColorName = "black" | "yellow" | "red" | "blue" | "green";

export type AnnotationType = "highlight" | "underline" | "drawing";

/**
 * A rect as a fraction of its page, origin top-left. Ratios rather than points
 * so the same annotation renders correctly at any zoom.
 */
export interface RatioRect {
  leftRatio: number;
  topRatio: number;
  widthRatio: number;
  heightRatio: number;
}

/** The part of an annotation that lives on one page. */
export interface AnnotationPageRange {
  /** 1-based. */
  pageNumber: number;
  rects: RatioRect[];
  /** The selected text, for markup annotations. */
  text: string;
}

/** One pen stroke of a drawing annotation, in page ratios. */
export interface DrawingStroke {
  points: Array<{ x: number; y: number }>;
  /** Width as a fraction of the page width. */
  strokeWidth?: number;
}

/** An annotation as the app stores it. */
export interface Annotation {
  id: string;
  type: AnnotationType;
  color: AnnotationColorName;
  pageRanges: AnnotationPageRange[];
  /** Drawings only. */
  strokes?: DrawingStroke[] | null;
  /** Drawings only; degrees. */
  rotation?: number;
  comment: string | null;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

/** What a caller supplies to create one; the store mints the rest. */
export interface AnnotationInput {
  type: AnnotationType;
  color: AnnotationColorName;
  pageRanges: AnnotationPageRange[];
  strokes?: DrawingStroke[] | null;
  rotation?: number;
  comment?: string | null;
}

const COLOR_NAME_TO_HEX: Record<AnnotationColorName, string> = {
  black: "#000000",
  yellow: "#FFB300",
  red: "#E53935",
  blue: "#1E88E5",
  green: "#43A047",
};

const HEX_TO_COLOR_NAME: Record<string, AnnotationColorName> = {
  "#000000": "black",
  "#FFB300": "yellow",
  "#E53935": "red",
  "#1E88E5": "blue",
  "#43A047": "green",
};

function colorNameToHex(colorName: AnnotationColorName): string {
  return COLOR_NAME_TO_HEX[colorName] || COLOR_NAME_TO_HEX.yellow;
}

function hexToColorName(hex: string | null | undefined): AnnotationColorName {
  if (!hex) return "yellow";
  const normalized = hex.toUpperCase();
  if (HEX_TO_COLOR_NAME[normalized]) return HEX_TO_COLOR_NAME[normalized];

  const rgb = hexToRgb(hex);
  if (!rgb) return "yellow";

  let closest: AnnotationColorName = "yellow";
  let minDist = Infinity;
  const entries = Object.entries(COLOR_NAME_TO_HEX) as Array<
    [AnnotationColorName, string]
  >;
  for (const [name, val] of entries) {
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

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : null;
}

/** Whether two page-number lists cover the same pages, in the same order. */
function samePages(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((page, i) => page === b[i]);
}

/** A page-ratio rect as a box in page points. */
function toBox(rect: RatioRect, width: number, height: number): PdfBox {
  return {
    origin: { x: rect.leftRatio * width, y: rect.topRatio * height },
    size: { width: rect.widthRatio * width, height: rect.heightRatio * height },
  };
}

/**
 * Turn `points` by `degrees` around the centre of their bounding box,
 * clockwise in top-left space: what the viewer's `rotate()` shows. The file
 * gets the turned points, so other viewers show the drawing as Hover does.
 */
function rotatePoints(points: Point[][], degrees: number): Point[][] {
  if (!degrees) return points;
  const all = points.flat();
  if (all.length === 0) return points;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map((stroke) =>
    stroke.map((p) => ({
      x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
      y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
    })),
  );
}

/** Where an annotation that came without `/NM` is in the file as loaded. */
interface Unnamed {
  /** 0-based. */
  pageIndex: number;
  locator: UnnamedLocator;
}

/** A sticky note in the file as loaded that a markup's comment came from. */
interface LinkedNote {
  /** 0-based. */
  pageIndex: number;
  name: string | null;
  rect: PdfBox;
}

/** What the file as loaded holds for one annotation. */
interface Loaded {
  type: AnnotationType;
  /** 1-based, in `pageRanges` order. */
  pages: number[];
}

export class AnnotationStore {
  #doc: PDFDocumentModel;

  // Everything below up to `annotations` describes the file as loaded, which
  // every save starts from, so none of it changes until the next load.

  /** App id → the annotation's type and pages in the file as loaded. */
  #loaded = new Map<string, Loaded>();

  /**
   * App id → where to find the annotation in the file as loaded, for one that
   * has no `/NM` there. The first save that writes it gives it one, but the
   * next save starts from the file as loaded again.
   */
  #unnamed = new Map<string, Unnamed>();

  /**
   * App id → the sticky note its comment was loaded from: one Hover wrote
   * before comments moved into `/Contents`, or a note found next to it. Moved
   * to `#droppedNotes` when the comment changes, since the comment then lives
   * in the markup's own `/Contents`.
   */
  #linkedNotes = new Map<string, LinkedNote>();

  // The change since load, which each save writes.

  /** Annotations created or edited since load, in the order first touched. */
  #dirty = new Set<string>();

  /** Loaded annotations the user deleted. */
  #deleted = new Set<string>();

  /** Loaded sticky notes whose comment moved into the markup or went away. */
  #droppedNotes: LinkedNote[] = [];

  annotations = new Map<string, Annotation>();

  annotationsByPage = new Map<number, Set<string>>();

  /** Each page's links, for the analysis pipeline. */
  nativeAnnotationsByPage = new Map<number, NativeLink[]>();

  constructor(doc: PDFDocumentModel) {
    this.#doc = doc;
  }

  // ============================================
  // Loading
  // ============================================

  async loadFromDocument() {
    const document = this.#doc.document;
    if (!document) return;

    this.clear();
    const notes: Array<{ note: NativeMarkup; pageNum: number }> = [];

    for (let pageNum = 1; pageNum <= this.#doc.numPages; pageNum++) {
      const page = this.#doc.getPage(pageNum);
      if (!page) continue;

      try {
        const { links, markup } = readPageAnnotations(document, pageNum - 1);
        this.nativeAnnotationsByPage.set(pageNum, links);

        const { width: pageWidth, height: pageHeight } = page.size;
        for (const annot of markup) {
          if (annot.subtype === "text") {
            notes.push({ note: annot, pageNum });
            continue;
          }
          const converted =
            annot.subtype === "ink"
              ? this.#convertInk(annot, pageNum, pageWidth, pageHeight)
              : this.#convertMarkup(annot, pageNum, pageWidth, pageHeight);
          if (converted) this.#addLoaded(converted, annot, pageNum);
        }
      } catch (error) {
        console.warn(`[AnnotationStore] Error loading page ${pageNum}:`, error);
      }
    }

    this.#linkNotesToMarkup(notes);
    for (const annotation of this.annotations.values()) {
      this.#loaded.set(annotation.id, {
        type: annotation.type,
        pages: annotation.pageRanges.map((pr) => pr.pageNumber),
      });
    }

    if (this.annotations.size > 0) {
      this.#doc.notify(DocEvent.ANNOTATIONS_IMPORTED, {
        count: this.annotations.size,
      });
    }
  }

  /**
   * Add one loaded PDF annotation. Hover writes an annotation that spans
   * pages as one PDF annotation per page, all with the same `/NM`; those are
   * put back together here.
   */
  #addLoaded(converted: Annotation, annot: NativeMarkup, pageNum: number) {
    const existing = this.annotations.get(converted.id);
    if (existing) {
      existing.pageRanges.push(...converted.pageRanges);
      existing.comment ??= converted.comment;
    } else {
      this.annotations.set(converted.id, converted);
    }
    this.#addToPageIndex(converted.id, pageNum);
    if (!annot.name) {
      this.#unnamed.set(converted.id, {
        pageIndex: pageNum - 1,
        locator: { subtype: annot.subtype, rect: annot.rect },
      });
    }
  }

  // ============================================
  // CRUD
  // ============================================

  async addAnnotation(annotationData: AnnotationInput): Promise<Annotation> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const annotation: Annotation = {
      id,
      type: annotationData.type,
      color: annotationData.color,
      pageRanges: annotationData.pageRanges,
      strokes: annotationData.strokes || null,
      rotation: annotationData.rotation ?? 0,
      comment: annotationData.comment || null,
      createdAt: now,
      updatedAt: now,
    };

    this.annotations.set(id, annotation);
    for (const pr of annotation.pageRanges) {
      this.#addToPageIndex(id, pr.pageNumber);
    }
    this.#dirty.add(id);

    this.#doc.notify(DocEvent.ANNOTATION_ADDED, { annotation });
    return annotation;
  }

  async updateAnnotation(
    id: string,
    updates: Partial<AnnotationInput>,
  ): Promise<Annotation | null> {
    const annotation = this.annotations.get(id);
    if (!annotation) return null;

    const oldComment = annotation.comment;
    const oldPages = annotation.pageRanges.map((pr) => pr.pageNumber);
    if (updates.color !== undefined) annotation.color = updates.color;
    if (updates.type !== undefined) annotation.type = updates.type;
    if (updates.comment !== undefined) annotation.comment = updates.comment;
    if (updates.strokes !== undefined) annotation.strokes = updates.strokes;
    if (updates.pageRanges !== undefined)
      annotation.pageRanges = updates.pageRanges;
    if (updates.rotation !== undefined) annotation.rotation = updates.rotation;
    annotation.updatedAt = new Date().toISOString();

    // A drawing dragged across a page boundary changes pages, and the page
    // index keys off the page.
    const newPages = annotation.pageRanges.map((pr) => pr.pageNumber);
    const movedPages = !samePages(oldPages, newPages);
    if (movedPages) {
      for (const pageNumber of oldPages) {
        this.#removeFromPageIndex(id, pageNumber);
      }
      for (const pageNumber of newPages) {
        this.#addToPageIndex(id, pageNumber);
      }
    }

    if (annotation.comment !== oldComment) this.#dropLinkedNote(id);
    this.#dirty.add(id);
    this.#doc.notify(DocEvent.ANNOTATION_UPDATED, { annotation });
    return annotation;
  }

  async deleteAnnotation(id: string): Promise<boolean> {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    // One created since load leaves nothing in the file to remove.
    this.#dirty.delete(id);
    if (this.#loaded.has(id)) this.#deleted.add(id);
    this.#dropLinkedNote(id);

    for (const pr of annotation.pageRanges) {
      this.#removeFromPageIndex(id, pr.pageNumber);
    }
    this.annotations.delete(id);

    this.#doc.notify(DocEvent.ANNOTATION_DELETED, { annotationId: id });
    return true;
  }

  async deleteAnnotationComment(id: string): Promise<boolean> {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;

    annotation.comment = null;
    annotation.updatedAt = new Date().toISOString();

    this.#dropLinkedNote(id);
    this.#dirty.add(id);

    this.#doc.notify(DocEvent.ANNOTATION_UPDATED, { annotation });
    return true;
  }

  // ============================================
  // Accessors
  // ============================================

  getAnnotation(id: string): Annotation | null {
    return this.annotations.get(id) || null;
  }

  getAnnotationsForPage(pageNumber: number): Annotation[] {
    const ids = this.annotationsByPage.get(pageNumber);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.annotations.get(id))
      .filter((a): a is Annotation => Boolean(a));
  }

  getNativeAnnotations(pageNumber: number): NativeLink[] {
    return this.nativeAnnotationsByPage.get(pageNumber) || [];
  }

  getAllAnnotations(): Annotation[] {
    return Array.from(this.annotations.values());
  }

  exportAnnotations(): Annotation[] {
    return Array.from(this.annotations.values());
  }

  hasAnnotations(): boolean {
    return this.annotations.size > 0;
  }

  clear() {
    this.annotations.clear();
    this.annotationsByPage.clear();
    this.nativeAnnotationsByPage.clear();
    this.#loaded.clear();
    this.#unnamed.clear();
    this.#linkedNotes.clear();
    this.#dirty.clear();
    this.#deleted.clear();
    this.#droppedNotes = [];
  }

  #dropLinkedNote(id: string) {
    const note = this.#linkedNotes.get(id);
    if (!note) return;
    this.#linkedNotes.delete(id);
    this.#droppedNotes.push(note);
  }

  // ============================================
  // Page Index
  // ============================================

  #addToPageIndex(annotationId: string, pageNumber: number) {
    if (!this.annotationsByPage.has(pageNumber)) {
      this.annotationsByPage.set(pageNumber, new Set());
    }
    this.annotationsByPage.get(pageNumber)!.add(annotationId);
  }

  #removeFromPageIndex(annotationId: string, pageNumber: number) {
    this.annotationsByPage.get(pageNumber)?.delete(annotationId);
  }

  // ============================================
  // PDF translation: reading
  // ============================================

  #convertMarkup(
    annot: NativeMarkup,
    pageNum: number,
    pageWidth: number,
    pageHeight: number,
  ): Annotation | null {
    const boxes = annot.segments.length > 0 ? annot.segments : [annot.rect];
    const rects: RatioRect[] = boxes.map((box) => ({
      leftRatio: box.origin.x / pageWidth,
      topRatio: box.origin.y / pageHeight,
      widthRatio: box.size.width / pageWidth,
      heightRatio: box.size.height / pageHeight,
    }));
    if (rects.length === 0) return null;

    // The subtype decides, except that files Hover saved through
    // @embedpdf/engines say what a highlight really was.
    const stored = annot.custom?.annotationType;
    const type: AnnotationType =
      annot.subtype === "underline"
        ? "underline"
        : stored === "underline" || stored === "highlight"
          ? stored
          : "highlight";

    return {
      id: annot.name || crypto.randomUUID(),
      type,
      color: hexToColorName(annot.color),
      pageRanges: [{ pageNumber: pageNum, rects, text: "" }],
      comment: annot.contents.trim() || null,
      createdAt: annot.created?.toISOString() || new Date().toISOString(),
      updatedAt: annot.modified?.toISOString() || new Date().toISOString(),
    };
  }

  #convertInk(
    annot: NativeMarkup,
    pageNum: number,
    pageWidth: number,
    pageHeight: number,
  ): Annotation | null {
    if (annot.strokes.length === 0) return null;

    const strokes: DrawingStroke[] = annot.strokes.map((points) => ({
      points: points.map((p) => ({ x: p.x / pageWidth, y: p.y / pageHeight })),
      strokeWidth: (annot.strokeWidth || 2) / pageWidth,
    }));

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!isFinite(minX)) return null;

    // Hover now saves a turned drawing as turned points, so it loads at 0.
    // Hover 0.10 put the angle in `/EPDFCustom`, but @embedpdf/engines
    // dropped it on write; read it in case a file has it anyway.
    const rotation = annot.custom?.rotation;

    return {
      id: annot.name || crypto.randomUUID(),
      type: "drawing",
      color: hexToColorName(annot.color),
      pageRanges: [{
        pageNumber: pageNum,
        rects: [{
          leftRatio: minX,
          topRatio: minY,
          widthRatio: maxX - minX,
          heightRatio: maxY - minY,
        }],
        text: "",
      }],
      strokes,
      rotation: typeof rotation === "number" ? rotation : 0,
      comment: annot.contents.trim() || null,
      createdAt: annot.created?.toISOString() || new Date().toISOString(),
      updatedAt: annot.modified?.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * Attach sticky notes to the markup they comment on: the one a note
   * Hover wrote names in its `/EPDFCustom` (files saved through
   * @embedpdf/engines), or else the nearest uncommented markup.
   */
  #linkNotesToMarkup(notes: Array<{ note: NativeMarkup; pageNum: number }>) {
    for (const { note, pageNum } of notes) {
      if (!note.contents) continue;
      const linkedId = note.custom?.linkedAnnotationId;
      const markup =
        typeof linkedId === "string" && this.annotations.has(linkedId)
          ? this.annotations.get(linkedId)!
          : this.#findNearbyMarkup(note, pageNum);
      if (!markup) continue;

      markup.comment = note.contents.trim();
      const storedType = note.custom?.annotationType;
      if (storedType === "highlight" || storedType === "underline") {
        markup.type = storedType;
      }
      this.#linkedNotes.set(markup.id, {
        pageIndex: pageNum - 1,
        name: note.name,
        rect: note.rect,
      });
    }
  }

  #findNearbyMarkup(note: NativeMarkup, pageNum: number): Annotation | null {
    const textX = note.rect.origin.x;
    const textY = note.rect.origin.y;
    const pageDims = this.#doc.getPageDimensions(pageNum);
    if (!pageDims) return null;

    const threshold = Math.max(pageDims.width, pageDims.height) * 0.1;
    let closest: Annotation | null = null;
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
  // PDF translation: writing
  // ============================================

  /** What to write for each page the annotation covers, by 0-based page. */
  #writesFor(annotation: Annotation): Array<[number, MarkupWrite]> {
    const writes: Array<[number, MarkupWrite]> = [];
    const common = {
      name: annotation.id,
      color: colorNameToHex(annotation.color).toLowerCase(),
      modified: new Date(annotation.updatedAt),
    };

    if (annotation.type === "drawing") {
      const pr = annotation.pageRanges[0];
      const page = pr && this.#doc.getPage(pr.pageNumber);
      const strokes = annotation.strokes ?? [];
      if (!page || strokes.length === 0) return writes;
      const { width: pw, height: ph } = page.size;
      writes.push([
        pr.pageNumber - 1,
        {
          ...common,
          subtype: "ink",
          opacity: 1,
          segments: [],
          strokes: rotatePoints(
            strokes.map((s) => s.points.map((p) => ({ x: p.x * pw, y: p.y * ph }))),
            annotation.rotation ?? 0,
          ),
          strokeWidth: (strokes[0]?.strokeWidth || 0.003) * pw,
          contents: annotation.comment,
        },
      ]);
      return writes;
    }

    annotation.pageRanges.forEach((pr, i) => {
      const page = this.#doc.getPage(pr.pageNumber);
      if (!page || pr.rects.length === 0) return;
      const { width: pw, height: ph } = page.size;
      writes.push([
        pr.pageNumber - 1,
        {
          ...common,
          subtype: annotation.type === "underline" ? "underline" : "highlight",
          opacity: annotation.type === "highlight" ? 0.5 : 1,
          segments: pr.rects.map((r) => toBox(r, pw, ph)),
          strokes: [],
          strokeWidth: 0,
          // The comment goes on the first page's part only, so a viewer
          // shows it once.
          contents: i === 0 ? annotation.comment : null,
        },
      ]);
    });
    return writes;
  }

  /**
   * Write the change since load into `document`, a fresh copy of the file as
   * loaded (`PdfiumDocument.openCopy()`), ready for it to be saved. The open
   * document is never written to.
   *
   * Every annotation is written at most once into a copy that never removes
   * it, so no object PDFium creates here can be left unreferenced. What is
   * removed (deleted annotations, dropped notes, replaced appearance streams)
   * comes from the file, and PDFium leaves out those once nothing refers to
   * them. Nothing here is cleared: the next save starts from the file as
   * loaded again and needs the whole change.
   *
   * A part that fails to write is logged and skipped, so the rest still save.
   */
  writeChanges(document: PdfiumDocument) {
    for (const id of this.#deleted) {
      this.#remove(document, id, this.#loaded.get(id)!.pages);
    }
    for (const note of this.#droppedNotes) {
      try {
        removeAnnotation(
          document,
          note.pageIndex,
          note.name ?? "",
          note.name ? null : { subtype: "text", rect: note.rect },
        );
      } catch (error) {
        console.warn("[AnnotationStore] Error removing comment note:", error);
      }
    }
    for (const id of this.#dirty) {
      const annotation = this.annotations.get(id);
      if (!annotation) continue;
      const loaded = this.#loaded.get(id);
      const pages = annotation.pageRanges.map((pr) => pr.pageNumber);
      if (!loaded) {
        this.#create(document, annotation);
      } else if (loaded.type !== annotation.type || !samePages(loaded.pages, pages)) {
        // Its parts in the file are keyed by page and subtype, so they can't
        // be rewritten in place.
        this.#remove(document, id, loaded.pages);
        this.#create(document, annotation);
      } else {
        this.#update(document, annotation);
      }
    }
  }

  /** The locator for `id` on a page, when it has no `/NM` in the file. */
  #locatorFor(id: string, pageIndex: number): UnnamedLocator | null {
    const unnamed = this.#unnamed.get(id);
    return unnamed?.pageIndex === pageIndex ? unnamed.locator : null;
  }

  #create(document: PdfiumDocument, annotation: Annotation) {
    for (const [pageIndex, write] of this.#writesFor(annotation)) {
      try {
        createAnnotation(document, pageIndex, write);
      } catch (error) {
        console.warn("[AnnotationStore] Error writing annotation:", error);
      }
    }
  }

  /** Rewrite the file's parts of `annotation` in place. */
  #update(document: PdfiumDocument, annotation: Annotation) {
    for (const [pageIndex, write] of this.#writesFor(annotation)) {
      try {
        const locator = this.#locatorFor(annotation.id, pageIndex);
        if (!updateAnnotation(document, pageIndex, write, locator)) {
          createAnnotation(document, pageIndex, write);
        }
      } catch (error) {
        console.warn("[AnnotationStore] Error updating annotation:", error);
      }
    }
  }

  /** Remove the annotation's parts on `pages` (1-based) from the file. */
  #remove(document: PdfiumDocument, id: string, pages: number[]) {
    for (const pageNumber of pages) {
      try {
        removeAnnotation(
          document,
          pageNumber - 1,
          id,
          this.#locatorFor(id, pageNumber - 1),
        );
      } catch (error) {
        console.warn("[AnnotationStore] Error removing annotation:", error);
      }
    }
  }
}
