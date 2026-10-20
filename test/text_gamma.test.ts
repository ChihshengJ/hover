/**
 * The text-weight curve applied to page rasters (src/viewer/text_gamma.ts).
 */

import { describe, test, expect } from "bun:test";

import { applyTextGamma } from "../src/viewer/text_gamma.js";

const W = 20;
const H = 20;
const WHOLE = { x: 0, y: 0, width: W, height: H };

/** A W×H RGBA raster filled with one colour. */
function raster(rgb: number[]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return data;
}

const set = (data: Uint8ClampedArray, x: number, y: number, rgb: number[]) =>
  data.set([...rgb, 255], (y * W + x) * 4);

const at = (data: Uint8ClampedArray, x: number, y: number) => [
  ...data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3),
];

/** Page-fraction box over raster px [x0, x1) × [y0, y1). */
const box = (x0: number, y0: number, x1: number, y1: number) =>
  new Float32Array([x0 / W, y0 / H, x1 / W, y1 / H]);

describe("applyTextGamma", () => {
  test("darkens a glyph edge on white like the plain gamma curve", () => {
    const data = raster([255, 255, 255]);
    set(data, 10, 10, [0, 0, 0]);
    set(data, 11, 10, [128, 128, 128]);
    applyTextGamma(data, W, H, box(8, 8, 13, 13), WHOLE);
    // 255 * (128 / 255) ** 1.5
    expect(at(data, 11, 10)).toEqual([91, 91, 91]);
    expect(at(data, 10, 10)).toEqual([0, 0, 0]);
    expect(at(data, 12, 12)).toEqual([255, 255, 255]);
  });

  test("keeps a coloured fill behind the text and the text colour exact", () => {
    const fill = [200, 220, 255];
    const ink = [20, 20, 120];
    const data = raster(fill);
    set(data, 10, 10, ink);
    // Halfway between fill and ink.
    set(data, 11, 10, [110, 120, 188]);
    applyTextGamma(data, W, H, box(8, 8, 13, 13), WHOLE);
    expect(at(data, 9, 9)).toEqual(fill);
    expect(at(data, 10, 10)).toEqual(ink);
    // Pulled toward the ink: coverage 0.5 -> 1 - 0.5 ** 1.5 ≈ 0.646.
    const edge = at(data, 11, 10);
    expect(edge[0]).toBeLessThan(110);
    expect(edge[2]).toBeLessThan(188);
  });

  test("leaves pixels that are not between background and text alone", () => {
    const data = raster([255, 255, 255]);
    set(data, 10, 10, [0, 0, 0]);
    set(data, 11, 10, [230, 40, 40]); // a red figure mark under the label
    applyTextGamma(data, W, H, box(8, 8, 13, 13), WHOLE);
    expect(at(data, 11, 10)).toEqual([230, 40, 40]);
  });

  test("leaves pixels outside every box (plus its 1px pad) alone", () => {
    const data = raster([255, 255, 255]);
    set(data, 7, 7, [0, 0, 0]);
    set(data, 4, 4, [128, 128, 128]); // in the pad
    set(data, 3, 3, [128, 128, 128]); // outside
    applyTextGamma(data, W, H, box(5, 5, 10, 10), WHOLE);
    expect(at(data, 4, 4)).toEqual([91, 91, 91]);
    expect(at(data, 3, 3)).toEqual([128, 128, 128]);
  });

  test("overlapping boxes apply the curve once", () => {
    const data = raster([255, 255, 255]);
    set(data, 10, 10, [0, 0, 0]);
    set(data, 11, 10, [128, 128, 128]);
    const b = box(8, 8, 13, 13);
    applyTextGamma(data, W, H, new Float32Array([...b, ...b]), WHOLE);
    expect(at(data, 11, 10)).toEqual([91, 91, 91]);
  });

  test("maps boxes through the page placement for a cropped raster", () => {
    // The raster is a W×H crop whose origin sits at page px (40, 40) of a
    // 100×100 page.
    const data = raster([255, 255, 255]);
    set(data, 10, 10, [0, 0, 0]);
    set(data, 11, 10, [128, 128, 128]);
    set(data, 1, 1, [128, 128, 128]);
    applyTextGamma(data, W, H, new Float32Array([0.48, 0.48, 0.53, 0.53]), {
      x: -40,
      y: -40,
      width: 100,
      height: 100,
    });
    expect(at(data, 11, 10)).toEqual([91, 91, 91]);
    expect(at(data, 1, 1)).toEqual([128, 128, 128]);
  });
});
