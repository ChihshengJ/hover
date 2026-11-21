/**
 * PDFium for bun: one wasm instance and one engine, shared by every test file
 * and by `scripts/build_fixtures.ts`.
 *
 * The browser path (`src/pdf/pdfium_init.ts`) fetches the wasm from the
 * extension bundle; here it comes straight from the package, so nothing needs
 * Vite to have run first.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import { PdfiumNative, PdfEngine } from "@embedpdf/engines/pdfium";

import { loadPdfiumModule } from "../../src/pdf/pdfium_module.js";
import type { PdfiumBindings } from "../../src/pdf/pdfium_module.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// The package's own copy, not `public/pdfium.wasm`: that one is gitignored and
// only appears once Vite has run.
const WASM_PATH = join(
  REPO_ROOT,
  "node_modules/@embedpdf/pdfium/dist/pdfium.wasm",
);

export interface PdfiumForTests {
  bindings: PdfiumBindings;
  native: PdfiumNative;
  engine: PdfEngine;
}

let loading: Promise<PdfiumForTests> | null = null;

/** The wasm bytes, for code that instantiates its own module. */
export function pdfiumWasmBytes(): Uint8Array {
  return new Uint8Array(readFileSync(WASM_PATH));
}

/**
 * Load the wasm and build the engine once per process. Every caller gets the
 * same instance, so a test that leaks a document leaks it into the next test:
 * close what you open.
 */
export function loadPdfium(): Promise<PdfiumForTests> {
  loading ??= (async () => {
    // The same path the app takes (pdf/pdfium_init.ts), minus the fetch.
    const { bindings, engineModule } = await loadPdfiumModule(pdfiumWasmBytes());
    const native = new PdfiumNative(engineModule);
    // `renderPageRaw` hands back raw pixels and never reaches the converter,
    // and the browser converter wants a DOM. The option is required, so it is
    // a stub that says so if anything does reach it.
    const engine = new PdfEngine(native, {
      imageConverter: () => {
        throw new Error("test PDFium has no image converter");
      },
    });
    return { bindings, native, engine };
  })();
  return loading;
}

/** `Nature paper example.pdf` → `nature-paper-example`. */
export function slugify(name: string): string {
  return basename(name, extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Round to a fixed number of decimals so output recorded on another machine
 * produces the same bytes. Float noise in the last places is not signal here,
 * and it would make every regeneration a diff.
 */
export function round(value: unknown): unknown {
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

export type FixtureGroup = "generated" | "papers" | "marketing";

export interface FixturePdf {
  /** Unique across all groups, e.g. `rotated`, `arxiv-cvpr-convnext`. */
  slug: string;
  group: FixtureGroup;
  /** Relative to the repo root. */
  path: string;
  bytes: Uint8Array;
}

const FIXTURE_DIRS: [FixtureGroup, string][] = [
  ["generated", "test/pdfs/generated"],
  ["papers", "test/pdfs/papers"],
  ["marketing", "marketing/List of Papers"],
];

let fixtures: FixturePdf[] | null = null;

/**
 * Every baseline PDF: `test/pdfs/**` plus the four analysis papers, in a
 * stable order. Includes the ones that fail to open (`truncated.pdf`, …), so
 * callers that only want openable files filter themselves.
 */
export function fixturePdfs(): FixturePdf[] {
  if (fixtures) return fixtures;
  const out: FixturePdf[] = [];
  for (const [group, dir] of FIXTURE_DIRS) {
    const abs = join(REPO_ROOT, dir);
    const names = readdirSync(abs)
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .sort();
    for (const name of names) {
      const path = join(abs, name);
      out.push({
        slug: slugify(name),
        group,
        path: relative(REPO_ROOT, path),
        bytes: new Uint8Array(readFileSync(path)),
      });
    }
  }
  const seen = new Set<string>();
  for (const { slug, path } of out) {
    if (seen.has(slug)) throw new Error(`duplicate fixture slug ${slug} (${path})`);
    seen.add(slug);
  }
  fixtures = out;
  return out;
}
