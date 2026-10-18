/**
 * Zoom anchoring (src/viewer/zoom_anchor.ts): the point under the focus stays
 * put across a relayout, whatever the fixed margins and centring around it.
 */

import { describe, test, expect } from "bun:test";

import {
  anchoredScroll,
  captureAnchor,
  clampScale,
  fitOffset,
  MAX_SCALE,
  MIN_SCALE,
  type PageBox,
} from "../src/viewer/zoom_anchor.js";

/**
 * A single column with fixed 14px margins and pages centred in the pane: the
 * least proportional layout the anchor has to hold through.
 */
const MARGIN = 14;
const PANE_W = 1000;

function layout(scale: number, count = 100, w = 612, h = 792): PageBox[] {
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  const left = (Math.max(PANE_W, width) - width) / 2;
  return Array.from({ length: count }, (_, i) => ({
    left,
    top: MARGIN + i * (height + 2 * MARGIN),
    width,
    height,
  }));
}

/** Where the document point (page, fx, fy) sits in scroll-content px. */
function contentPoint(boxes: PageBox[], index: number, fx: number, fy: number) {
  const b = boxes[index];
  return { x: b.left + fx * b.width, y: b.top + fy * b.height };
}

describe("captureAnchor", () => {
  test("holds a point on a page as a fraction of that page", () => {
    const boxes = layout(1);
    const { x, y } = contentPoint(boxes, 3, 0.25, 0.75);
    const anchor = captureAnchor(boxes, x, y);
    expect(anchor.index).toBe(3);
    expect(anchor.fx).toBeCloseTo(0.25);
    expect(anchor.fy).toBeCloseTo(0.75);
  });

  test("holds a point in a gap against the nearest page", () => {
    const boxes = layout(1);
    const below = boxes[4].top + boxes[4].height + 4;
    const anchor = captureAnchor(boxes, boxes[4].left + 10, below);
    expect(anchor.index).toBe(4);
    expect(anchor.fy).toBeGreaterThan(1);
  });

  test("holds a point beside a narrow page against that page", () => {
    const boxes = layout(0.5);
    const { y } = contentPoint(boxes, 7, 0, 0.5);
    const anchor = captureAnchor(boxes, 5, y);
    expect(anchor.index).toBe(7);
    expect(anchor.fx).toBeLessThan(0);
  });

  test("returns null with no pages", () => {
    expect(captureAnchor([], 0, 0)).toBeNull();
  });
});

describe("anchoredScroll", () => {
  // The case `scroll / scale` got wrong: deep in the document, the fixed
  // margins above the focus add up to more than a screen of drift.
  test.each([
    [1, 2, 50],
    [2, 1, 50],
    [1.7, 3.1, 99],
    [0.6, 0.9, 20], // narrow, centred pages
    [0.8, 2.5, 10], // narrow to wider than the pane
  ])("zoom %p → %p on page %p keeps the focus point fixed", (from, to, page) => {
    const focus = { x: 400, y: 300 };
    const before = layout(from);
    const target = contentPoint(before, page, 0.3, 0.6);
    const scroll = { left: target.x - focus.x, top: target.y - focus.y };

    const anchor = captureAnchor(
      before,
      scroll.left + focus.x,
      scroll.top + focus.y,
    );
    const after = layout(to);
    const next = anchoredScroll(after[anchor.index], anchor, focus.x, focus.y);

    const landed = contentPoint(after, page, 0.3, 0.6);
    expect(landed.x - next.left).toBeCloseTo(focus.x, 0);
    expect(landed.y - next.top).toBeCloseTo(focus.y, 0);
  });
});

describe("fitOffset", () => {
  test("centres content that fits, when asked", () => {
    expect(fitOffset(-300, 600, 1000, true)).toBe(200);
  });

  test("holds content that fits at the start otherwise", () => {
    expect(fitOffset(250, 600, 1000, false)).toBe(0);
  });

  test("follows the anchor while the content covers the viewport", () => {
    expect(fitOffset(-500, 2000, 1000, true)).toBe(-500);
  });

  test("never shows space past either edge", () => {
    expect(fitOffset(120, 2000, 1000, true)).toBe(0);
    expect(fitOffset(-1600, 2000, 1000, true)).toBe(-1000);
  });
});

describe("clampScale", () => {
  test("clamps to the zoom range", () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });
});
