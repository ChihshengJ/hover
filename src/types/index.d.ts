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
 * PDFium's rect shape, as it comes off `@embedpdf/models` annotations.
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
