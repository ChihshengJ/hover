/**
 * DrawingSVGRenderer - Renders drawing annotations as SVG path elements.
 * Handles conversion from normalized coordinates to pixel coordinates
 * and builds smooth bezier curve paths.
 */

import {
  COLOR_NAME_TO_HEX,
  getPageMetrics,
  pageToStage,
} from "./drawing_geometry.js";

/**
 * Render a drawing annotation into an SVG group element.
 * @param {Object} annotation - The drawing annotation object
 * @param {import('../../../viewer/viewpane.js').ViewerPane} pane - The viewer pane
 * @returns {SVGGElement|null} The SVG group element, or null if rendering fails
 */
export function renderDrawingAnnotation(annotation, pane) {
  if (!annotation.strokes || annotation.strokes.length === 0) return null;

  const ns = "http://www.w3.org/2000/svg";
  const pr = annotation.pageRanges[0];
  if (!pr) return null;

  const pageView = pane.pages[pr.pageNumber - 1];
  if (!pageView) return null;

  const metrics = getPageMetrics(pageView);

  const group = document.createElementNS(ns, "g");
  group.classList.add("annotation-group");
  group.dataset.annotationId = annotation.id;
  group.dataset.color = annotation.color;
  group.dataset.type = "drawing";

  const hexColor = COLOR_NAME_TO_HEX[annotation.color] || "#000000";

  // Bounds of every stroke, for the rotation origin and the hit area
  let allMinX = Infinity, allMinY = Infinity;
  let allMaxX = -Infinity, allMaxY = -Infinity;

  for (const stroke of annotation.strokes) {
    if (!stroke.points || stroke.points.length === 0) continue;

    const pixelPoints = stroke.points.map((p) => pageToStage(p, metrics));

    // Track bounds
    for (const p of pixelPoints) {
      allMinX = Math.min(allMinX, p.x);
      allMinY = Math.min(allMinY, p.y);
      allMaxX = Math.max(allMaxX, p.x);
      allMaxY = Math.max(allMaxY, p.y);
    }

    const pathData = buildSmoothPath(pixelPoints);
    const strokeWidthPx = (stroke.strokeWidth || 0.003) * metrics.width;

    const path = document.createElementNS(ns, "path");
    path.classList.add("annotation-mark", "drawing");
    path.dataset.color = annotation.color;
    path.setAttribute("d", pathData);
    path.setAttribute("stroke", hexColor);
    path.setAttribute("stroke-width", String(Math.max(1, strokeWidthPx)));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.style.pointerEvents = "auto";

    group.appendChild(path);
  }

  // Apply rotation if set
  if (annotation.rotation) {
    const cx = (allMinX + allMaxX) / 2;
    const cy = (allMinY + allMaxY) / 2;
    group.setAttribute("transform", `rotate(${annotation.rotation} ${cx} ${cy})`);
  }

  // Invisible hit-area rect covering the full bounding box (easier to click).
  // Drawings deliberately have no hover/selected outline: the selection manager
  // draws the dashed bounding box, and a second outline underneath it read as a
  // doubled border that vanished the moment a drag pulled the pointer off the
  // group.
  if (isFinite(allMinX)) {
    const padding = 6;

    const hitArea = document.createElementNS(ns, "rect");
    hitArea.classList.add("annotation-mark", "drawing", "drawing-hit-area");
    hitArea.dataset.color = annotation.color;
    hitArea.setAttribute("x", String(allMinX - padding));
    hitArea.setAttribute("y", String(allMinY - padding));
    hitArea.setAttribute("width", String(allMaxX - allMinX + padding * 2));
    hitArea.setAttribute("height", String(allMaxY - allMinY + padding * 2));
    hitArea.setAttribute("rx", "4");
    hitArea.setAttribute("ry", "4");
    hitArea.setAttribute("fill", "transparent");
    hitArea.setAttribute("stroke", "none");
    hitArea.style.pointerEvents = "auto";
    hitArea.style.cursor = "pointer";
    group.insertBefore(hitArea, group.firstChild);
  }

  return group;
}

/**
 * Build a smooth SVG path from an array of points using quadratic bezier curves.
 * @param {{x: number, y: number}[]} points
 * @returns {string} SVG path data string
 */
function buildSmoothPath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // Single point: draw a tiny circle
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;

  // Use midpoints and quadratic curves for smoothness
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }

  // Final segment to the last point
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;

  return d;
}
