/**
 * Goo silhouette paths for `clip-path: path(...)` on the backdrop layer
 * (non-Chromium fallback — on Chromium the refraction filter masks its
 * own output instead; see refraction_map.js).
 *
 * The outline is traced from the same smooth-min field the shader draws
 * (marching squares over the JS SDF with linearly interpolated edge
 * crossings), so the clipped frost and the WebGL body/rim agree by
 * construction. The previous analytic Bézier construction (arcs plus
 * tangent fillets) produced a subtly different bridge taper, leaving
 * visible goo with no backdrop effect behind it.
 *
 * All coordinates are CSS px in the clipped element's border-box space.
 */

/**
 * @returns `M…Z` path data for a plain circle.
 */
export function circlePath(cx: number, cy: number, r: number): string {
  const x0 = round(cx - r);
  const x1 = round(cx + r);
  const y = round(cy);
  const rr = round(r);
  return `M ${x0} ${y} A ${rr} ${rr} 0 1 0 ${x1} ${y} A ${rr} ${rr} 0 1 0 ${x0} ${y} Z`;
}

/**
 * Trace the zero isoline of a signed distance field into closed polygon
 * path data (marching squares).
 * @returns One `M … Z` subpath per contour loop.
 * @param sdf Negative inside, CSS px, y-down. Must not touch the scanned square's border.
 * @param size Square extent to scan, px.
 * @param cell Grid pitch, px — accuracy/cost tradeoff. With interpolated crossings the error on blobby shapes stays well under cell / 10, invisible next to the browser's clip anti-aliasing.
 */
export function fieldContourPath(
  sdf: (x: number, y: number) => number,
  size: number,
  cell: number = 2,
): string {
  const n = Math.floor(size / cell) + 1;
  const v = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      v[j * n + i] = sdf(i * cell, j * cell);
    }
  }

  // Crossing points live on grid edges and are keyed per edge, so the two
  // cells sharing an edge refer to the identical point — loops then chain
  // without any float-coordinate matching.
  /** Crossing point, keyed per grid edge: key → [x, y]. */
  const pts = new Map<string, number[]>();
  /** key → neighbouring point keys. */
  const adj = new Map<string, string[]>();

  const crossing = (
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    a: number,
    b: number,
  ) => {
    if (!pts.has(key)) {
      const t = a / (a - b);
      pts.set(key, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
    return key;
  };
  const link = (ka: string, kb: string) => {
    let la = adj.get(ka);
    if (!la) adj.set(ka, (la = []));
    let lb = adj.get(kb);
    if (!lb) adj.set(kb, (lb = []));
    la.push(kb);
    lb.push(ka);
  };

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = v[j * n + i]; //         a ── b
      const b = v[j * n + i + 1]; //     │    │
      const c = v[(j + 1) * n + i + 1]; //d ── c
      const d = v[(j + 1) * n + i];
      const m =
        (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
      if (m === 0 || m === 15) continue;

      const x = i * cell;
      const y = j * cell;
      const top = () => crossing(`h${i},${j}`, x, y, x + cell, y, a, b);
      const right = () =>
        crossing(`v${i + 1},${j}`, x + cell, y, x + cell, y + cell, b, c);
      const bottom = () =>
        crossing(`h${i},${j + 1}`, x, y + cell, x + cell, y + cell, d, c);
      const left = () => crossing(`v${i},${j}`, x, y, x, y + cell, a, d);

      switch (m) {
        case 1:
        case 14:
          link(top(), left());
          break;
        case 2:
        case 13:
          link(top(), right());
          break;
        case 3:
        case 12:
          link(left(), right());
          break;
        case 4:
        case 11:
          link(right(), bottom());
          break;
        case 6:
        case 9:
          link(top(), bottom());
          break;
        case 7:
        case 8:
          link(left(), bottom());
          break;
        case 5:
        case 10: {
          // Saddle: two opposite corners inside — disambiguate with the
          // cell-center sample. (Doesn't occur on the smooth goo field,
          // but keep the tracer correct for any SDF.)
          const insideCenter = (a + b + c + d) / 4 < 0;
          if ((m === 5) === insideCenter) {
            link(top(), right());
            link(left(), bottom());
          } else {
            link(top(), left());
            link(right(), bottom());
          }
          break;
        }
      }
    }
  }

  // Chain the segments into closed loops.
  const visited = new Set();
  let path = "";
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const loop: number[][] = [];
    let prev: string | null = null;
    let cur: string | undefined = start;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      loop.push(pts.get(cur)!);
      const next = adj.get(cur)!.find((k) => k !== prev && !visited.has(k));
      prev = cur;
      cur = next;
    }
    if (loop.length < 3) continue;
    path += `M ${loop.map((p) => `${round(p[0])} ${round(p[1])}`).join(" L ")} Z `;
  }
  return path.trim();
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
