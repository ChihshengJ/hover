// Shared domain types — the shapes that cross module boundaries often enough
// that re-declaring them inline was its own class of bug.
//
// Declared globally (this file has no top-level import/export, so it is an
// ambient script, not a module). JSDoc anywhere in src/ can write `{Rect}` with
// no `import(...)` specifier, which is the whole point: a `Rect` written twelve
// different ways is a `Rect` nobody can rename.
//
// Types that only one module produces and one module consumes stay as JSDoc
// typedefs next to the code that owns them. This file is for the ones that
// don't belong to anybody.

/** A rectangle in top-left-origin coordinates. The app's one rect shape. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in top-left-origin coordinates. */
interface Point {
  x: number;
  y: number;
}

/**
 * The `{ origin, size }` rect shape PDFium-derived records carry (annotation
 * and link rects from `annotation_reader.ts`, text slices), with both halves
 * optional for loosely typed input. See `PdfBox` for the strict form.
 * Convert with `rectFromPdfium()` from `src/analysis/geometry.js` rather than
 * reading `.origin` / `.size` at the use site.
 */
interface PdfiumRect {
  origin?: Point;
  size?: { width: number; height: number };
}

/**
 * A rule-like path object on a page — the header/footer separator candidates
 * `PdfiumTextExtractor.extractPagePaths()` reports.
 *
 * Declared here rather than beside its producer because `src/analysis/` reads
 * it and may not name `src/pdf/`; it is a geometry record, not a PDFium
 * concept.
 */
interface PathObjectInfo {
  /** Sequential index among path objects on the page. */
  index: number;
  /** PDF native coords (bottom-left origin). */
  pdfRect: { left: number; bottom: number; right: number; top: number };
  /** Top-left origin coords. */
  screenRect: Rect;
}

/**
 * How a citation names a reference.
 *
 * A number for the numbered formats (`[12]`), but the key string itself for
 * the abbreviated format (`[Min+15]`) — `reference_builder` stores whichever
 * the document uses as the anchor's `index`, and citations carry it through
 * unchanged. Declaring this `number` (as the JSDoc long did) silently misread
 * every abbreviated-format document.
 */
type RefIndex = number | string;

/** A destination inside the document: which page, and where on it. */
interface PageLocation {
  /** 0-based. */
  pageIndex: number;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// What Hover reads out of a PDF (src/pdf/document.ts). Declared here because
// src/analysis/ reads bookmarks and may not name src/pdf/.
// ---------------------------------------------------------------------------

/** One page's geometry, as PDFium reports it. */
interface PdfPage {
  /** 0-based. */
  index: number;
  /** In PDF units, with the page's `/Rotate` already applied. */
  size: { width: number; height: number };
}

/**
 * The document Info dictionary. Absent and empty entries are both null:
 * standard PDFium can't tell them apart.
 */
interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  producer: string | null;
  creator: string | null;
  creationDate: Date | null;
  modificationDate: Date | null;
  /** The non-standard keys the metadata dialog shows, when the file has them. */
  custom: {
    DOI?: string;
    License?: string;
    arXivID?: string;
    "PTEX.Fullbanner"?: string;
  };
}

/**
 * A destination. `zoom.mode` is PDFium's `PDFDEST_VIEW_*`; `params` is there
 * only for `/XYZ` (mode 1). `view` holds the raw `/Dest` array numbers.
 */
interface PdfDestination {
  pageIndex: number;
  zoom: { mode: number; params?: { x: number; y: number; zoom: number } };
  view: number[];
}

/** PDFium's `PDFACTION_*`, for the action types Hover reads. */
type PdfAction =
  | { type: 0 } // unsupported, remote go-to, or a go-to with no destination
  | { type: 1; destination: PdfDestination } // go-to
  | { type: 3; uri: string }
  | { type: 4; path: string }; // launch

/** Where a bookmark or a link goes. */
type PdfLinkTarget =
  | { type: "action"; action: PdfAction | undefined }
  | { type: "destination"; destination: PdfDestination };

interface PdfBookmark {
  title: string;
  /** Absent when the bookmark has neither an action nor a destination. */
  target?: PdfLinkTarget;
  children: PdfBookmark[];
}

/**
 * A rect on a page, in PDF units with a top-left origin, in the
 * `{ origin, size }` shape annotations have always carried
 * (`rectFromPdfium()` flattens it).
 */
interface PdfBox {
  origin: Point;
  size: { width: number; height: number };
}

/** A link annotation (src/pdf/annotation_reader.ts). */
interface NativeLink {
  rect: PdfBox;
  /** Absent when the link has neither a destination nor an action. */
  target?: PdfLinkTarget;
}

/** A markup annotation of a kind Hover reads (src/pdf/annotation_reader.ts). */
interface NativeMarkup {
  subtype: "highlight" | "underline" | "ink" | "text";
  /** `/NM`, or null when the annotation has none. */
  name: string | null;
  rect: PdfBox;
  /** Highlight and underline: one box per quad. Otherwise empty. */
  segments: PdfBox[];
  /** Ink: one point list per stroke. Otherwise empty. */
  strokes: Point[][];
  /** Ink: the line width in PDF units. */
  strokeWidth: number;
  /** `#rrggbb`, or null when neither `/C` nor the appearance gives one. */
  color: string | null;
  /** `/CA`, 1 when absent. */
  opacity: number;
  /** `/Contents`, "" when absent. */
  contents: string;
  created: Date | null;
  modified: Date | null;
  /**
   * `/EPDFCustom`, parsed: what Hover saved through `@embedpdf/engines`
   * (`linkedAnnotationId`, `annotationType`, `rotation`, …). Null when absent.
   */
  custom: Record<string, unknown> | null;
}
