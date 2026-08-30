/**
 * Turn the fixture PDFs into JSON the analysis tests can replay without wasm.
 *
 * This is the PDFium half of `docs/architecture_plan.md` Phase 3, run once and
 * checked in. It performs exactly the calls `PDFDocumentModel` performs during
 * `load()` and `buildIndex()` — bookmarks, named destinations, annotations with
 * their rects normalised, page geometry, glyph slices, path objects — and
 * writes them out, so `test/analysis.test.ts` can drive the whole
 * reference/citation engine from a file.
 *
 * The raw page text source is captured differently, by recording: the ranges
 * `InlineExtractor` asks for depend on what it finds, so there is no bounded
 * set to serialise up front. The generator runs the real pipeline once behind a
 * recording proxy and stores the calls it made. A later code change that asks
 * for a range nobody recorded fails loudly in the test with a pointer back
 * here — the fixture is a recording of PDFium, and only PDFium can extend it.
 *
 *   bun scripts/build_fixtures.ts            # rebuild every fixture
 *   bun scripts/build_fixtures.ts nature     # just the ones matching "nature"
 *
 * Output is gzipped: a paper's glyph slices are ~3.5 MB of JSON and ~0.45 MB
 * compressed, and nothing reads a fixture by eye. To look at one:
 *
 *   gunzip -c test/fixtures/nature-paper-example.json.gz | jq .pages[0]
 */

import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";

import { init } from "@embedpdf/pdfium";
import { PdfiumNative, PdfEngine } from "@embedpdf/engines/pdfium";

import { PdfiumDocumentFactory } from "../src/pdf/text_extractor.js";
import { normalizeAnnotationRects } from "../src/pdf/annotations.js";
import {
  createPdfPageSource,
  createRawPageTextSource,
} from "../src/pdf/page_source.js";
import { collectNamedDestinations } from "../src/analysis/outline_builder.js";
import { DocumentTextIndex } from "../src/analysis/text_index.js";
import { analyzeDocument } from "../src/analysis/pipeline.js";
import type { RawPageTextSource } from "../src/analysis/inline_extractor.js";
import type { AnalysisFixture, RecordedPage } from "../test/support/fixture.js";
import { charRangeKey } from "../test/support/fixture.js";

const PDF_DIR = "marketing/List of Papers";
const OUT_DIR = "test/fixtures";
// The package's own copy, not `public/pdfium.wasm` — that one is gitignored and
// only appears once Vite has run.
const WASM_PATH = "node_modules/@embedpdf/pdfium/dist/pdfium.wasm";

/** `Nature paper example.pdf` → `nature-paper-example`. */
function slugify(name: string): string {
  return basename(name, extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Round to a fixed number of decimals so a fixture rebuilt on another machine
 * produces the same bytes. Float noise in the last places is not signal here,
 * and it would make every regeneration a diff.
 */
function round(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 1e4) / 1e4;
  }
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = round(v);
    return out;
  }
  return value;
}

async function loadEngine() {
  const wasmBinary = await readFile(WASM_PATH);
  const pdfiumModule = await init({ wasmBinary });
  pdfiumModule.PDFiumExt_Init();
  const native = new PdfiumNative(pdfiumModule);
  // Nothing here rasterises, and the browser converter wants a DOM — but the
  // option is required, so it is a stub that says so if anything reaches it.
  const engine = new PdfEngine(native, {
    imageConverter: () => {
      throw new Error("build_fixtures does not render pages");
    },
  });
  return { pdfiumModule, native, engine };
}

