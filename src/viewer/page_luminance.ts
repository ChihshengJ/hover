/**
 * Coarse luminance maps for rendered page canvases.
 *
 * The liquid-glass ball recolors its page-number digits from the brightness of
 * whatever sits behind them, which for most of the window is a PDF page.
 *
 * Pageview.render() holds the brightness data while rendering. We reduce it once
 * into a grid of `BLOCK`-sized cells and answer every later query from the grid.
 * A sample becomes a few array reads, the canvas stays GPU-accelerated, and the
 * map costs ~22 KB per page instead of ~22 MB.
 *
 * Maps are held in a `WeakMap` keyed by the canvas element, so a page that is
 * dropped takes its map with it without anyone having to remember.
 */

/** Canvas px per cell. 16 keeps a full-page map at ~22 KB. */
const BLOCK = 16;

/**
 * Sample stride inside a cell. A cell is a 4×4 grid of taps rather than all 256
 * pixels: this decides a light/dark threshold with a dead-band around it, so
 * the extra precision would not change a single answer, and the build stays
 * well under a millisecond.
 */
const STEP = 4;

/**
 * Side of the patch a sample averages over, in canvas px. Matches the patch the
 * old `getImageData` read, so the light/dark decisions come out the same.
 */
const PATCH = 28;

interface LuminanceMap {
  cols: number;
  rows: number;
  /** Where the raster sits on the canvas — `render()` centres it. */
  offsetX: number;
  offsetY: number;
  /** Row-major, one Rec.601 luma byte per cell. */
  cells: Uint8Array;
}

const maps = new WeakMap<HTMLCanvasElement, LuminanceMap>();

/**
 * Reduce a freshly rendered page raster to a luminance grid and attach it to
 * the canvas it was drawn on. Call this from the render path, with the same
 * `ImageData` and centring offsets that went to `putImageData`.
 *
 * @param data RGBA raster, as PDFium produced it
 * @param offsetX where the raster's left edge landed on the canvas
 * @param offsetY where the raster's top edge landed on the canvas
 */
export function buildLuminanceMap(
  canvas: HTMLCanvasElement,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): void {
  const cols = Math.max(1, Math.ceil(width / BLOCK));
  const rows = Math.max(1, Math.ceil(height / BLOCK));
  const cells = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    const yStart = cy * BLOCK;
    const yEnd = Math.min(yStart + BLOCK, height);
    for (let cx = 0; cx < cols; cx++) {
      const xStart = cx * BLOCK;
      const xEnd = Math.min(xStart + BLOCK, width);

      let sum = 0;
      let n = 0;
      for (let y = yStart; y < yEnd; y += STEP) {
        let i = (y * width + xStart) * 4;
        for (let x = xStart; x < xEnd; x += STEP, i += STEP * 4) {
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      cells[cy * cols + cx] = n ? sum / n : 0;
    }
  }

  maps.set(canvas, { cols, rows, offsetX, offsetY, cells });
}

/** Drop a canvas's map, when the page it belonged to is released. */
export function clearLuminanceMap(canvas: HTMLCanvasElement): void {
  maps.delete(canvas);
}

/**
 * Average luminance (0..1) of a `PATCH`-sized area of a rendered page, or null
 * when the page has no map — it has not rendered yet, or was released. Null is
 * a real answer, not a failure: an unrendered canvas shows the wallpaper
 * through it, so the caller should sample that instead.
 *
 * @param px @param py canvas image space, the coordinates `getImageData` took
 */
export function sampleLuminance(
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
): number | null {
  const map = maps.get(canvas);
  if (!map) return null;

  const { cols, rows, cells } = map;
  const rx = px - map.offsetX;
  const ry = py - map.offsetY;
  const half = PATCH / 2;

  // Clamped to the raster rather than to the canvas: where the canvas is wider
  // than the page it holds, the margin is cleared pixels, which on an
  // `alpha: false` context read back as black and would drag the average down.
  const c0 = clamp(Math.floor((rx - half) / BLOCK), 0, cols - 1);
  const c1 = clamp(Math.floor((rx + half) / BLOCK), 0, cols - 1);
  const r0 = clamp(Math.floor((ry - half) / BLOCK), 0, rows - 1);
  const r1 = clamp(Math.floor((ry + half) / BLOCK), 0, rows - 1);

  let sum = 0;
  let n = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      sum += cells[r * cols + c];
      n++;
    }
  }
  return sum / n / 255;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
