/**
 * Detail rendering geometry (src/viewer/detail_region.ts): the capped base
 * store, the region of the full-resolution raster in view, and mapping that
 * region through the page's rotation.
 */

import { describe, test, expect } from "bun:test";

import {
  MAX_CANVAS_PIXELS,
  cappedSize,
  covers,
  deviceRegion,
  unrotate,
  type Edges,
} from "../src/viewer/detail_region.js";

describe("cappedSize", () => {
  test("leaves a store under the cap alone", () => {
    const full = { width: 2080, height: 2692 };
    expect(cappedSize(full)).toBe(full);
  });

  test("scales a store over the cap to fit, keeping its aspect", () => {
    const full = { width: 8568, height: 11088 };
    const { width, height } = cappedSize(full);
    expect(width * height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(width * height).toBeGreaterThan(MAX_CANVAS_PIXELS * 0.999);
    expect(width / height).toBeCloseTo(full.width / full.height, 3);
  });
});

describe("deviceRegion", () => {
  const full = { width: 4000, height: 5000 };

  test("rounds outwards to whole device px", () => {
    const r = { left: 10.3, top: 20.6, right: 100.2, bottom: 200.1 };
    expect(deviceRegion(r, 2, full)).toEqual({
      left: 20,
      top: 41,
      right: 201,
      bottom: 401,
    });
  });

  test("clips to the raster", () => {
    const r = { left: -50, top: -50, right: 3000, bottom: 3000 };
    expect(deviceRegion(r, 2, full)).toEqual({
      left: 0,
      top: 0,
      right: 4000,
      bottom: 5000,
    });
  });

  test("is null when nothing of the page is covered", () => {
    expect(
      deviceRegion({ left: 2100, top: 0, right: 2200, bottom: 10 }, 2, full),
    ).toBeNull();
  });
});

describe("unrotate", () => {
  // The unrotated page, in CSS px.
  const W = 600;
  const H = 800;

  /**
   * Where a point of the unrotated page lands in the wrapper, by the
   * transforms layoutPages puts on `.page-rotate-inner` (origin 0 0).
   */
  function forward(rotation: number, u: number, v: number): [number, number] {
    switch (rotation) {
      case 90: // rotate(90deg) translateY(-100%)
        return [H - v, u];
      case 180: // rotate(180deg) translate(-100%, -100%)
        return [W - u, H - v];
      case 270: // rotate(270deg) translateX(-100%)
        return [v, W - u];
      default:
        return [u, v];
    }
  }

  /** The wrapper-space box around a page-space rect's corners. */
  function forwardRect(rotation: number, r: Edges): Edges {
    const corners = [
      forward(rotation, r.left, r.top),
      forward(rotation, r.right, r.top),
      forward(rotation, r.left, r.bottom),
      forward(rotation, r.right, r.bottom),
    ];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  }

  const pageRect = { left: 50, top: 120, right: 330, bottom: 700 };

  for (const rotation of [0, 90, 180, 270]) {
    test(`undoes the ${rotation}° transform`, () => {
      const wrapperRect = forwardRect(rotation, pageRect);
      expect(unrotate(wrapperRect, rotation, W, H)).toEqual(pageRect);
    });
  }
});

describe("covers", () => {
  const outer = { left: 0, top: 0, right: 100, bottom: 100 };

  test("holds for a rect inside, edges included", () => {
    expect(covers(outer, outer)).toBe(true);
    expect(covers(outer, { left: 10, top: 10, right: 90, bottom: 90 })).toBe(
      true,
    );
  });

  test("fails for a rect past any edge", () => {
    expect(covers(outer, { left: 10, top: 10, right: 101, bottom: 90 })).toBe(
      false,
    );
    expect(covers(outer, { left: 10, top: -1, right: 90, bottom: 90 })).toBe(
      false,
    );
  });
});
