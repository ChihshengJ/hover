/**
 * Upstream PDFium regressions that the pin in `scripts/vendor_pdfium.ts` keeps
 * Hover below (docs/plan_upstream_pdfium.md, phase 0). Each test passes on the
 * pinned release and fails on a release that has the regression, so a bump
 * can't cross one unnoticed.
 *
 * When one fails after a bump:
 * - If the bump isn't needed for a security fix, go back to the newest
 *   release below the regression (`bun run pdfium:check`).
 * - If it is, security wins: take the bump, flip the test's expectation to
 *   the new output, and say so in the phase 6 log.
 * - Once upstream fixes it, the test passes again on the new release, and
 *   the pin can move past it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PdfiumDocument } from "../../src/pdf/document.js";
import { renderPage } from "../../src/pdf/renderer.js";
import { loadPdfium } from "../support/pdfium.js";

const REPORTS = join(import.meta.dir, "..", "..", "docs", "pdfium_reports");

const open: PdfiumDocument[] = [];
afterAll(() => {
  for (const document of open) document.close();
});

/**
 * Phase 0 item 2, from chromium/8111 (PDFium b02da6c41c, "Stop recognizing
 * open, 3-sided paths as rectangles"). A 0.25 pt rule filled as an open path
 * (`m l l l f`) loses PDFium's thin-rectangle snapping and renders light gray
 * at 1×. Elsevier draws its header and table rules this way. Reported in
 * docs/pdfium_reports/open_rect_fill.md, whose PDF this renders.
 */
describe("open-path hairline rules (PDFium b02da6c41c)", () => {
  test("render solid, like the same rule closed with h", async () => {
    const { bindings } = await loadPdfium();
    const bytes = readFileSync(join(REPORTS, "open_rect_fill.pdf"));
    const document = PdfiumDocument.open(bindings, bytes);
    open.push(document);

    // 200×40 pt at scale 1: the open rule covers device row 9, the closed
    // control rule row 29.
    const { data, width } = renderPage(document, 0, 1);
    const column = (y: number) => {
      const i = (y * width + 100) * 4;
      return Math.max(data[i], data[i + 1], data[i + 2]);
    };
    expect([column(8), column(9), column(10)]).toEqual([255, 0, 255]);
    expect([column(28), column(29), column(30)]).toEqual([255, 0, 255]);
  });
});
