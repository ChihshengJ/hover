/**
 * Darkens anti-aliased glyph edges inside a page's text boxes so text matches
 * macOS's native weight. See docs/text_rendering.md §6.
 */

const GAMMA = 1.5;

/** Coverage index (0..255) to darkened coverage (0..1). */
const CURVE = new Float32Array(256);
for (let k = 0; k < 256; k++) {
  CURVE[k] = 1 - (1 - k / 255) ** GAMMA;
}

/** Min text/background RGB distance for a box to be curved. */
const MIN_CONTRAST = 32;

/** Max RGB distance off the background→text line for a pixel to count as an edge. */
const OFF_LINE = 12;

/** On for macOS only. */
export const TEXT_GAMMA_ENABLED = isMac();

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.userAgentData?.platform ?? navigator.platform;
  return /mac/i.test(platform ?? "");
}

/** Raster px added around each box for anti-aliasing bleed. */
const PAD = 1;

/** Pixels already curved this call, shared across calls to avoid reallocating. */
let done = new Uint8Array(0);

/** Where the whole page lies in the raster, in raster px. */
export interface PagePlacement {
  /** Negative when the raster is a crop of the page. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Applies the curve in place to the text in an RGBA raster.
 *
 * @param boxes from PDFDocumentModel#getPageTextBoxes
 * @param page defaults to the raster being the whole page
 */
export function applyTextGamma(
  pixels: Uint8ClampedArray | Uint8Array,
  rasterWidth: number,
  rasterHeight: number,
  boxes: Float32Array,
  page: PagePlacement = {
    x: 0,
    y: 0,
    width: rasterWidth,
    height: rasterHeight,
  },
): void {
  const n = rasterWidth * rasterHeight;
  if (done.length < n) done = new Uint8Array(n);

  const touched: number[] = [];
  for (let i = 0; i + 3 < boxes.length; i += 4) {
    const x0 = Math.max(0, Math.floor(page.x + boxes[i] * page.width) - PAD);
    const y0 = Math.max(
      0,
      Math.floor(page.y + boxes[i + 1] * page.height) - PAD,
    );
    const x1 = Math.min(
      rasterWidth,
      Math.ceil(page.x + boxes[i + 2] * page.width) + PAD,
    );
    const y1 = Math.min(
      rasterHeight,
      Math.ceil(page.y + boxes[i + 3] * page.height) + PAD,
    );
    if (x0 >= x1 || y0 >= y1) continue;
    touched.push(x0, y0, x1, y1);
    curveBox(pixels, rasterWidth, x0, y0, x1, y1);
  }

  // Reset only what was marked; the buffer is shared across calls.
  for (let i = 0; i < touched.length; i += 4) {
    for (let y = touched[i + 1]; y < touched[i + 3]; y++) {
      const row = y * rasterWidth;
      done.fill(0, row + touched[i], row + touched[i + 2]);
    }
  }
}

/** One box, in raster px, end-exclusive. */
function curveBox(
  pixels: Uint8ClampedArray | Uint8Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  // Background: the commonest colour on the box's border.
  const counts = new Map<number, number>();
  let bgKey = 0;
  let bgCount = 0;
  const vote = (p: number) => {
    const o = p * 4;
    const key = (pixels[o] << 16) | (pixels[o + 1] << 8) | pixels[o + 2];
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    if (c > bgCount) {
      bgCount = c;
      bgKey = key;
    }
  };
  for (let x = x0; x < x1; x++) {
    vote(y0 * w + x);
    vote((y1 - 1) * w + x);
  }
  for (let y = y0 + 1; y < y1 - 1; y++) {
    vote(y * w + x0);
    vote(y * w + x1 - 1);
  }
  const br = bgKey >> 16;
  const bgG = (bgKey >> 8) & 255;
  const bb = bgKey & 255;

  // Text colour: the pixel furthest from the background.
  let fr = br;
  let fg = bgG;
  let fb = bb;
  let far = 0;
  for (let y = y0; y < y1; y++) {
    for (let p = y * w + x0; p < y * w + x1; p++) {
      const o = p * 4;
      const dr = pixels[o] - br;
      const dg = pixels[o + 1] - bgG;
      const db = pixels[o + 2] - bb;
      const d = dr * dr + dg * dg + db * db;
      if (d > far) {
        far = d;
        fr = pixels[o];
        fg = pixels[o + 1];
        fb = pixels[o + 2];
      }
    }
  }
  if (far < MIN_CONTRAST * MIN_CONTRAST) return;

  const tr = fr - br;
  const tg = fg - bgG;
  const tb = fb - bb;
  for (let y = y0; y < y1; y++) {
    for (let p = y * w + x0; p < y * w + x1; p++) {
      if (done[p]) continue;
      done[p] = 1;
      const o = p * 4;
      const dr = pixels[o] - br;
      const dg = pixels[o + 1] - bgG;
      const db = pixels[o + 2] - bb;
      // Coverage: the pixel's position along background → text.
      const t = (dr * tr + dg * tg + db * tb) / far;
      if (t <= 0 || t >= 1) continue;
      const er = dr - t * tr;
      const eg = dg - t * tg;
      const eb = db - t * tb;
      if (er * er + eg * eg + eb * eb > OFF_LINE * OFF_LINE) continue;
      const c = CURVE[Math.round(t * 255)];
      pixels[o] = br + c * tr;
      pixels[o + 1] = bgG + c * tg;
      pixels[o + 2] = bb + c * tb;
    }
  }
}
