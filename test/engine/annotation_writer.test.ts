/**
 * `src/pdf/annotation_writer.ts` on its own: write, save, reopen, and read
 * back with `annotation_reader.ts`.
 */

import { describe, expect, test } from "bun:test";

import { PdfiumDocument } from "../../src/pdf/document.js";
import { readPageAnnotations } from "../../src/pdf/annotation_reader.js";
import {
  createAnnotation,
  removeAnnotation,
  updateAnnotation,
  type MarkupWrite,
} from "../../src/pdf/annotation_writer.js";
import { fixturePdfs, loadPdfium, round } from "../support/pdfium.js";
import { annotationDicts } from "../support/pdf_scan.js";

const MARKUP_SUBTYPES = ["/Highlight", "/Underline", "/Ink", "/Text"];

function bytesOf(slug: string): Uint8Array {
  return fixturePdfs().find((f) => f.slug === slug)!.bytes;
}

async function open(bytes: Uint8Array): Promise<PdfiumDocument> {
  return PdfiumDocument.open((await loadPdfium()).bindings, bytes);
}

/** Save, close, and reopen. */
async function reopen(document: PdfiumDocument): Promise<[PdfiumDocument, Uint8Array]> {
  const saved = document.save();
  document.close();
  return [await open(saved), saved];
}

function box(x: number, y: number, width: number, height: number): PdfBox {
  return { origin: { x, y }, size: { width, height } };
}

const MODIFIED = new Date(Date.UTC(2026, 10, 21, 12, 0, 0));

function highlight(name: string, overrides: Partial<MarkupWrite> = {}): MarkupWrite {
  return {
    name,
    subtype: "highlight",
    color: "#ffb300",
    opacity: 0.5,
    segments: [box(100, 120, 200, 12), box(100, 134, 150, 12)],
    strokes: [],
    strokeWidth: 0,
    contents: null,
    modified: MODIFIED,
    ...overrides,
  };
}

const UNDERLINE: MarkupWrite = {
  name: "underline-1",
  subtype: "underline",
  color: "#43a047",
  opacity: 1,
  segments: [box(80, 300, 220, 11)],
  strokes: [],
  strokeWidth: 0,
  contents: "A comment",
  modified: MODIFIED,
};

const INK: MarkupWrite = {
  name: "ink-1",
  subtype: "ink",
  color: "#e53935",
  opacity: 1,
  segments: [],
  strokes: [
    [
      { x: 150, y: 400 },
      { x: 180, y: 420 },
      { x: 230, y: 410 },
    ],
    [{ x: 160, y: 450 }],
  ],
  strokeWidth: 2.5,
  contents: null,
  modified: MODIFIED,
};

/** What the reader should give back for a write. */
function expectReadBack(markup: NativeMarkup | undefined, w: MarkupWrite) {
  expect(markup).toBeDefined();
  expect(markup!.subtype).toBe(w.subtype);
  expect(markup!.name).toBe(w.name);
  expect(markup!.color).toBe(w.color);
  expect(markup!.contents).toBe(w.contents ?? "");
  expect(markup!.modified?.toISOString()).toBe(w.modified.toISOString());
  expect(markup!.custom).toBeNull();
  if (w.subtype === "ink") {
    expect(round(markup!.strokes)).toEqual(round(w.strokes));
    expect(markup!.strokeWidth).toBeCloseTo(w.strokeWidth, 3);
  } else {
    expect(round(markup!.segments)).toEqual(round(w.segments));
    // Never above 254/255: see `MAX_ALPHA` in annotation_writer.ts.
    expect(markup!.opacity).toBeCloseTo(Math.min(254, Math.round(w.opacity * 255)) / 255, 6);
  }
}

/** The saved-file checks every write must pass. */
function expectCleanFile(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString("latin1");
  expect(text).not.toContain("PDFIUM_HasGeneratedAP");
  expect(text).not.toContain("EPDF");
  for (const dict of annotationDicts(bytes, MARKUP_SUBTYPES)) {
    expect(dict.keys).toContain("/AP");
    expect(dict.empty).toEqual([]);
    // Preview draws an appearance without /Resources in the wrong colours.
    expect(dict.apWithoutResources).toBeUndefined();
  }
}

