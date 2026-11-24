/**
 * What Hover reads out of each fixture PDF: page geometry, metadata, the
 * outline, named destinations, links and markup.
 *
 * First recorded from `@embedpdf/engines` (docs/plan_own_pdf_engine.md phase
 * 0); every read was then moved onto Hover's own layer against that record,
 * and the record now comes from Hover's layer. A diff here is a behaviour
 * change, not a snapshot to update.
 */

import { describe, expect, test } from "bun:test";

import { PdfiumDocument, PdfOpenError } from "../../src/pdf/document.js";
import { readPageAnnotations } from "../../src/pdf/annotation_reader.js";
import { collectNamedDestinations } from "../../src/analysis/outline_builder.js";
import type { PdfiumBindings } from "../../src/pdf/pdfium_module.js";
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
  const { bindings } = await loadPdfium();
  const document = PdfiumDocument.open(bindings, fixture.bytes, password);
  try {
    const bookmarks = document.bookmarks();
    const links: Record<string, unknown[]> = {};
    const markup: Record<string, unknown[]> = {};
    for (const page of document.pages) {
      // Keyed `p<index>` so each line says which page it is on.
      const read = readPageAnnotations(document, page.index);
      if (read.links.length > 0) links[`p${page.index}`] = read.links;
      if (read.markup.length > 0) markup[`p${page.index}`] = read.markup;
    }

    // Through JSON first, so dates become ISO strings before rounding.
    const record = JSON.parse(
      JSON.stringify({
        pageCount: document.pageCount,
        pages: document.pages.map((p) => ({
          size: p.size,
          rotation: document.pageRotation(p.index),
        })),
        metadata: document.metadata(),
        bookmarks,
        namedDests: [...collectNamedDestinations(bookmarks)],
        links,
        markup,
      }),
    );
    return toLines(round(record) as Record<string, unknown>);
  } finally {
    document.close();
  }
}

/**
 * Fixtures whose Info dictionary PDFium drops on save. It rebuilt their
 * cross-reference table by scanning, and the rebuilt trailer has no `/Info`.
 * `@embedpdf/engines`' save dropped it too.
 */
const SAVE_LOSES_INFO = new Set(["bad-startxref"]);

/** Everything Hover reads from a document, as one comparable value. */
function readAll(document: PdfiumDocument, withMetadata = true): string {
  return JSON.stringify({
    pages: document.pages.map((p) => ({
      size: p.size,
      rotation: document.pageRotation(p.index),
    })),
    metadata: withMetadata ? document.metadata() : null,
    bookmarks: document.bookmarks(),
    annotations: document.pages.map((p) => readPageAnnotations(document, p.index)),
  });
}

/** Save `fixture` untouched and expect the copy to read the same. */
async function expectUntouchedSaveReadsTheSame(fixture: FixturePdf, password?: string) {
  const { bindings } = await loadPdfium();
  const original = PdfiumDocument.open(bindings, fixture.bytes, password);
  try {
    const saved = original.save();
    expect(saved.length).toBeGreaterThan(0);
    const copy = PdfiumDocument.open(bindings, saved, password);
    try {
      const withMetadata = !SAVE_LOSES_INFO.has(fixture.slug);
      expect(readAll(copy, withMetadata)).toBe(readAll(original, withMetadata));
    } finally {
      copy.close();
    }
  } finally {
    original.close();
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

function encrypted(): FixturePdf {
  return fixturePdfs().find((f) => f.slug === "encrypted-user-password")!;
}

for (const fixture of fixturePdfs()) {
  describe(`${fixture.group}/${fixture.slug}`, () => {
    if (fixture.slug in OPEN_ERRORS) {
      test("refuses to open, and frees the file", async () => {
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
    test("saves an untouched copy that reads the same", async () => {
      await expectUntouchedSaveReadsTheSame(fixture);
    });
  });
}

describe("generated/encrypted-user-password", () => {
  test("opens with the user password", async () => {
    expect(await recordDocument(encrypted(), "hover-user")).toMatchSnapshot();
  });

  test("saves an untouched copy that reads the same", async () => {
    await expectUntouchedSaveReadsTheSame(encrypted(), "hover-user");
  });

  test("gives back every allocation on close", async () => {
    const { bindings, live } = trackAllocations((await loadPdfium()).bindings);
    const document = PdfiumDocument.open(bindings, encrypted().bytes, "hover-user");
    document.metadata();
    document.bookmarks();
    document.extractPageText(0);
    readPageAnnotations(document, 0);
    document.close();
    expect(live.size).toBe(0);
  });
});
