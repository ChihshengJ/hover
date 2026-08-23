/**
 * The document analysis pipeline: text index in, one immutable result out.
 *
 * Everything the reference/citation engine produces used to be scattered across
 * eight mutable fields on `PDFDocumentModel`, populated by two divergent code
 * paths that disagreed about the shape of a citation. This module owns both
 * paths, converges them on `DocumentAnalysis`, and takes no dependency on the
 * model or on PDFium — so it is callable from a test with nothing but a
 * serialized text index.
 */

import { buildOutline, detectDocumentMetadata } from "./outline_builder.js";
import { buildReferenceIndex } from "./reference_builder.js";
import { createInlineExtractor } from "./inline_extractor.js";
import { createCitationBuilder } from "./citation_builder.js";
import { createCrossReferenceBuilder } from "./cross_reference_builder.js";
import { CitationFlags } from "./lexicon.js";
import { rectFromPdfium } from "./geometry.js";
import type { DocumentTextIndex } from "./text_index.js";
import type { RawPageTextSource } from "./inline_extractor.js";
import type { DocumentMetadata, OutlineItem } from "./outline_builder.js";
import type { ReferenceIndex } from "./reference_builder.js";
import type { Citation } from "./citation_builder.js";
import type {
  CrossReference,
  CrossRefTarget,
} from "./cross_reference_builder.js";

/**
 * A reference index with fewer anchors than this is noise — a stray "[1]" in a
 * footnote, say — and trusting it would decorate the whole document with
 * citations that resolve nowhere. Below the threshold we fall back to whatever
 * link annotations the PDF itself carries.
 */
const MIN_USABLE_REFERENCES = 5;

/** A clickable citation region on a page, as the renderer consumes it. */
export interface CitationAnchor {
  citationId: number;
  rects: Rect[];
  /** CitationFlags bitmask. */
  flags: number;
}

/** An external-URL link annotation on a page. */
export interface PageUrl {
  url: string;
  /** PDFium's own rect shape, passed through to the renderer unconverted. */
  rect: PdfiumRect;
}

/** The pieces `DocumentAnalysis` is assembled from. */
export interface DocumentAnalysisParts {
  outline?: OutlineItem[];
  metadata?: DocumentMetadata;
  references?: ReferenceIndex | null;
  citationsByPage?: Map<number, CitationAnchor[]>;
  citationDetails?: Map<number, Citation>;
  crossRefsByPage?: Map<number, CrossReference[]>;
  crossRefTargets?: Map<string, CrossRefTarget>;
  urlsByPage?: Map<number, PageUrl[]>;
  source?: AnalysisSource;
}

/** Which path produced the citations. */
export type AnalysisSource = "inline" | "native-fallback" | "none";

/**
 * Everything `analyzeDocument()` produces, in one value.
 *
 * Constructed once and never mutated — the model holds a reference and answers
 * queries from it, rather than owning eight fields that can drift apart.
 */
export class DocumentAnalysis {
  outline: OutlineItem[];
  metadata: DocumentMetadata;
  references: ReferenceIndex | null;
  citationsByPage: Map<number, CitationAnchor[]>;
  citationDetails: Map<number, Citation>;
  crossRefsByPage: Map<number, CrossReference[]>;
  crossRefTargets: Map<string, CrossRefTarget>;
  urlsByPage: Map<number, PageUrl[]>;
  /**
   * Which path produced the citations — useful in logs, and the honest answer
   * to "why does this document have no cross-references?".
   */
  source: AnalysisSource;

  constructor(parts: DocumentAnalysisParts = {}) {
    this.outline = parts.outline ?? [];
    this.metadata = parts.metadata ?? {
      title: null,
      lines: null,
      abstractInfo: null,
    };
    this.references = parts.references ?? null;
    this.citationsByPage = parts.citationsByPage ?? new Map();
    this.citationDetails = parts.citationDetails ?? new Map();
    this.crossRefsByPage = parts.crossRefsByPage ?? new Map();
    this.crossRefTargets = parts.crossRefTargets ?? new Map();
    this.urlsByPage = parts.urlsByPage ?? new Map();
    this.source = parts.source ?? "none";
  }