describe("annotation_writer", () => {
  test("writes on pages of every rotation, and reads back the same", async () => {
    const document = await open(bytesOf("rotated"));
    const writes: [number, MarkupWrite][] = [];
    // rotated.pdf pages 0–3 are /Rotate 0, 90, 180, 270.
    for (let page = 0; page < 4; page++) {
      for (const w of [highlight(`hl-${page}`), UNDERLINE, INK]) {
        const named = { ...w, name: `${w.name}-p${page}` };
        createAnnotation(document, page, named);
        writes.push([page, named]);
      }
    }
    const [copy, saved] = await reopen(document);
    try {
      for (const [page, w] of writes) {
        const markup = readPageAnnotations(copy, page).markup;
        expectReadBack(
          markup.find((m) => m.name === w.name),
          w,
        );
      }
      expectCleanFile(saved);
      const dicts = annotationDicts(saved, MARKUP_SUBTYPES);
      expect(dicts.length).toBe(12);
      for (const dict of dicts) {
        expect(dict.keys).not.toContain("/T");
        if (dict.subtype === "/Highlight") expect(dict.ca).toBeCloseTo(128 / 255, 5);
      }
    } finally {
      copy.close();
    }
  });

  test("updates in place: moves and recolours, keeps the annotation's other keys", async () => {
    const document = await open(bytesOf("arxiv-cvpr-convnext"));
    createAnnotation(document, 0, highlight("hl", { contents: "first" }));
    createAnnotation(document, 0, INK);
    const moved = highlight("hl", {
      color: "#1e88e5",
      segments: [box(120, 200, 180, 12), box(120, 214, 100, 12), box(120, 228, 90, 12)],
      contents: "second",
    });
    const redrawn: MarkupWrite = {
      ...INK,
      color: "#000000",
      strokes: [[{ x: 10, y: 20 }, { x: 40, y: 60 }]],
      strokeWidth: 1,
    };
    expect(updateAnnotation(document, 0, moved)).toBe(true);
    expect(updateAnnotation(document, 0, redrawn)).toBe(true);
    expect(updateAnnotation(document, 0, highlight("nowhere"))).toBe(false);

    const [copy, saved] = await reopen(document);
    try {
      const markup = readPageAnnotations(copy, 0).markup;
      expect(markup.length).toBe(2);
      expectReadBack(markup.find((m) => m.name === "hl"), moved);
      expectReadBack(markup.find((m) => m.name === "ink-1"), redrawn);
      expectCleanFile(saved);
    } finally {
      copy.close();
    }
  });

  test("recreates when it can't update in place: fewer segments, comment cleared", async () => {
    const document = await open(bytesOf("arxiv-cvpr-convnext"));
    createAnnotation(document, 0, highlight("hl", { contents: "a comment" }));
    const shrunk = highlight("hl", { segments: [box(50, 50, 40, 10)], contents: null });
    expect(updateAnnotation(document, 0, shrunk)).toBe(true);

    const [copy, saved] = await reopen(document);
    try {
      const markup = readPageAnnotations(copy, 0).markup;
      expect(markup.length).toBe(1);
      expectReadBack(markup[0], shrunk);
      const [dict] = annotationDicts(saved, ["/Highlight"]);
      expect(dict.keys).not.toContain("/Contents");
      expectCleanFile(saved);
    } finally {
      copy.close();
    }
  });

  test("names an unnamed annotation on first edit, and touches nothing else", async () => {
    const original = bytesOf("annotated");
    const document = await open(original);
    const before = readPageAnnotations(document, 0);
    const preview = before.markup.find((m) => m.subtype === "highlight")!;
    expect(preview.name).toBeNull();

    const recoloured = highlight("hover-id", {
      color: "#e53935",
      opacity: 1,
      segments: preview.segments,
      contents: preview.contents,
    });
    const locator = { subtype: "highlight" as const, rect: preview.rect };
    expect(updateAnnotation(document, 0, recoloured, locator)).toBe(true);

    const [copy, saved] = await reopen(document);
    try {
      const after = readPageAnnotations(copy, 0);
      expect(after.links).toEqual(before.links);
      const edited = after.markup.find((m) => m.name === "hover-id")!;
      expect(edited.color).toBe("#e53935");
      expect(round(edited.segments)).toEqual(round(preview.segments));

      // Every other annotation in the file reads exactly as before.
      const others = (doc: PdfiumDocument, skip: string | null) =>
        doc.pages.flatMap((p) =>
          readPageAnnotations(doc, p.index).markup.filter((m) => m.name !== skip || !skip),
        );
      const fresh = await open(original);
      try {
        const untouched = others(fresh, null).filter((m) => m !== null);
        const now = others(copy, "hover-id").filter((m) => m.name !== "hover-id");
        expect(JSON.stringify(now)).toBe(
          JSON.stringify(untouched.filter((m) => !(m.subtype === "highlight" && sameRect(m, preview)))),
        );
      } finally {
        fresh.close();
      }

      // In place: Preview's own keys (/T) are still there.
      const dicts = annotationDicts(saved, ["/Highlight"]);
      expect(dicts.filter((d) => d.keys.includes("/NM")).length).toBe(1);
      expect(dicts.every((d) => d.keys.includes("/T"))).toBe(true);
      expect(Buffer.from(saved).toString("latin1")).not.toContain("PDFIUM_HasGeneratedAP");
    } finally {
      copy.close();
    }
  });

  test("removes by name, and leaves the rest", async () => {
    const document = await open(bytesOf("arxiv-cvpr-convnext"));
    createAnnotation(document, 1, highlight("a"));
    createAnnotation(document, 1, highlight("b"));
    expect(removeAnnotation(document, 1, "a")).toBe(true);
    expect(removeAnnotation(document, 1, "a")).toBe(false);
    const [copy] = await reopen(document);
    try {
      expect(readPageAnnotations(copy, 1).markup.map((m) => m.name)).toEqual(["b"]);
    } finally {
      copy.close();
    }
  });
});

function sameRect(a: NativeMarkup, b: NativeMarkup): boolean {
  return JSON.stringify(round(a.rect)) === JSON.stringify(round(b.rect));
}
