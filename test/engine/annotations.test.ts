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
import { PdfiumDocument } from "../../src/pdf/document.js";
import { readPageAnnotations } from "../../src/pdf/annotation_reader.js";
import {
  fixturePdfs,
  loadPdfium,
  pdfiumWasmBytes,
  round,
} from "../support/pdfium.js";
import { annotationDicts } from "../support/pdf_scan.js";
import { engineMarkup, expectSameMarkup } from "../support/engine_annotations.js";

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

/**
 * Read `bytes` with Hover's annotation reader and with the engine, and expect
 * every markup annotation to come out the same. Returns how many it compared.
 */
async function expectReaderMatchesEngine(bytes: Uint8Array): Promise<number> {
  const { bindings, engine } = await loadPdfium();
  const pdfDoc = await engine
    .openDocumentBuffer({ id: `reader-${open.length}`, content: bytes.slice().buffer })
    .toPromise();
  const document = PdfiumDocument.open(bindings, bytes);
  let compared = 0;
  try {
    for (const page of pdfDoc.pages) {
      const theirs = engineMarkup(
        await engine.getPageAnnotations(pdfDoc, page).toPromise(),
      );
      const ours = readPageAnnotations(document, page.index).markup;
      expect(ours.length).toBe(theirs.length);
      theirs.forEach((annot, i) => expectSameMarkup(annot, ours[i]));
      compared += ours.length;
    }
  } finally {
    document.close();
    await engine.closeDocument(pdfDoc).toPromise();
  }
  return compared;
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

  test("only Hover's own annotations, with no private keys", () => {
    for (const bytes of [created, edited]) {
      const text = Buffer.from(bytes).toString("latin1");
      expect(text).not.toContain("PDFIUM_HasGeneratedAP");
      expect(text).not.toContain("EPDF");
    }
  });
});

/**
 * A file saved by Hover 0.10 (commit 578fbad), through @embedpdf/engines:
 * a commented highlight with its separate sticky note, an underline, a
 * drawing turned 30°, and a highlight across pages 3–4. Everything about
 * Hover's own annotations was in `/EPDFCustom`.
 */
describe("papers/hover-0.10-annotated", () => {
  const legacy = () => fixtureBytes("hover-0-10-annotated");

  test("Hover's reader reads the engine's markup like the engine", async () => {
    // Highlight, its note, underline, ink, and the two halves of the last one.
    expect(await expectReaderMatchesEngine(legacy())).toBe(6);
  });

  test("loads as it was saved: comment, rotation, the two-page highlight", async () => {
    expect(snapshotModel(await load(legacy()))).toMatchSnapshot();
  });

  test("a changed comment moves into /Contents and the old note goes", async () => {
    const doc = await load(legacy());
    const commented = doc.getAllAnnotations().find((a) => a.comment)!;
    expect(commented.comment).toBe("Saved by Hover 0.10");
    await doc.updateAnnotation(commented.id, { comment: "Edited in Hover" });
    const saved = await doc.saveWithAnnotations();

    expect(annotationDicts(saved, ["/Text"])).toEqual([]);
    const reloaded = await load(saved);
    expect(reloaded.getAnnotation(commented.id)?.comment).toBe("Edited in Hover");
    expect(reloaded.getAllAnnotations().filter((a) => a.comment).length).toBe(1);
  });

  test("its drawing's 30° never reached the file", async () => {
    // Hover 0.10 passed the angle in `/EPDFCustom`, and the engine dropped it
    // on write (it treats `rotation` there as its own). So the drawing always
    // came back unturned; it still does.
    const doc = await load(legacy());
    expect(doc.getAllAnnotations().find((a) => a.type === "drawing")!.rotation).toBe(0);
  });
});

describe("drawing rotation", () => {
  test("is saved as turned points, and reloads at rotation 0 looking the same", async () => {
    const doc = await load(fixtureBytes("arxiv-cvpr-convnext"));
    const drawing = await doc.addAnnotation({ ...structuredClone(INK), rotation: 30 });
    const reloaded = (await load(await doc.saveWithAnnotations())).getAnnotation(drawing.id)!;
    expect(reloaded.rotation).toBe(0);

    // The old points turned 30° clockwise about their box's centre, in page
    // points (the page isn't square, so not in ratios).
    const page = doc.getPage(drawing.pageRanges[0].pageNumber)!.size;
    const pts = drawing.strokes![0].points.map((p) => ({
      x: p.x * page.width,
      y: p.y * page.height,
    }));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const a = Math.PI / 6;
    const turned = pts.map((p) => ({
      x: (cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a)) / page.width,
      y: (cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a)) / page.height,
    }));
    expect(round(reloaded.strokes![0].points)).toEqual(round(turned));
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

  test("Hover's reader reads Preview's markup like the engine", async () => {
    expect(await expectReaderMatchesEngine(fixtureBytes("annotated"))).toBe(6);
  });
});
