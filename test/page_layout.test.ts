/**
 * Page layout (src/viewer/page_layout.ts): the CSS boxes and backing-store
 * size a page gets for a scale, devicePixelRatio and rotation.
 */

import { describe, test, expect } from "bun:test";

import {
  computePageLayout,
  isQuarterTurn,
  rotateTransform,
} from "../src/viewer/page_layout.js";
import { MAX_CANVAS_PIXELS } from "../src/viewer/detail_region.js";

const LETTER = { width: 612, height: 792 };

describe("computePageLayout", () => {
  test("rounds the CSS box and derives height from the rounded width", () => {
    const l = computePageLayout(LETTER, 1.7, 1, 0);
    expect(l.width).toBe(1040);
    expect(l.height).toBe(Math.round(1040 * (792 / 612)));
    expect(l.wrapperWidth).toBe(l.width);
    expect(l.wrapperHeight).toBe(l.height);
  });

  test("rounds the device raster up at a fractional ratio", () => {
    const l = computePageLayout(LETTER, 1, 1.25, 0);
    expect(l.fullWidth).toBe(Math.ceil(612 * 1.25));
    expect(l.fullHeight).toBe(Math.ceil(792 * 1.25));
    // The canvas's CSS box comes from the whole-px raster, so it covers the
    // wrapper rather than falling a fraction short of it.
    expect(l.canvasCssWidth * 1.25).toBe(l.fullWidth);
    expect(l.canvasCssWidth).toBeGreaterThanOrEqual(l.width);
    expect(l.canvasCssHeight).toBeGreaterThanOrEqual(l.height);
  });

  test("swaps only the wrapper on a quarter turn", () => {
    const flat = computePageLayout(LETTER, 1.7, 2, 0);
    for (const rotation of [90, 270]) {
      const l = computePageLayout(LETTER, 1.7, 2, rotation);
      expect(l.width).toBe(flat.width);
      expect(l.height).toBe(flat.height);
      expect(l.wrapperWidth).toBe(flat.height);
      expect(l.wrapperHeight).toBe(flat.width);
      expect(l.fullWidth).toBe(flat.fullWidth);
    }
    const half = computePageLayout(LETTER, 1.7, 2, 180);
    expect(half.wrapperWidth).toBe(flat.wrapperWidth);
  });

  test("stores the full raster below the cap", () => {
    const l = computePageLayout(LETTER, 1.7, 2, 0);
    expect(l.store).toEqual({ width: l.fullWidth, height: l.fullHeight });
  });

  test("caps the store past the limit, keeping the full size", () => {
    const l = computePageLayout(LETTER, 7, 2, 0);
    expect(l.fullWidth * l.fullHeight).toBeGreaterThan(MAX_CANVAS_PIXELS);
    expect(l.store.width * l.store.height).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS,
    );
    expect(l.store.width).toBeLessThan(l.fullWidth);
    expect(l.canvasCssWidth * 2).toBe(l.fullWidth);
  });
});

describe("rotation helpers", () => {
  test("isQuarterTurn", () => {
    expect([0, 90, 180, 270].map(isQuarterTurn)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  test("rotateTransform leaves an unrotated page untransformed", () => {
    expect(rotateTransform(0)).toBe("");
    expect(rotateTransform(90)).toBe("rotate(90deg) translateY(-100%)");
    expect(rotateTransform(180)).toBe("rotate(180deg) translate(-100%, -100%)");
    expect(rotateTransform(270)).toBe("rotate(270deg) translateX(-100%)");
  });
});