async function buildFixture(pdfPath: string): Promise<AnalysisFixture> {
  const { pdfiumModule, native, engine } = await loadEngine();
  const pdfData = new Uint8Array(await readFile(pdfPath));

  const pdfDoc = await engine
    .openDocumentBuffer({
      id: `fixture-${slugify(pdfPath)}`,
      content: pdfData.buffer as ArrayBuffer,
    })
    .toPromise();

  const factory = new PdfiumDocumentFactory(pdfiumModule);
  const handle = factory.loadFromBuffer(pdfData);

  try {
    const numPages = pdfDoc.pages.length;

    // --- what model/doc.js#load() gathers ---------------------------------
    const bookmarkTree = await native.getBookmarks(pdfDoc).toPromise();
    const bookmarks = bookmarkTree.bookmarks || [];
    const namedDests = collectNamedDestinations(bookmarks);

    const annotationsByPage: [number, unknown[]][] = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = pdfDoc.pages[pageNum - 1];
      const annotations = await engine
        .getPageAnnotations(pdfDoc, page)
        .toPromise();
      normalizeAnnotationRects(handle, pageNum - 1, annotations);
      // `id` is a UUID the engine mints per run. Nothing in src/analysis/ reads
      // it, and keeping it would make every regeneration a full-file diff.
      annotationsByPage.push([
        pageNum,
        annotations.map(({ id: _id, ...rest }) => rest),
      ]);
    }

    // --- what DocumentTextIndex asks its PageSource for --------------------
    const pageSource = createPdfPageSource({
      pdfDoc,
      native,
      lowLevelHandle: handle,
    });
    const pages: RecordedPage[] = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const size = pageSource.getPageSize(pageNum);
      pages.push({
        size,
        textSlices: await pageSource.getPageTextSlices(pageNum),
        paths: pageSource.getPagePaths(pageNum),
      });
    }

    // --- what InlineExtractor asks its RawPageTextSource for ---------------
    // Replay the real pipeline against a recording proxy; whatever it asks for
    // is what the test will ask for.
    const live = createRawPageTextSource(handle);
    const fullText: Record<number, ReturnType<typeof live.getPageFullText>> = {};
    const charRanges: Record<string, Rect[]> = {};
    const recorder: RawPageTextSource = {
      getPageFullText(pageIndex) {
        const result = live.getPageFullText(pageIndex);
        fullText[pageIndex] = result;
        return result;
      },
      getRectsForCharRange(pageIndex, startCharIndex, charCount) {
        const rects = live.getRectsForCharRange(
          pageIndex,
          startCharIndex,
          charCount,
        );
        charRanges[charRangeKey(pageIndex, startCharIndex, charCount)] = rects;
        return rects;
      },
    };

    const textIndex = new DocumentTextIndex(pageSource);
    await textIndex.build();
    analyzeDocument({
      textIndex,
      numPages,
      nativeAnnotationsByPage: new Map(
        annotationsByPage.map(([p, a]) => [p, a as any[]]),
      ),
      bookmarks,
      allNamedDests: namedDests,
      pageTextSource: recorder,
    });

    return round({
      source: pdfPath,
      generator: "bun scripts/build_fixtures.ts",
      numPages,
      bookmarks,
      namedDests: [...namedDests],
      annotationsByPage,
      pages,
      rawText: { fullText, charRanges },
    }) as AnalysisFixture;
  } finally {
    handle.close();
  }
}

const filter = process.argv[2]?.toLowerCase();
const pdfs = readdirSync(PDF_DIR)
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .filter((name) => !filter || name.toLowerCase().includes(filter))
  .sort();

if (pdfs.length === 0) {
  console.error(`No PDFs in ${PDF_DIR}${filter ? ` matching "${filter}"` : ""}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const name of pdfs) {
  const fixture = await buildFixture(join(PDF_DIR, name));
  const outPath = join(OUT_DIR, `${slugify(name)}.json.gz`);
  const bytes = gzipSync(JSON.stringify(fixture), { level: 9 });
  writeFileSync(outPath, bytes);
  console.log(
    `${name} → ${outPath} (${fixture.numPages} pages, ` +
      `${Object.keys(fixture.rawText.charRanges).length} recorded ranges, ` +
      `${Math.round(bytes.length / 1024)} KB)`,
  );
}
