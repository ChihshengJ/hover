/**
 * Keeping the document point under the cursor or fingers fixed across a zoom.
 *
 * The stage does not grow in proportion to scale — every page carries a fixed
 * margin, and pages narrower than the pane are centred in it — so a point
 * can't be carried over as `scroll / scale`. It is held instead as a fraction
 * of the page it falls on, and found again on that page once it is relaid.
 */

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 7;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** A page's box in scroll-content px. */
export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A point as a fraction of one page's box. A point in the gap between pages
 * is held against the nearest page, so the fractions can fall outside 0..1.
 */
export interface ZoomAnchor {
  index: number;
  fx: number;
  fy: number;
}

/** Anchor the scroll-content point (x, y) to the page nearest it. */
export function captureAnchor(
  boxes: readonly PageBox[],
  x: number,
  y: number,
): ZoomAnchor | null {
  let index = -1;
  let best = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const dx = Math.max(b.left - x, 0, x - (b.left + b.width));
    const dy = Math.max(b.top - y, 0, y - (b.top + b.height));
    const dist = dx * dx + dy * dy;
    if (dist < best) {
      best = dist;
      index = i;
      if (dist === 0) break;
    }
  }
  if (index < 0) return null;

  const b = boxes[index];
  return {
    index,
    fx: (x - b.left) / (b.width || 1),
    fy: (y - b.top) / (b.height || 1),
  };
}

/**
 * The scroll offset that puts `anchor` under the viewport point
 * (focusX, focusY), given its page's relaid `box`. Unclamped; the scroller
 * clamps it on assignment.
 */
export function anchoredScroll(
  box: PageBox,
  anchor: ZoomAnchor,
  focusX: number,
  focusY: number,
): { left: number; top: number } {
  return {
    left: box.left + anchor.fx * box.width - focusX,
    top: box.top + anchor.fy * box.height - focusY,
  };
}
