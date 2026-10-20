/**
 * Spread pairing (src/viewer/spread_layout.ts): which pages share a row in
 * even and odd spread mode.
 */

import { describe, test, expect } from "bun:test";

import { pairPages } from "../src/viewer/spread_layout.js";

const pages = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("pairPages", () => {
  test("even mode pairs from the first page", () => {
    expect(pairPages(pages(4), 1)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("even mode leaves an odd last page alone", () => {
    expect(pairPages(pages(5), 1)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("odd mode sets the first page alone, then pairs", () => {
    expect(pairPages(pages(5), 2)).toEqual([[1], [2, 3], [4, 5]]);
    expect(pairPages(pages(4), 2)).toEqual([[1], [2, 3], [4]]);
  });

  test("a single page is a row of its own in either mode", () => {
    expect(pairPages(pages(1), 1)).toEqual([[1]]);
    expect(pairPages(pages(1), 2)).toEqual([[1]]);
  });

  test("no pages, no rows", () => {
    expect(pairPages([], 1)).toEqual([]);
    expect(pairPages([], 2)).toEqual([]);
  });
});
