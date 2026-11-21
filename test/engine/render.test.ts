/**
 * Phase 0 baseline: what PDFium paints for each fixture, recorded through
 * `@embedpdf/engines` with the options the viewer passes
 * (`viewer/page.ts`: `withAnnotations: false`, no forms).
 *
 * Snapshots hold `{ width, height, sha256 }` rather than pixels. Phase 3's
 * renderer must reproduce them byte for byte; a mismatch means some choice of
 * the engine's has not been ported yet, not that the golden needs updating.
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

async function recordRenders(fixture: FixturePdf) {
  const { native, engine } = await loadPdfium();
  const pdfDoc = await engine
    .openDocumentBuffer({
      id: `render-${fixture.slug}`,
      content: fixture.bytes.slice().buffer,
    })
    .toPromise();

  try {
    // The generated files are small and each page exercises something
    // different; for the papers, the first two pages are enough.
    const pages =
      fixture.group === "generated" ? pdfDoc.pages : pdfDoc.pages.slice(0, 2);
    const out: Record<string, ReturnType<typeof digest>> = {};

    for (const page of pages) {
      for (const scaleFactor of SCALES) {
        const raster = await native
          .renderPageRaw(pdfDoc, page, { scaleFactor, withAnnotations: false })
          .toPromise();
        const name = `p${page.index}@${scaleFactor}`;
        out[name] = digest(raster);
        dump(fixture, name, raster);
      }
    }

    // The detail-region path: the middle third of page 1, at the zoom where
    // the viewer would switch to it.
    const first = pdfDoc.pages[0];
    const { width, height } = first.size;
    const rect = {
      origin: { x: width / 3, y: height / 3 },
      size: { width: width / 3, height: height / 3 },
    };
    const raster = await native
      .renderPageRect(pdfDoc, first, rect, {
        scaleFactor: RECT_SCALE,
        withAnnotations: false,
      })
      .toPromise();
    const name = `p0-rect@${RECT_SCALE}`;
    out[name] = digest(raster);
    dump(fixture, name, raster);

    return out;
  } finally {
    await engine.closeDocument(pdfDoc).toPromise();
  }
}

for (const fixture of fixturePdfs()) {
  if (UNOPENABLE.has(fixture.slug)) continue;
  describe(`${fixture.group}/${fixture.slug}`, () => {
    test("renders", async () => {
      expect(await recordRenders(fixture)).toMatchSnapshot();
    });
  });
}
