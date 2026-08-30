/**
 * Snapshot the reference/citation engine over the fixture PDFs.
 *
 * `docs/architecture_plan.md` Phase 3: the parser has three detection tiers,
 * format heuristics and ~40 regexes, and changing its scoping model blind is the
 * main risk in the plan. These pin what it currently produces — the anchor list
 * and the citation → reference mapping — so Phase 4's mechanical steps can be
 * proved neutral before the behavioural ones land.
 *
 * The snapshots are written as flat text rather than nested objects, because a
 * reviewer has to be able to read the diff and say whether the move was
 * intended. One anchor or citation per line, most-significant fields first.
 *
 *   bun test                         # check
 *   bun test --update-snapshots      # accept a deliberate move
 *
 * Regenerating the fixtures themselves is a separate, PDFium-side step:
 * `bun scripts/build_fixtures.ts`.
 */

import { describe, test, expect } from "bun:test";

import { DocumentTextIndex } from "../src/analysis/text_index.js";
import { analyzeDocument } from "../src/analysis/pipeline.js";
import type { DocumentAnalysis } from "../src/analysis/pipeline.js";
import type { ReferenceAnchor } from "../src/analysis/reference_builder.js";
import type { OutlineItem } from "../src/analysis/outline_builder.js";
import {
  loadFixture,
  fixtureNames,
  fixturePageSource,
  fixtureRawTextSource,
  type AnalysisFixture,
} from "./support/fixture.js";

/** Two decimals is finer than any coordinate here is meaningful to. */
const n = (value: number | null | undefined) =>
  value == null ? "-" : value.toFixed(2);

const quote = (text: string, max = 90) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > max ? flat.slice(0, max) + "…" : flat);
};

const hex = (flags: number) => `0x${(flags >>> 0).toString(16).padStart(4, "0")}`;

const location = (loc: { pageIndex: number; x: number; y: number } | null) =>
  loc ? `p${loc.pageIndex + 1}@(${n(loc.x)},${n(loc.y)})` : "unresolved";

/**
 * The pipeline narrates itself at some length, which buries the test output.
 * Set `VERBOSE_ANALYSIS=1` to hear it — the logs are the fastest way to see
 * which detection tier fired when a snapshot moves.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.VERBOSE_ANALYSIS) return fn();

  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function analyze(fixture: AnalysisFixture): Promise<DocumentAnalysis> {
  const textIndex = new DocumentTextIndex(fixturePageSource(fixture));
  await textIndex.build();

  return analyzeDocument({
    textIndex,
    nativeAnnotationsByPage: new Map(fixture.annotationsByPage),
    bookmarks: fixture.bookmarks,
    allNamedDests: new Map(fixture.namedDests),
    pageTextSource: fixtureRawTextSource(fixture),
  });
}

/**
 * `id` is a fresh UUID on every run, so it never appears in a snapshot. Nothing
 * downstream of the analysis depends on the value, only on its uniqueness.
 */
function formatAnchors(anchors: ReferenceAnchor[]): string {
  return anchors
    .map((a) => {
      const label = a.index === null ? "(unlabelled)" : `[${a.index}]`;
      const authors = a.authorSearchText ? quote(a.authorSearchText, 40) : "-";
      return (
        `${label} p${a.pageNumber} (${n(a.startCoord?.x)},${n(a.startCoord?.y)})` +
        `-(${n(a.endCoord?.x)},${n(a.endCoord?.y)}) ${a.formatHint}` +
        ` year=${a.year ?? "-"} multi=${a.hasMultipleAuthors ? "y" : "n"}` +
        ` authors=${authors} pages=[${a.pageRanges.map((r) => r.pageNumber).join(",")}]` +
        ` text=${quote(a.cachedText)}`
      );
    })
    .join("\n");
}

/**
 * The citation → reference mapping, which is the thing Phase 4 changes the
 * meaning of: today a bare index identifies a reference document-wide.
 */
