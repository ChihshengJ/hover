/**
 * Phase 0 baseline: Hover's annotations through a save and a reload, recorded
 * from the real `PDFDocumentModel` and `AnnotationStore` over
 * `@embedpdf/engines`.
 *
 * Two kinds of snapshot:
 *
 * - the app model after reloading the saved file (`RatioRect`s, colour names,
 *   comments, strokes). Phases 4 and 5 must keep these exactly;
 * - what the save wrote into each annotation dict, read from the raw bytes.
 *   Phase 5 changes these on purpose (`/CA`, `/T`, `/Contents`) and nothing
 *   else.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { PDFDocumentModel } from "../../src/model/doc.js";
import { primePdfiumWasm } from "../../src/pdf/pdfium_init.js";
import type { Annotation, AnnotationInput } from "../../src/model/annotation_data.js";
import { fixturePdfs, pdfiumWasmBytes, round } from "../support/pdfium.js";
import { annotationDicts } from "../support/pdf_scan.js";

/** The subtypes Hover writes: highlight, underline, ink, and the comment note. */
const HOVER_SUBTYPES = ["/Highlight", "/Underline", "/Ink", "/Text"];

primePdfiumWasm(pdfiumWasmBytes());

function fixtureBytes(slug: string): Uint8Array {
  const fixture = fixturePdfs().find((f) => f.slug === slug);
  if (!fixture) throw new Error(`no fixture ${slug}`);
  return fixture.bytes;
}

const open: PDFDocumentModel[] = [];

async function load(bytes: Uint8Array): Promise<PDFDocumentModel> {
  const doc = new PDFDocumentModel();
  await doc.load(bytes.slice().buffer);
  open.push(doc);
  return doc;
}

afterAll(async () => {
  for (const doc of open) await doc.close();
});

/**
 * One JSON line per annotation. Ids are UUIDs minted per run, and timestamps
 * are the clock unless the file supplies them. `keepModified` keeps
 * `updatedAt`, for a file whose annotations carry `/M`. `createdAt` always
 * goes: neither Preview nor the engine writes `/CreationDate`, so it is
 * always the clock.
 */
function snapshotModel(doc: PDFDocumentModel, keepModified = false): string {
  return doc
    .getAllAnnotations()
    .map(({ id: _id, createdAt: _c, updatedAt, ...rest }: Annotation) =>
      JSON.stringify(round(keepModified ? { ...rest, updatedAt } : rest)),
    )
    .join("\n");
}

function snapshotSavedFile(bytes: Uint8Array): string {
  return annotationDicts(bytes, HOVER_SUBTYPES)
    .map((summary) => JSON.stringify(summary))
    .join("\n");
}

const HIGHLIGHT: AnnotationInput = {
  type: "highlight",
  color: "yellow",
  pageRanges: [
    {
      pageNumber: 1,
      rects: [
        { leftRatio: 0.1, topRatio: 0.2, widthRatio: 0.3, heightRatio: 0.02 },
        { leftRatio: 0.1, topRatio: 0.225, widthRatio: 0.25, heightRatio: 0.02 },
      ],
      text: "highlighted text",
    },
  ],
};

const UNDERLINE: AnnotationInput = {
  type: "underline",
  color: "green",
  pageRanges: [
    {
      pageNumber: 1,
      rects: [
        { leftRatio: 0.15, topRatio: 0.4, widthRatio: 0.4, heightRatio: 0.015 },
      ],
      text: "underlined text",
    },
  ],
};

const INK: AnnotationInput = {
  type: "drawing",
  color: "red",
  pageRanges: [
    {
      pageNumber: 2,
      rects: [
        { leftRatio: 0.2, topRatio: 0.3, widthRatio: 0.15, heightRatio: 0.05 },
      ],
      text: "",
    },
  ],
  strokes: [
    {
      points: [
        { x: 0.2, y: 0.3 },
        { x: 0.25, y: 0.32 },
        { x: 0.3, y: 0.35 },
        { x: 0.35, y: 0.33 },
      ],
      strokeWidth: 0.004,
    },
  ],
};

const COMMENTED: AnnotationInput = {
  type: "highlight",
  color: "blue",
  pageRanges: [
    {
      pageNumber: 2,
      rects: [
        { leftRatio: 0.5, topRatio: 0.6, widthRatio: 0.3, heightRatio: 0.02 },
      ],
      text: "commented text",
    },
  ],
  comment: "A linked comment",
};

describe("papers/arxiv-cvpr-convnext round trip", () => {
  let created: Uint8Array;
  let edited: Uint8Array;

  beforeAll(async () => {
    const doc = await load(fixtureBytes("arxiv-cvpr-convnext"));
    for (const input of [HIGHLIGHT, UNDERLINE, INK, COMMENTED]) {
      await doc.addAnnotation(structuredClone(input));
    }
    created = await doc.saveWithAnnotations();

    // Edit the reloaded file, as a user reopening it would.
    const reloaded = await load(created);
    const byType = (type: string, color: string) =>
      reloaded
        .getAllAnnotations()
        .find((a) => a.type === type && a.color === color)!;
    const underline = byType("underline", "green");
    await reloaded.updateAnnotation(underline.id, {
      color: "red",
      pageRanges: [
        {
          pageNumber: 1,
          rects: [
            { leftRatio: 0.2, topRatio: 0.5, widthRatio: 0.35, heightRatio: 0.015 },
          ],
          text: "underlined text",
        },
      ],
    });
    await reloaded.deleteAnnotation(byType("drawing", "red").id);
    edited = await reloaded.saveWithAnnotations();
  });

  test("created, saved and reloaded", async () => {
    expect(snapshotModel(await load(created))).toMatchSnapshot();
  });

  test("created: saved annotation dicts", () => {
    expect(snapshotSavedFile(created)).toMatchSnapshot();
  });

  test("moved, recoloured, deleted, saved and reloaded", async () => {
    expect(snapshotModel(await load(edited))).toMatchSnapshot();
  });

  test("edited: saved annotation dicts", () => {
    expect(snapshotSavedFile(edited)).toMatchSnapshot();
  });
});

describe("papers/annotated", () => {
  test("Preview's annotations as the store reads them", async () => {
    const doc = await load(fixtureBytes("annotated"));
    expect(snapshotModel(doc, true)).toMatchSnapshot();
  });

  test("Preview's annotation dicts", () => {
    expect(snapshotSavedFile(fixtureBytes("annotated"))).toMatchSnapshot();
  });
});
