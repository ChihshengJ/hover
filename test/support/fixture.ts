/**
 * The fixture format, and the two source objects that replay it.
 *
 * A fixture is everything PDFium was asked for while analysing one PDF, written
 * to JSON by `scripts/build_fixtures.ts`. Replaying it gives `analyzeDocument()`
 * exactly the inputs it had in the browser, with no wasm and no model — which is
 * the whole point of the `analysis/` ↛ `pdf/` rule the layering check enforces.
 */

import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import type { PageSource } from "../../src/analysis/text_index.js";
import type { RawPageTextSource } from "../../src/analysis/inline_extractor.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures");

/** One page's worth of what `PageSource` was asked for. */
export interface RecordedPage {
  size: { width: number; height: number } | null;
  textSlices: unknown[];
  paths: PathObjectInfo[];
}

export interface AnalysisFixture {
  /** Path of the PDF this came from, relative to the repo root. */
  source: string;
  generator: string;
  numPages: number;
  bookmarks: any[];
  namedDests: [string, any][];
  annotationsByPage: [number, any[]][];
  pages: RecordedPage[];
  rawText: {
    /** Keyed by 0-based page index. */
    fullText: Record<
      string,
      { fullText: string; charCount: number; pageWidth: number; pageHeight: number }
    >;
    /** Keyed by `charRangeKey()`. */
    charRanges: Record<string, Rect[]>;
  };
}

/** The key a recorded `getRectsForCharRange` call is stored under. */
export function charRangeKey(
  pageIndex: number,
  startCharIndex: number,
  charCount: number,
): string {
  return `${pageIndex}:${startCharIndex}:${charCount}`;
}

export function loadFixture(name: string): AnalysisFixture {
  const gz = readFileSync(join(FIXTURE_DIR, `${name}.json.gz`));
  return JSON.parse(gunzipSync(gz).toString("utf8"));
}

/** Every fixture on disk, by slug, in a stable order. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .sort();
}

/** The `PageSource` half: page geometry, glyph slices, path objects. */
export function fixturePageSource(fixture: AnalysisFixture): PageSource {
  return {
    numPages: fixture.numPages,
    getPageSize: (pageNumber) => fixture.pages[pageNumber - 1]?.size ?? null,
    getPageTextSlices: async (pageNumber) =>
      fixture.pages[pageNumber - 1]?.textSlices ?? [],
    getPagePaths: (pageNumber) => fixture.pages[pageNumber - 1]?.paths ?? [],
  };
}

/**
 * The `RawPageTextSource` half, replayed from the recorded calls.
 *
 * A miss means the code under test asked PDFium something the recording does
 * not answer — usually because a change moved which character ranges the
 * extractor probes. That is a real difference worth seeing, but only PDFium can
 * resolve it, so the error says how.
 */
export function fixtureRawTextSource(
  fixture: AnalysisFixture,
): RawPageTextSource {
  const { fullText, charRanges } = fixture.rawText;
  return {
    getPageFullText(pageIndex) {
      return (
        fullText[String(pageIndex)] ?? {
          fullText: "",
          charCount: 0,
          pageWidth: 0,
          pageHeight: 0,
        }
      );
    },
    getRectsForCharRange(pageIndex, startCharIndex, charCount) {
      const key = charRangeKey(pageIndex, startCharIndex, charCount);
      const rects = charRanges[key];
      if (!rects) {
        throw new Error(
          `Fixture "${fixture.source}" has no recorded rects for char range ` +
            `${key} (page:start:count). The analysis now probes a range that ` +
            `did not exist when the fixture was built — inspect the change, ` +
            `then re-record with \`bun scripts/build_fixtures.ts\`.`,
        );
      }
      return rects;
    },
  };
}
