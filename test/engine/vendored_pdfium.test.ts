/**
 * The PDFium build in `vendor/pdfium/` (scripts/vendor_pdfium.ts): that it is
 * the release `source.json` names, and that the wrapped glue instantiates and
 * opens a PDF through the raw exports, independently of the app's own
 * loader (`pdfium_module.ts`), which the rest of the suite goes through.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import createPdfium from "../../vendor/pdfium/pdfium.mjs";
import { fixturePdfs } from "../support/pdfium.js";

const VENDOR = join(import.meta.dir, "..", "..", "vendor", "pdfium");

interface Source {
  tag: string;
  wasmSha256: string;
}

/** The parts of the Emscripten module this test calls. */
interface RawModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _FPDF_InitLibraryWithConfig(config: number): void;
  _FPDF_LoadMemDocument(data: number, size: number, password: number): number;
  _FPDF_GetPageCount(doc: number): number;
  _FPDF_CloseDocument(doc: number): void;
}

describe("vendor/pdfium", () => {
  const source: Source = JSON.parse(readFileSync(join(VENDOR, "source.json"), "utf8"));
  const wasm = new Uint8Array(readFileSync(join(VENDOR, "pdfium.wasm")));

  test("is the release source.json names", () => {
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(source.wasmSha256);
    const version = readFileSync(join(VENDOR, "VERSION"), "utf8");
    expect(`chromium/${/^BUILD=(\d+)$/m.exec(version)?.[1]}`).toBe(source.tag);
  });

  test("instantiates from the wrapped glue and opens a PDF", async () => {
    const em = (await createPdfium({ wasmBinary: wasm })) as RawModule;
    for (const name of ["addFunction", "removeFunction", "HEAPU8", "HEAP32", "HEAPU32", "HEAPF32", "HEAPF64"]) {
      expect(em).toHaveProperty(name);
    }

    // A version-3 FPDF_LIBRARY_CONFIG, all zero but the version, as
    // pdfium_module.ts passes it.
    const config = em._malloc(20);
    em.HEAPU8.fill(0, config, config + 20);
    em.HEAPU8[config] = 3;
    em._FPDF_InitLibraryWithConfig(config);
    em._free(config);

    const fixture = fixturePdfs().find((f) => f.slug === "arxiv-cvpr-convnext")!;
    const data = em._malloc(fixture.bytes.length);
    em.HEAPU8.set(fixture.bytes, data);
    const doc = em._FPDF_LoadMemDocument(data, fixture.bytes.length, 0);
    try {
      expect(doc).not.toBe(0);
      expect(em._FPDF_GetPageCount(doc)).toBeGreaterThan(0);
    } finally {
      if (doc) em._FPDF_CloseDocument(doc);
      em._free(data);
    }
  });
});
