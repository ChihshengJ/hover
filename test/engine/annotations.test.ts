/**
 * Hover's annotations through a save and a reload, through the real
 * `PDFDocumentModel` and `AnnotationStore`.
 *
 * Two kinds of snapshot:
 *
 * - the app model after reloading the saved file (`RatioRect`s, colour names,
 *   comments, strokes). First recorded over `@embedpdf/engines`; Hover's own
 *   reader and writer reproduce it exactly;
 * - what the save wrote into each annotation dict, read from the raw bytes.
 *   These changed once, on purpose, when Hover started writing annotations
 *   itself (docs/plan_own_pdf_engine.md phase 5).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { PDFDocumentModel } from "../../src/model/doc.js";
import { primePdfiumWasm } from "../../src/pdf/pdfium_module.js";
import type { Annotation, AnnotationInput } from "../../src/model/annotation_data.js";
import { readPageAnnotations } from "../../src/pdf/annotation_reader.js";
import { fixturePdfs, pdfiumWasmBytes, round } from "../support/pdfium.js";
import { annotationDicts, scanObjects } from "../support/pdf_scan.js";

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

});

/**
 * Edits stay in the store, and each save writes the net change into a fresh
 * copy of the file as loaded (docs/plan_upstream_pdfium.md phase 1). Written
 * through to the open document, an annotation created and then removed stays
 * in the saved file on PDFium chromium/8165 and later, `/Contents` included,
 * and every in-place edit leaves its old appearance stream behind on any
 * PDFium.
 */
describe("annotations are written only on save", () => {
  const SECRET = "Deleted before saving";

  /** Whether `text` is anywhere in the bytes, as PDFDocEncoding or UTF-16BE. */
  function contains(bytes: Uint8Array, text: string): boolean {
    const latin1 = Buffer.from(bytes).toString("latin1");
    const utf16be = [...text].map((c) => `\0${c}`).join("");
    return latin1.includes(text) || latin1.includes(utf16be);
  }

  test("a deleted comment's text is not in the saved bytes", async () => {
    const withSecret = { ...structuredClone(COMMENTED), comment: SECRET };

    // Created, then deleted.
    const deleted = await load(fixtureBytes("arxiv-cvpr-convnext"));
    const a = await deleted.addAnnotation(structuredClone(withSecret));
    await deleted.deleteAnnotation(a.id);
    expect(contains(await deleted.saveWithAnnotations(), SECRET)).toBe(false);

    // Created, then its comment cleared, which once meant remove and
    // recreate, since PDFium has no call to drop `/Contents`.
    const cleared = await load(fixtureBytes("arxiv-cvpr-convnext"));
    const b = await cleared.addAnnotation(structuredClone(withSecret));
    await cleared.deleteAnnotationComment(b.id);
    const clearedBytes = await cleared.saveWithAnnotations();
    expect(contains(clearedBytes, SECRET)).toBe(false);
    expect(annotationDicts(clearedBytes, ["/Highlight"]).length).toBe(1);

    // Saved, reopened, then deleted.
    const withComment = await load(fixtureBytes("arxiv-cvpr-convnext"));
    await withComment.addAnnotation(structuredClone(withSecret));
    const reopened = await load(await withComment.saveWithAnnotations());
    const c = reopened.getAllAnnotations().find((x) => x.comment === SECRET)!;
    await reopened.deleteAnnotation(c.id);
    expect(contains(await reopened.saveWithAnnotations(), SECRET)).toBe(false);
  });

  test("any number of in-place edits save one appearance stream", async () => {
    const original = await load(fixtureBytes("arxiv-cvpr-convnext"));
    await original.addAnnotation(structuredClone(HIGHLIGHT));
    const bytes = await original.saveWithAnnotations();

    const objectCount = async (edits: number) => {
      const doc = await load(bytes);
      const { id } = doc.getAllAnnotations()[0];
      const colors = ["red", "blue", "green"] as const;
      for (let i = 0; i < edits; i++) {
        await doc.updateAnnotation(id, { color: colors[i % colors.length] });
      }
      return scanObjects(await doc.saveWithAnnotations()).size;
    };
    expect(await objectCount(5)).toBe(await objectCount(1));
  });

  test("creating and deleting before saving leaves the file's annotations as loaded", async () => {
    const untouched = await load(fixtureBytes("annotated"));
    const plain = await untouched.saveWithAnnotations();

    const doc = await load(fixtureBytes("annotated"));
    const { id } = await doc.addAnnotation(structuredClone(HIGHLIGHT));
    await doc.updateAnnotation(id, { comment: SECRET });
    await doc.deleteAnnotation(id);
    const saved = await doc.saveWithAnnotations();

    // Not byte for byte: newer PDFium gives every save a fresh trailer `/ID`.
    expect(contains(saved, SECRET)).toBe(false);
    expect(scanObjects(saved).size).toBe(scanObjects(plain).size);
    expect(snapshotSavedFile(saved)).toBe(snapshotSavedFile(fixtureBytes("annotated")));
  });

  test("each of two saves in one session is right, and the open document is never written", async () => {
    const doc = await load(fixtureBytes("arxiv-cvpr-convnext"));
    const liveCount = () => readPageAnnotations(doc.document!, 0).markup.length;
    const before = liveCount();

    const highlight = await doc.addAnnotation(structuredClone(HIGHLIGHT));
    const first = await doc.saveWithAnnotations();

    await doc.updateAnnotation(highlight.id, { color: "red", comment: "Second" });
    const underline = await doc.addAnnotation(structuredClone(UNDERLINE));
    const second = await doc.saveWithAnnotations();

    await doc.deleteAnnotation(highlight.id);
    const third = await doc.saveWithAnnotations();

    expect(liveCount()).toBe(before);

    const one = await load(first);
    expect(one.getAllAnnotations().map((a) => [a.id, a.color, a.comment])).toEqual([
      [highlight.id, "yellow", null],
    ]);

    const two = await load(second);
    expect(
      two.getAllAnnotations().map((a) => [a.id, a.color, a.comment]).sort(),
    ).toEqual(
      [
        [highlight.id, "red", "Second"],
        [underline.id, "green", null],
      ].sort(),
    );
    expect(annotationDicts(second, ["/Highlight"]).length).toBe(1);

    const three = await load(third);
    expect(three.getAllAnnotations().map((a) => a.id)).toEqual([underline.id]);
    expect(annotationDicts(third, ["/Highlight"])).toEqual([]);
    expect(contains(third, "Second")).toBe(false);
  });
});
