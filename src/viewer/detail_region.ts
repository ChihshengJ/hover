/**
 * Detail rendering: past a size, a page's canvas holds the whole page at
 * reduced resolution, and a second canvas over it holds only the part in view,
 * at full resolution. The cost of a render then follows the viewport instead
 * of the square of the zoom. See docs/pdf_lifecycle.md §5.
 */

/**
 * The most device px a page's base canvas holds: 64 MB of RGBA. A Letter page
 * at a devicePixelRatio of 2 reaches it near scale 2.9.
 */
export const MAX_CANVAS_PIXELS = 2 ** 24;

export interface Size {
  width: number;
  height: number;
}

/** A rectangle by its edges; `right` and `bottom` are exclusive. */
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The backing store for a page whose full-resolution raster is `full`: that,
 * or scaled down to fit `max` with its aspect kept.
 */
export function cappedSize(full: Size, max = MAX_CANVAS_PIXELS): Size {
  const area = full.width * full.height;
  if (area <= max) return full;
  const k = Math.sqrt(max / area);
  return {
    width: Math.max(1, Math.floor(full.width * k)),
    height: Math.max(1, Math.floor(full.height * k)),
  };
}

/**
 * Map `r` from the page wrapper's CSS px, which are rotated, to the page's
 * own, which are not — the space of everything inside `.page-rotate-inner`.
 * `width` and `height` are the unrotated page's; `rotation` is in degrees and
 * matches the transforms `ViewerPane.layoutPages()` gives the inner box.
 */
export function unrotate(
  r: Edges,
  rotation: number,
  width: number,
  height: number,
): Edges {
  switch (rotation) {
    case 90:
      return {
        left: r.top,
        top: height - r.right,
        right: r.bottom,
        bottom: height - r.left,
      };
    case 180:
      return {
        left: width - r.right,
        top: height - r.bottom,
        right: width - r.left,
        bottom: height - r.top,
      };
    case 270:
      return {
        left: width - r.bottom,
        top: r.left,
        right: width - r.top,
        bottom: r.right,
      };
    default:
      return r;
  }
}

/**
 * The whole device px of a page's full-resolution raster that cover `r`, in
 * page CSS px, clipped to the raster. Null when nothing is left.
 */
export function deviceRegion(
  r: Edges,
  dpr: number,
  full: Size,
): Edges | null {
  const left = Math.max(0, Math.floor(r.left * dpr));
  const top = Math.max(0, Math.floor(r.top * dpr));
  const right = Math.min(full.width, Math.ceil(r.right * dpr));
  const bottom = Math.min(full.height, Math.ceil(r.bottom * dpr));
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

export function covers(outer: Edges, inner: Edges): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}
