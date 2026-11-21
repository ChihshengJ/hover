/**
 * Phase 0 baseline: what the document model reads out of each fixture PDF,
 * recorded from `@embedpdf/engines` exactly as `PDFDocumentModel.load()` asks
 * for it (`docs/plan_own_pdf_engine.md`).
 *
 * Every later phase moves one of these reads onto Hover's own PDFium layer
 * and must leave this snapshot as it is. A diff here is a behaviour change, not
 * a snapshot to update.
 *
 * While the engine is still here, each fixture also checks that Hover's
 * `PdfiumDocument` reads the same thing the engine does.
 */

import { describe, expect, test } from "bun:test";

import { PdfiumDocument, PdfOpenError } from "../../src/pdf/document.js";
import type { PdfiumBindings } from "../../src/pdf/pdfium_module.js";
import { normalizeAnnotationRects } from "../../src/pdf/annotations.js";
import { collectNamedDestinations } from "../../src/analysis/outline_builder.js";
import {
  fixturePdfs,
  loadPdfium,
  round,
  type FixturePdf,
} from "../support/pdfium.js";

/** The fixtures PDFium refuses without help, and the error code it gives. */
const OPEN_ERRORS: Record<string, number> = {
  "encrypted-user-password": 4, // FPDF_ERR_PASSWORD
  truncated: 3, // FPDF_ERR_FORMAT
  "not-a-pdf": 3, // FPDF_ERR_FORMAT
};

/** Drop every `id` key: the engine mints UUIDs per run. */
function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== "id") out[k] = stripIds(v);
    }
    return out;
  }
  return value;
}

/**
 * One compact JSON line per page, bookmark, destination and annotation.
 * Bun's pretty-printer puts every key on its own line, which turns ~2,000
 * link annotations into a 2 MB snapshot; this keeps a diff to the items that
 * moved.
 */
function toLines(record: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      out.push(`${key}: ${value.length}`);
      for (const item of value) out.push(`  ${JSON.stringify(item)}`);
    } else if (value && typeof value === "object") {
      out.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        if (Array.isArray(v)) {
          for (const item of v) out.push(`  ${k} ${JSON.stringify(item)}`);
        } else {
          out.push(`  ${k} ${JSON.stringify(v)}`);
        }
      }
    } else {
      out.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return out.join("\n");
}

async function recordDocument(fixture: FixturePdf, password?: string) {
  const { bindings, native, engine } = await loadPdfium();
  const pdfDoc = await engine
    .openDocumentBuffer(
      { id: `doc-${fixture.slug}`, content: fixture.bytes.slice().buffer },
      password ? { password } : undefined,
    )
    .toPromise();
  const document = PdfiumDocument.open(bindings, fixture.bytes, password);

  try {
    const metadata = await native.getMetadata(pdfDoc).toPromise();
    const { bookmarks = [] } = await native.getBookmarks(pdfDoc).toPromise();
    const namedDests = collectNamedDestinations(bookmarks);

    const annotations: Record<string, unknown[]> = {};
    for (const page of pdfDoc.pages) {
      const annots = await engine.getPageAnnotations(pdfDoc, page).toPromise();
      normalizeAnnotationRects(document, page.index, annots);
      if (annots.length > 0) annotations[`p${page.index}`] = annots;
    }

    // Through JSON first, so dates become ISO strings before rounding.
    const record = JSON.parse(
      JSON.stringify({
        pageCount: pdfDoc.pages.length,
        pages: pdfDoc.pages.map((p) => ({ size: p.size, rotation: p.rotation })),
        metadata,
        bookmarks,
        namedDests: [...namedDests],
        // Keyed `p<index>` so each annotation line says which page it is on.
        annotations,
      }),
    );
    return toLines(round(stripIds(record)) as Record<string, unknown>);
  } finally {
    document.close();
    await engine.closeDocument(pdfDoc).toPromise();
  }
}

/**
 * The engine's metadata as `PdfMetadata` would hold it: absent and empty
 * entries both null, and only the custom keys Hover reads.
 */
function expectedMetadata(engine: Record<string, any>) {
  const custom: Record<string, string> = {};
  for (const key of ["DOI", "License", "arXivID", "PTEX.Fullbanner"]) {
    if (engine.custom?.[key]) custom[key] = engine.custom[key];
  }
  const text = (key: string) => engine[key] || null;
  return {
    title: text("title"),
    author: text("author"),
    subject: text("subject"),
    keywords: text("keywords"),
    producer: text("producer"),
    creator: text("creator"),
    creationDate: engine.creationDate?.toISOString() ?? null,
    modificationDate: engine.modificationDate?.toISOString() ?? null,
    custom,
  };
}