function formatCitations(analysis: DocumentAnalysis): string {
  return [...analysis.citationDetails.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, c]) => {
      const refs = c.refIndices.length ? c.refIndices.join(",") : "-";
      const keys = c.refKeys?.length ? c.refKeys.map(String).join(",") : "-";
      const ranges = c.refRanges.length
        ? c.refRanges.map((r) => `${r.start}-${r.end}`).join(",")
        : "-";
      const targets = c.allTargets
        .map((t) => `${t.refIndex ?? t.refKey ?? "-"}→${location(t.location)}`)
        .join(" ");
      return (
        `#${id} p${c.pageNumber} ${c.type} ${quote(c.text, 60)}` +
        ` refs=[${refs}] keys=[${keys}] ranges=[${ranges}]` +
        ` conf=${c.confidence.toFixed(2)} flags=${hex(c.flags)}` +
        ` rects=${c.rects.length} → ${location(c.targetLocation)}` +
        (targets ? ` all=[${targets}]` : "")
      );
    })
    .join("\n");
}

function formatCrossRefs(analysis: DocumentAnalysis): string {
  const refs = [...analysis.crossRefsByPage.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([page, list]) =>
      list.map(
        (r) =>
          `p${page} ${r.type} ${quote(r.text, 50)} → ${r.targetId}` +
          `${r.isDefinition ? " (definition)" : ""} ${location(r.targetLocation)}` +
          ` flags=${hex(r.flags)} rects=${r.rects.length}`,
      ),
    );

  const targets = [...analysis.crossRefTargets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, t]) =>
        `${id} = ${t.type} p${t.pageNumber} (${n(t.x)},${n(t.y)}) ${quote(t.text, 60)}`,
    );

  return [`targets:`, ...targets, `references:`, ...refs].join("\n");
}

function formatOutline(items: OutlineItem[], depth = 0): string {
  return items
    .flatMap((item) => [
      `${"  ".repeat(depth)}p${item.pageIndex + 1} (${n(item.left)},${n(item.top)}) ${quote(item.title, 70)}`,
      ...(item.children.length ? [formatOutline(item.children, depth + 1)] : []),
    ])
    .join("\n");
}

const names = fixtureNames();

test("the fixture set is present", () => {
  // A missing fixture directory would otherwise make this file silently pass
  // with no tests at all.
  expect(names.length).toBeGreaterThan(0);
});

describe.each(names)("%s", (name) => {
  // Loading and analysing a fixture takes a second or two, so it happens once
  // per file and every test in the block awaits the same promise.
  let cached: Promise<DocumentAnalysis> | null = null;
  const get = () => (cached ??= quietly(() => analyze(loadFixture(name))));

  test("reference index", async () => {
    const analysis = await get();
    const refs = analysis.references;
    const edge = (e: { pageNumber: number; lineIndex: number } | null) =>
      e ? `p${e.pageNumber} line ${e.lineIndex}` : "-";

    const header = [
      `analysis source: ${analysis.source}`,
      `format: ${refs?.format ?? "-"}`,
      `section: ${edge(refs?.sectionStart ?? null)} → ${edge(refs?.sectionEnd ?? null)}`,
      `anchors: ${refs?.anchors.length ?? 0}`,
      "",
    ].join("\n");

    expect(header + formatAnchors(refs?.anchors ?? [])).toMatchSnapshot();
  });

  test("citations", async () => {
    expect(formatCitations(await get())).toMatchSnapshot();
  });

  test("cross-references", async () => {
    expect(formatCrossRefs(await get())).toMatchSnapshot();
  });

  test("outline", async () => {
    expect(formatOutline((await get()).outline)).toMatchSnapshot();
  });

  test("detected metadata", async () => {
    const analysis = await get();
    expect({
      title: analysis.metadata.title,
      abstract: analysis.metadata.abstractInfo,
      urlPages: [...analysis.urlsByPage.keys()].sort((a, b) => a - b),
      urlCount: [...analysis.urlsByPage.values()].reduce(
        (sum, u) => sum + u.length,
        0,
      ),
    }).toMatchSnapshot();
  });
});
