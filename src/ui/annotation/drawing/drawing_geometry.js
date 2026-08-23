/**
 * Shared geometry for drawing annotations.
 *
 * Drawing strokes are stored as ratios of the page they belong to, but both the
 * SVG marks and the selection bounding box live in *stage* pixel space (the
 * scrollable container that holds every page wrapper). These helpers are the
 * single conversion between the two, so the rendered drawing and its selection
 * chrome can never drift apart.
 *
 * @typedef {import('../../../viewer/viewpane.js').ViewerPane} ViewerPane
 * @typedef {import('../../../viewer/page.js').PageView} PageView
 * @typedef {{left: number, top: number, width: number, height: number}} PageMetrics
 */

export const COLOR_NAME_TO_HEX = {
  black: "#000000",
  yellow: "#FFB300",
  red: "#E53935",
  blue: "#1E88E5",
  green: "#43A047",
};

/**
 * Page box in stage pixel coordinates.
 * @param {PageView} pageView
 * @returns {PageMetrics}
 */
export function getPageMetrics(pageView) {
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
 * @param {{x: number, y: number}} point
 * @param {PageMetrics} metrics
 */
export function pageToStage(point, metrics) {
  return {
    x: metrics.left + point.x * metrics.width,
    y: metrics.top + point.y * metrics.height,
  };
}

/**
 * Stage pixel point -> page-ratio point.
 * @param {{x: number, y: number}} point
 * @param {PageMetrics} metrics
 */
export function stageToPage(point, metrics) {
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
 *
 * @param {import('../../../viewer/viewpane.js').ViewerPane} pane
 * @param {number} x - Stage pixel X
 * @param {number} y - Stage pixel Y
 * @returns {PageView|null}
 */
export function findPageAtStagePoint(pane, x, y) {
  let best = null;
  let bestDistance = Infinity;

  for (const pageView of pane.pages) {
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
 * @param {Array<{points: {x: number, y: number}[]}>} strokes
 */
export function computeBoundsRaw(strokes) {
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
 * @param {Array<{points: {x: number, y: number}[]}>} strokes
 */
export function computeBounds(strokes) {
  const { minX, minY, maxX, maxY } = computeBoundsRaw(strokes);
  return {
    leftRatio: minX,
    topRatio: minY,
    widthRatio: maxX - minX,
    heightRatio: maxY - minY,
  };
}