/** Hover's document reads, next to the engine's for the same file. */
async function compareWithEngine(fixture: FixturePdf, password?: string) {
  const { bindings, native, engine } = await loadPdfium();
  const pdfDoc = await engine
    .openDocumentBuffer(
      { id: `cmp-${fixture.slug}`, content: fixture.bytes.slice().buffer },
      password ? { password } : undefined,
    )
    .toPromise();
  const document = PdfiumDocument.open(bindings, fixture.bytes, password);
  try {
    expect(document.pageCount).toBe(pdfDoc.pages.length);
    expect(
      document.pages.map((p) => ({
        size: p.size,
        rotation: document.pageRotation(p.index),
      })),
    ).toEqual(pdfDoc.pages.map((p) => ({ size: p.size, rotation: p.rotation })));

    const metadata = document.metadata();
    expect({
      ...metadata,
      creationDate: metadata.creationDate?.toISOString() ?? null,
      modificationDate: metadata.modificationDate?.toISOString() ?? null,
    }).toEqual(expectedMetadata(await native.getMetadata(pdfDoc).toPromise()));

    // As strings: the analysis fixtures serialise bookmarks, so key order
    // matters as much as values.
    const { bookmarks = [] } = await native.getBookmarks(pdfDoc).toPromise();
    expect(JSON.stringify(document.bookmarks())).toBe(JSON.stringify(bookmarks));

    expect(document.fileBytes()).toEqual(fixture.bytes);
  } finally {
    document.close();
    await engine.closeDocument(pdfDoc).toPromise();
  }
}

/**
 * `bindings` with its heap allocations counted, to check that a document
 * gives back everything it took.
 */
function trackAllocations(bindings: PdfiumBindings) {
  const live = new Set<number>();
  const tracked = Object.create(bindings) as PdfiumBindings;
  tracked.malloc = (size) => {
    const ptr = bindings.malloc(size);
    live.add(ptr);
    return ptr;
  };
  tracked.free = (ptr) => {
    live.delete(ptr);
    bindings.free(ptr);
  };
  return { bindings: tracked, live };
}

async function openError(fixture: FixturePdf): Promise<number | null> {
  const { engine } = await loadPdfium();
  try {
    const doc = await engine
      .openDocumentBuffer({
        id: `err-${fixture.slug}`,
        content: fixture.bytes.slice().buffer,
      })
      .toPromise();
    await engine.closeDocument(doc).toPromise();
    return null;
  } catch (error) {
    return (error as { reason?: { code?: number } }).reason?.code ?? -1;
  }
}

for (const fixture of fixturePdfs()) {
  describe(`${fixture.group}/${fixture.slug}`, () => {
    if (fixture.slug in OPEN_ERRORS) {
      test("refuses to open", async () => {
        expect(await openError(fixture)).toBe(OPEN_ERRORS[fixture.slug]);
      });
      test("PdfiumDocument refuses it the same way, and frees the file", async () => {
        const { bindings, live } = trackAllocations((await loadPdfium()).bindings);
        let error: unknown = null;
        try {
          PdfiumDocument.open(bindings, fixture.bytes);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(PdfOpenError);
        expect((error as PdfOpenError).code).toBe(OPEN_ERRORS[fixture.slug]);
        expect(live.size).toBe(0);
      });
      return;
    }
    test("document", async () => {
      expect(await recordDocument(fixture)).toMatchSnapshot();
    });
    test("PdfiumDocument reads what the engine reads", async () => {
      await compareWithEngine(fixture);
    });
  });
}

describe("generated/encrypted-user-password", () => {
  test("opens with the user password", async () => {
    const fixture = fixturePdfs().find(
      (f) => f.slug === "encrypted-user-password",
    )!;
    expect(await recordDocument(fixture, "hover-user")).toMatchSnapshot();
  });

  test("PdfiumDocument reads what the engine reads", async () => {
    const fixture = fixturePdfs().find(
      (f) => f.slug === "encrypted-user-password",
    )!;
    await compareWithEngine(fixture, "hover-user");
  });

  test("PdfiumDocument gives back every allocation on close", async () => {
    const fixture = fixturePdfs().find(
      (f) => f.slug === "encrypted-user-password",
    )!;
    const { bindings, live } = trackAllocations((await loadPdfium()).bindings);
    const document = PdfiumDocument.open(bindings, fixture.bytes, "hover-user");
    document.metadata();
    document.bookmarks();
    document.extractPageText(0);
    document.close();
    expect(live.size).toBe(0);
  });
});
