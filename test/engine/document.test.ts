/**
 * Phase 0 baseline: what the document model reads out of each fixture PDF,
 * recorded from `@embedpdf/engines` exactly as `PDFDocumentModel.load()` asks
 * for it (`docs/plan_own_pdf_engine.md`).
 *
 * Every later phase moves one of these reads onto Hover's own PDFium layer
 * and must leave this snapshot as it is. A diff here is a behaviour change, not
 * a snapshot to update.
 */

import { describe, expect, test } from "bun:test";

import { PdfiumDocumentFactory } from "../../src/pdf/text_extractor.js";
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
  const handle = new PdfiumDocumentFactory(bindings).loadFromBuffer(
    fixture.bytes,
    password,
  );

  try {
    const metadata = await native.getMetadata(pdfDoc).toPromise();
    const { bookmarks = [] } = await native.getBookmarks(pdfDoc).toPromise();
    const namedDests = collectNamedDestinations(bookmarks);

    const annotations: Record<string, unknown[]> = {};
    for (const page of pdfDoc.pages) {
      const annots = await engine.getPageAnnotations(pdfDoc, page).toPromise();
      normalizeAnnotationRects(handle, page.index, annots);
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
    handle.close();
    await engine.closeDocument(pdfDoc).toPromise();
  }
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
      return;
    }
    test("document", async () => {
      expect(await recordDocument(fixture)).toMatchSnapshot();
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
});
