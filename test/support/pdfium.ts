/**
 * PDFium for bun: the app's own shared instance (`initPdfium`), loaded from
 * the vendored wasm rather than fetched, for every test file and for
 * `scripts/build_fixtures.ts`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import { initPdfium, primePdfiumWasm } from "../../src/pdf/pdfium_module.js";
import type { PdfiumBindings } from "../../src/pdf/pdfium_module.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// The vendored copy, not `public/pdfium.wasm`: that one is gitignored and
// only appears once Vite has run.
const WASM_PATH = join(REPO_ROOT, "vendor/pdfium/pdfium.wasm");

/** The wasm bytes, for code that instantiates its own module. */
export function pdfiumWasmBytes(): Uint8Array {
  return new Uint8Array(readFileSync(WASM_PATH));
}

/**
 * The shared PDFium, loaded on first call. `PDFDocumentModel` gets the same
 * instance, so a test that leaks a document leaks it into the next test:
 * close what you open.
 */
export async function loadPdfium(): Promise<{ bindings: PdfiumBindings }> {
  primePdfiumWasm(pdfiumWasmBytes());
  return { bindings: await initPdfium() };
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