  get hasReferenceIndex(): boolean {
    return (this.references?.anchors?.length || 0) > 0;
  }

  /** Release the maps; the analysis is unusable afterwards. */
  destroy() {
    this.outline = [];
    this.references = null;
    this.citationsByPage = new Map();
    this.citationDetails = new Map();
    this.crossRefsByPage = new Map();
    this.crossRefTargets = new Map();
    this.urlsByPage = new Map();
  }
}

/**
 * Run the full analysis over an already-built text index.
 *
 * Synchronous throughout: every step is a pure function over the index, so the
 * only reason this ever awaited was a builder that had already stopped needing
 * to.
 */
export function analyzeDocument({
  textIndex,
  numPages,
  nativeAnnotationsByPage = new Map(),
  bookmarks = [],
  allNamedDests = new Map(),
  pageTextSource = null,
  onProgress = () => {},
}: {
  textIndex: DocumentTextIndex;
  numPages: number;
  nativeAnnotationsByPage?: Map<number, any[]>;
  bookmarks?: any[];
  allNamedDests?: Map<string, any>;
  pageTextSource?: RawPageTextSource | null;
  onProgress?: (percent: number, phase: string) => void;
}): DocumentAnalysis {
  const metadata = detectDocumentMetadata(textIndex);
  const urlsByPage = indexUrls(nativeAnnotationsByPage);

  onProgress(50, "building outline");
  const outline = buildOutline({
    bookmarks,
    textIndex,
    allNamedDests,
    metadata,
  });
  injectAbstractIntoOutline(outline, metadata.abstractInfo);

  onProgress(65, "indexing references");
  const references = buildReferenceIndex(textIndex, outline);

  const anchorCount = references?.anchors?.length || 0;
  const usable = anchorCount >= MIN_USABLE_REFERENCES;

  onProgress(80, "processing");

  if (usable && pageTextSource) {
    console.log("[Analysis] Parsing full text for inline links...");
    const inline = extractInlineElements({
      textIndex,
      references,
      numPages,
      nativeAnnotationsByPage,
      outline,
      pageTextSource,
    });
    return new DocumentAnalysis({
      outline,
      metadata,
      references,
      urlsByPage,
      source: "inline",
      ...inline,
    });
  }

  if (usable && !pageTextSource) {
    console.warn(
      "[Analysis] No page text source — inline extraction is unavailable, using native-only fallback",
    );
  } else {
    console.warn(
      `[Analysis] Reference index insufficient (${anchorCount} anchors), using native-only fallback`,
    );
  }

  return new DocumentAnalysis({
    outline,
    metadata,
    references,
    urlsByPage,
    source: "native-fallback",
    ...buildNativeFallback(nativeAnnotationsByPage),
  });
}

/**
 * The full-text path: scan every page for citations and cross-references, then
 * merge each against the PDF's own link annotations.
 */
function extractInlineElements({
  textIndex,
  references,
  numPages,
  nativeAnnotationsByPage,
  outline,
  pageTextSource,
}: {
  textIndex: DocumentTextIndex;
  references: ReferenceIndex;
  numPages: number;
  nativeAnnotationsByPage: Map<number, any[]>;
  outline: OutlineItem[];
  pageTextSource: RawPageTextSource;
}) {
  const extractor = createInlineExtractor({
    pageTextSource,
    textIndex,
    referenceIndex: references,
    numPages,
  });
  const { citations, crossRefs } = extractor.extract();

  const citationBuilder = createCitationBuilder({
    referenceIndex: references,
    nativeAnnotationsByPage,
    textIndex,
    numPages,
  });
  const { byPage: citationsByPage, details: citationDetails } =
    citationBuilder.build(citations);

  const crossRefBuilder = createCrossReferenceBuilder({
    textIndex,
    nativeAnnotationsByPage,
    referenceIndex: references,
    numPages,
    outline,
  });
  const { byPage: crossRefsByPage, targets: crossRefTargets } =
    crossRefBuilder.build(crossRefs);

  return {
    citationsByPage,
    citationDetails,
    crossRefsByPage,
    crossRefTargets,
  };
}

/**
 * The no-text-index path: treat every native link with a real destination as a
 * navigable citation.
 *
 * The details it emits are shaped exactly like the ones the inline path
 * produces — same fields, same flag vocabulary — so the renderer never has to
 * ask which path it came from.
 */
