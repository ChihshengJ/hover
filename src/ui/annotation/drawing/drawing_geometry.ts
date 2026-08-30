import type { PageView } from "../../../viewer/page.js";
import type { AnnotationColorName } from "../../../model/annotation_data.js";
import type { ViewerPane } from "../../../viewer/viewpane.js";

/**
 * Shared geometry for drawing annotations.
 *
 * Drawing strokes are stored as ratios of the page they belong to, but both the
 * SVG marks and the selection bounding box live in *stage* pixel space (the
 * scrollable container that holds every page wrapper). These helpers are the
 * single conversion between the two, so the rendered drawing and its selection
 * chrome can never drift apart.
 */

/** Page box in stage pixel coordinates. */
export interface PageMetrics {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const COLOR_NAME_TO_HEX: Record<AnnotationColorName, string> = {
  black: "#000000",
  yellow: "#FFB300",
  red: "#E53935",
  blue: "#1E88E5",
  green: "#43A047",
};

/**
 * Page box in stage pixel coordinates.
 */
export function getPageMetrics(pageView: PageView): PageMetrics {
  return {
    left: pageView.wrapper.offsetLeft,
    top: pageView.wrapper.offsetTop,
    width:
      parseFloat(pageView.textLayer.style.width) ||
      pageView.wrapper.clientWidth,
    height:
      parseFloat(pageView.textLayer.style.height) ||
      pageView.wrapper.clientHeight,
  };
}

/**
 * Page-ratio point -> stage pixel point.
 */
export function pageToStage(
  point: { x: number; y: number },
  metrics: PageMetrics,
) {
  return {
    x: metrics.left + point.x * metrics.width,
    y: metrics.top + point.y * metrics.height,
  };
}

/**
 * Stage pixel point -> page-ratio point.
 */
export function stageToPage(
  point: { x: number; y: number },
  metrics: PageMetrics,
) {
  return {
    x: (point.x - metrics.left) / metrics.width,
    y: (point.y - metrics.top) / metrics.height,
  };
}

/**
 * The page a drawing sits on is whichever page box contains its centre; when it
 * lands in the gap between two pages, the nearest box wins. Callers use this to
 * re-home a drawing after it has been dragged, so editing never depends on the
 * page the drawing was originally created on.
 * @param x Stage pixel X
 * @param y Stage pixel Y
 */
export function findPageAtStagePoint(
  pages: PageView[],
  x: number,
  y: number,
): PageView | null {
  let best = null;
  let bestDistance = Infinity;

  for (const pageView of pages) {
    if (!pageView) continue;
    const { left, top, width, height } = getPageMetrics(pageView);
    const dx = Math.max(left - x, 0, x - (left + width));
    const dy = Math.max(top - y, 0, y - (top + height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pageView;
    }
    if (distance === 0) break;
  }

  return best;
}

/**
 * Bounding box of every stroke point, in whatever space the points are in.
 */
export function computeBoundsRaw(
  strokes: Array<{ points: { x: number; y: number }[] }>,
) {
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;
  for (const stroke of strokes || []) {
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Bounding box as a page-range rect.
 */
export function computeBounds(
  strokes: Array<{ points: { x: number; y: number }[] }>,
) {
  const { minX, minY, maxX, maxY } = computeBoundsRaw(strokes);
  return {
    leftRatio: minX,
    topRatio: minY,
    widthRatio: maxX - minX,
    heightRatio: maxY - minY,
  };
}
