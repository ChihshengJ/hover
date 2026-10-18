/**
 * The box a page is laid out in for a given scale, devicePixelRatio and
 * rotation, and the backing-store size it renders at. Pure: `PageView`
 * applies the result to its elements (`applyLayout()`).
 */

import { cappedSize } from "./detail_region.js";

import type { Size } from "./detail_region.js";

export interface PageLayout {
  /** The unrotated page, in CSS px: the inner box and its overlay layers. */
  width: number;
  height: number;
  /** The wrapper, in CSS px: the page's box once rotated. */
  wrapperWidth: number;
  wrapperHeight: number;
  /** The full-resolution raster, in device px. */
  fullWidth: number;
  fullHeight: number;
  /** The backing store: the full raster, or capped (detail_region.ts). */
  store: Size;
  /** The canvas's CSS box, derived from the full raster; see below. */
  canvasCssWidth: number;
  canvasCssHeight: number;
}

/** Whether `rotation` turns the page on its side, swapping width and height. */
export function isQuarterTurn(rotation: number): boolean {
  return rotation === 90 || rotation === 270;
}

/**
 * The transform that turns the inner box by `rotation` about its top-left
 * corner and moves it back into the wrapper. `unrotate()` in detail_region.ts
 * inverts it.
 */
export function rotateTransform(rotation: number): string {
  switch (rotation) {
    case 90:
      return "rotate(90deg) translateY(-100%)";
    case 180:
      return "rotate(180deg) translate(-100%, -100%)";
    case 270:
      return "rotate(270deg) translateX(-100%)";
    default:
      return "";
  }
}

/** Lay out a page of `dims` PDF points at `scale`. */
export function computePageLayout(
  dims: Size,
  scale: number,
  dpr: number,
  rotation: number,
): PageLayout {
  const width = Math.round(dims.width * scale);
  const height = Math.round(width * (dims.height / dims.width));

  // A canvas backing store is whole pixels, so round here rather than let
  // the `canvas.width` setter truncate. At a fractional devicePixelRatio
  // (browser zoom, 125%/150% display scaling) the CSS box is then derived
  // from the rounded store, so one buffer pixel maps to one device pixel
  // and the compositor never resamples (blurs) the page. Round *up*: the
  // wrapper stays `width` and is transparent, so a canvas a fraction of a
  // pixel short would leave a seam of wallpaper along its edge; one that
  // overhangs is clipped by the wrapper's paint containment.
  const fullWidth = Math.ceil(width * dpr);
  const fullHeight = Math.ceil(height * dpr);

  const swapped = isQuarterTurn(rotation);
  return {
    width,
    height,
    wrapperWidth: swapped ? height : width,
    wrapperHeight: swapped ? width : height,
    fullWidth,
    fullHeight,
    // The CSS box is the full size either way, so a capped store is
    // stretched to fill it.
    store: cappedSize({ width: fullWidth, height: fullHeight }),
    canvasCssWidth: fullWidth / dpr,
    canvasCssHeight: fullHeight / dpr,
  };
}