function buildNativeFallback(nativeAnnotationsByPage: Map<number, any[]>) {
  const citationsByPage = new Map<number, CitationAnchor[]>();
  const citationDetails = new Map<number, Citation>();
  let nextId = 0;

  for (const [pageNum, annotations] of nativeAnnotationsByPage) {
    const citRefs: CitationAnchor[] = [];

    for (const annot of annotations) {
      if (annot.target?.type !== "destination") continue;

      const dest = annot.target.destination;
      if (!dest || !annot.rect) continue;

      const destPageIndex = dest.pageIndex ?? -1;
      const destX = dest.view?.[0] ?? 0;
      const destY = dest.view?.[1] ?? 0;

      if (destPageIndex < 0 || (destX === 0 && destY === 0)) continue;

      const citationId = nextId++;
      const rect = rectFromPdfium(annot.rect);
      const targetLocation = { pageIndex: destPageIndex, x: destX, y: destY };
      const flags =
        CitationFlags.NATIVE_CONFIRMED | CitationFlags.DEST_CONFIRMED;

      citRefs.push({ citationId, rects: [rect], flags });

      citationDetails.set(citationId, {
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
        allTargets: [{ refIndex: null, refKey: null, location: targetLocation }],
      });
    }

    if (citRefs.length > 0) {
      citationsByPage.set(pageNum, citRefs);
    }
  }

  const total = Array.from(citationsByPage.values()).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  console.log(`[Analysis] Native fallback: ${total} navigable links`);

  return {
    citationsByPage,
    citationDetails,
    crossRefsByPage: new Map<number, CrossReference[]>(),
    crossRefTargets: new Map<string, CrossRefTarget>(),
  };
}

/**
 * Collect external-URL link annotations, by page.
 *
 * Exported because the model wants these the moment annotations load, well
 * before the text index exists — they are the one analysis product that does
 * not depend on the index.
 */
export function indexUrls(
  nativeAnnotationsByPage: Map<number, any[]>,
): Map<number, PageUrl[]> {
  const urlsByPage = new Map<number, PageUrl[]>();
  for (const [pageNum, annotations] of nativeAnnotationsByPage) {
    const urls: PageUrl[] = [];
    for (const annot of annotations) {
      if (annot.target?.type === "action" && annot.target.action?.uri) {
        urls.push({ url: annot.target.action.uri, rect: annot.rect });
      }
    }
    if (urls.length > 0) {
      urlsByPage.set(pageNum, urls);
    }
  }
  return urlsByPage;
}

/**
 * Documents routinely omit the abstract from their own bookmarks even though
 * it is the first thing a reader wants to jump to, so splice in a heading for
 * the one the metadata detector found — unless the outline already names it.
 *
 * Mutates `outline` in place, at the position that keeps it in reading order.
 */
function injectAbstractIntoOutline(
  outline: OutlineItem[],
  abstractInfo: DocumentMetadata["abstractInfo"],
) {
  if (!abstractInfo) return;
  if (outlineContainsAbstract(outline)) return;

  const abstractItem: OutlineItem = {
    id: crypto.randomUUID(),
    title: "Abstract",
    pageIndex: abstractInfo.pageIndex,
    left: abstractInfo.left,
    top: abstractInfo.top,
    children: [],
  };

  let insertIndex = 0;
  for (let i = 0; i < outline.length; i++) {
    const item = outline[i];
    if (item.pageIndex > abstractInfo.pageIndex) break;
    if (item.pageIndex === abstractInfo.pageIndex && item.top <= abstractInfo.top)
      break;
    insertIndex = i + 1;
  }

  outline.splice(insertIndex, 0, abstractItem);
}

function outlineContainsAbstract(items: OutlineItem[]): boolean {
  for (const item of items) {
    const title = item.title?.toLowerCase().trim() || "";
    if (
      title === "abstract" ||
      /^\d+\.?\s*abstract$/i.test(item.title?.trim() || "")
    ) {
      return true;
    }
    if (item.children?.length > 0 && outlineContainsAbstract(item.children)) {
      return true;
    }
  }
  return false;
}
