/**
 * Phase 0 baseline: what PDFium paints for each fixture, recorded through
 * `@embedpdf/engines` with the options the viewer passes
 * (`viewer/page.ts`: `withAnnotations: false`, no forms).
 *
 * Snapshots hold `{ width, height, sha256 }` rather than pixels. Hover's own
 * renderer (`src/pdf/renderer.ts`) must reproduce them byte for byte; a
 * mismatch means some choice of the engine's has not been ported, not that
 * the golden needs updating.
 *
 *   HOVER_DUMP_RENDERS=/some/dir bun test test/engine/render.test.ts
 *
 * also writes each render as a PNG there for side-by-side review. Never commit
 * them.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { PdfiumDocument } from "../../src/pdf/document.js";
import { renderPage, renderRect } from "../../src/pdf/renderer.js";
import { fixturePdfs, loadPdfium, type FixturePdf } from "../support/pdfium.js";

const DUMP_DIR = process.env.HOVER_DUMP_RENDERS || null;

/** Fixtures PDFium refuses to open without a password, or at all. */
const UNOPENABLE = new Set(["encrypted-user-password", "truncated", "not-a-pdf"]);

const SCALES = [1, 2.5];
const RECT_SCALE = 4;

interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function digest({ data, width, height }: Raster) {
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { width, height, sha256 };
}

// --- PNG writer, for HOVER_DUMP_RENDERS only -------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** The raster is RGBA, as the engine hands it to `ImageData`. */
function encodePng({ data, width, height }: Raster): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rows.set(
      data.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function dump(fixture: FixturePdf, name: string, raster: Raster) {
  if (!DUMP_DIR) return;
  const dir = join(DUMP_DIR, fixture.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), encodePng(raster));
}

// --- Recording -------------------------------------------------------------

/** One way to render: the engine's, or Hover's renderer. */
interface Renderer {
  pageCount: number;
  pageSize(index: number): { width: number; height: number };
  page(index: number, scale: number): Promise<Raster>;
  rect(index: number, scale: number, rect: Rect): Promise<Raster>;
  close(): Promise<void>;
}

async function engineRenderer(fixture: FixturePdf): Promise<Renderer> {
  const { native, engine } = await loadPdfium();
  const pdfDoc = await engine
    .openDocumentBuffer({
      id: `render-${fixture.slug}`,
      content: fixture.bytes.slice().buffer,
    })
    .toPromise();
  // The options `viewer/page.ts` passed.
  const options = (scaleFactor: number) => ({ scaleFactor, withAnnotations: false });
  return {
    pageCount: pdfDoc.pages.length,
    pageSize: (index) => pdfDoc.pages[index].size,
    page: (index, scale) =>
      native.renderPageRaw(pdfDoc, pdfDoc.pages[index], options(scale)).toPromise(),
    rect: (index, scale, { x, y, width, height }) =>
      native
        .renderPageRect(
          pdfDoc,
          pdfDoc.pages[index],
          { origin: { x, y }, size: { width, height } },
          options(scale),
        )
        .toPromise(),
    close: () => engine.closeDocument(pdfDoc).toPromise().then(() => {}),
  };
}

async function hoverRenderer(fixture: FixturePdf): Promise<Renderer> {
  const { bindings } = await loadPdfium();
  const document = PdfiumDocument.open(bindings, fixture.bytes);
  return {
    pageCount: document.pageCount,
    pageSize: (index) => document.page(index)!.size,
    page: async (index, scale) => renderPage(document, index, scale),
    rect: async (index, scale, rect) => renderRect(document, index, scale, rect),
    close: async () => document.close(),
  };
}

/** Every render the baseline covers, by name, in a fixed order. */
async function recordRenders(
  fixture: FixturePdf,
  open: (fixture: FixturePdf) => Promise<Renderer>,
  onRaster: (name: string, raster: Raster) => void = () => {},
) {
  const renderer = await open(fixture);
  try {
    // The generated files are small and each page exercises something
    // different; for the papers, the first two pages are enough.
    const pageCount =
      fixture.group === "generated"
        ? renderer.pageCount
        : Math.min(2, renderer.pageCount);
    const out: Record<string, ReturnType<typeof digest>> = {};
    const record = (name: string, raster: Raster) => {
      out[name] = digest(raster);
      onRaster(name, raster);
    };

    for (let index = 0; index < pageCount; index++) {
      for (const scale of SCALES) {
        record(`p${index}@${scale}`, await renderer.page(index, scale));
      }
    }

    // The detail-region path: the middle third of page 1, at the zoom where
    // the viewer would switch to it.
    const { width, height } = renderer.pageSize(0);
    record(
      `p0-rect@${RECT_SCALE}`,
      await renderer.rect(0, RECT_SCALE, {
        x: width / 3,
        y: height / 3,
        width: width / 3,
        height: height / 3,
      }),
    );
    return out;
  } finally {
    await renderer.close();
  }
}

for (const fixture of fixturePdfs()) {
  if (UNOPENABLE.has(fixture.slug)) continue;
  describe(`${fixture.group}/${fixture.slug}`, () => {
    test("renders", async () => {
      expect(
        await recordRenders(fixture, engineRenderer, (name, raster) =>
          dump(fixture, name, raster),
        ),
      ).toMatchSnapshot();
    });
    test("Hover's renderer paints the same bytes", async () => {
      expect(await recordRenders(fixture, hoverRenderer)).toEqual(
        await recordRenders(fixture, engineRenderer),
      );
    });
  });
}

describe("PdfiumDocument page cache", () => {
  test("renders the same after its page was evicted and reloaded", async () => {
    const fixture = fixturePdfs().find((f) => f.slug === "arxiv-cvpr-convnext")!;
    const { bindings } = await loadPdfium();
    const document = PdfiumDocument.open(bindings, fixture.bytes);
    try {
      const first = digest(renderPage(document, 0, 1));
      // More pages than the cache holds, so page 0 is closed in between.
      for (let index = 1; index < document.pageCount; index++) {
        renderPage(document, index, 0.25);
      }
      expect(digest(renderPage(document, 0, 1))).toEqual(first);
    } finally {
      document.close();
    }
  });
});
