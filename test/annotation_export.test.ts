import { describe, expect, test } from "bun:test";

import { stripEmptyAnnotationNotes } from "../src/pdf/annotation_export.js";

const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const text = (data: Uint8Array) => String.fromCharCode(...data);

// As PDFium writes a highlight the engine created without a comment.
const HIGHLIGHT =
  '733 0 obj\n<</C[ 1 .7 0]/Contents()/EPDFCustom({"text":"x"})/F 4/Subtype/Highlight/T()/Type/Annot>>\nendobj\n';

describe("stripEmptyAnnotationNotes", () => {
  test("blanks the empty note and author of an engine-made annotation", () => {
    const out = text(stripEmptyAnnotationNotes(bytes(HIGHLIGHT)));
    expect(out).not.toContain("/Contents()");
    expect(out).not.toContain("/T()");
    expect(out).toContain("/Subtype/Highlight");
    expect(out).toContain("/EPDFCustom(");
  });

  test("keeps every byte offset", () => {
    expect(stripEmptyAnnotationNotes(bytes(HIGHLIGHT)).length).toBe(
      HIGHLIGHT.length,
    );
  });

  test("keeps a note and author that say something", () => {
    const commented = HIGHLIGHT.replace(
      "/Contents()",
      "/Contents(Nice)",
    ).replace("/T()", "/T(Ada)");
    expect(text(stripEmptyAnnotationNotes(bytes(commented)))).toBe(commented);
  });

  test("leaves annotations the file came with alone", () => {
    const foreign =
      "12 0 obj\n<</Contents()/Subtype/Highlight/T()/Type/Annot>>\nendobj\n";
    expect(text(stripEmptyAnnotationNotes(bytes(foreign + HIGHLIGHT)))).toBe(
      foreign + text(stripEmptyAnnotationNotes(bytes(HIGHLIGHT))),
    );
  });

  test("handles several annotations", () => {
    const two = HIGHLIGHT + HIGHLIGHT.replace("733", "735");
    expect(text(stripEmptyAnnotationNotes(bytes(two)))).not.toMatch(
      /\/Contents\(\)|\/T\(\)/,
    );
  });
});
