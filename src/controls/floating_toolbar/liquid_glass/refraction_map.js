/**
 * Physically-derived refraction displacement map for the liquid-glass ball,
 * after kube.io's "Liquid Glass in CSS (and SVG)"
 * (https://kube.io/blog/liquid-glass-css-svg/).
 *
 * A 1D bezel LUT is computed once: model the rim as a glass slab whose top
 * surface rises over a bezel band (height profiles below), shoot the
 * straight-down view ray through each point of the band, bend it with
 * Snell's law at the surface, and record how far sideways it has drifted by
 * the time it reaches the backdrop plane. The LUT is then splatted over the
 * shape's signed distance field into an RG-encoded displacement image
 * (R = x, G = y, 128 = neutral) consumed by an SVG <feDisplacementMap>
 * applied through `backdrop-filter: url(...)`.
 *
 * Chromium only: Safari and Firefox parse SVG url() in backdrop-filter but
 * paint nothing, so callers must gate on supportsSvgBackdropFilter() and
 * keep the plain blur stack as the cross-browser fallback.
 *
 * Pure math plus one canvas rasterization; no DOM state is kept here.
 */

/**
 * Bezel cross-sections, x = normalized distance from the silhouette edge
 * (0 = edge, 1 = interior end of the band), returning height 0..1.
 * Convex profiles end flat (zero displacement blends into the interior);
 * "concave" diverges at the interior junction — a harsher, hollow look.
 */
const PROFILES = {
  circle: (x) => Math.sqrt(1 - (1 - x) * (1 - x)),
  squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25),
  concave: (x) => 1 - Math.sqrt(Math.max(0, 1 - x * x)),
};

/**
 * SVG url() as backdrop-filter renders only in Chromium. CSS.supports() is
 * useless for this: non-Chromium browsers parse the value fine and then
 * silently paint nothing, so detect via UA-CH brands (present in every
 * Chromium, absent everywhere else).
 */
export function supportsSvgBackdropFilter() {
  return Array.isArray(navigator.userAgentData?.brands);
}

/**
 * Cubic (C2) polynomial smooth-min, matching the shader's smin() exactly —
 * the two must stay in lockstep or the refraction will disagree with the
 * body it is masked to. See glass_shaders.js for why the quadratic form
 * this replaces creased the rim at |a - b| = k.
 */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * h * k) / 6;
}

/**
 * SDF of the live goo (ball ∪ blob through the smooth-min) so the map can
 * be re-splatted per animation frame and ride the whole metaball — ball,
 * blob and bridge. At rest (blobR ≈ 0) this degenerates to the plain
 * ball circle.
 *
 * @param {ReturnType<import('./goo_state.js').GooState['sample']>} s
 * @returns {(x: number, y: number) => number}
 */
export function metaballSdf(s) {
  return (x, y) => {
    const d1 = Math.hypot(x - s.ballX, y - s.ballY) - s.ballR;
    const d2 = Math.hypot(x - s.blobX, y - s.blobY) - s.blobR;
    return smin(d1, d2, s.k);
  };
}

/**
 * Trace the bezel band and return displacement (px) per sample.
 *
 * @param {Object} opts
 * @param {string} opts.profile         Key into PROFILES.
 * @param {number} opts.bezelWidth      Band width inside the edge, px.
 * @param {number} opts.bezelHeight     Surface rise across the band, px.
 * @param {number} opts.thickness       Flat glass depth under the dome, px.
 * @param {number} opts.refractiveIndex n₂ of the glass (n₁ = 1, air).
 * @param {number} [opts.samples]
 * @returns {{lut: Float64Array, maxDisp: number}} Displacement is positive
 *   inward (convex profiles pull the backdrop toward the shape's center).
 */
export function buildBezelLUT({
  profile = "squircle",
  bezelWidth,
  bezelHeight,
  thickness,
  refractiveIndex = 1.5,
  samples = 128,
}) {
  const f = PROFILES[profile] ?? PROFILES.squircle;
  const eta = 1 / refractiveIndex; // entering the denser medium
  const lut = new Float64Array(samples);
  let maxDisp = 0;

  for (let i = 0; i < samples; i++) {
    const x = (i + 0.5) / samples;

    // Surface slope in px/px via central difference, clamped to the domain
    // (profile derivatives blow up at the endpoints). Cross-section axes:
    // s points inward from the edge, y up.
    const h = 1 / (samples * 2);
    const x0 = Math.max(0, x - h);
    const x1 = Math.min(1, x + h);
    const m = ((f(x1) - f(x0)) / (x1 - x0)) * (bezelHeight / bezelWidth);

    // Unit normal of y = height(s), pointing up and toward the edge.
    const inv = 1 / Math.hypot(m, 1);
    const nx = -m * inv;
    const ny = inv;

    // Snell: refract the view ray I = (0,-1) at the surface.
    const cosI = ny; // -dot(I, N)
    const k = 1 - eta * eta * (1 - cosI * cosI);
    if (k <= 0) continue; // unreachable entering denser glass; guard anyway
    const c = eta * cosI - Math.sqrt(k);
    const tx = c * nx;
    const ty = -eta + c * ny;

    // Sideways drift while traveling down to the backdrop plane.
    const depth = bezelHeight * f(x) + thickness;
    lut[i] = (tx * depth) / -ty;
    maxDisp = Math.max(maxDisp, Math.abs(lut[i]));
  }

  return { lut, maxDisp };
}

/**
 * Slack outside the SDF edge, px: the mask edge is anti-aliased, so its
 * outermost partially-covered pixels sit at slightly positive distance.
 * They get the edge (max) displacement instead of staying neutral, so the
 * refraction reaches all the way into the silhouette's AA fringe. The
 * mask hides the rest of the slack band.
 */
const CLIP_SLACK = 3;

/** Half-width of the mask edge anti-aliasing ramp, px. */
const MASK_AA = 0.75;

/** Linear interpolation over the LUT, t in [0, 1]. */
function sampleLut(lut, t) {
  const pos = Math.min(Math.max(t, 0), 1) * (lut.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(i + 1, lut.length - 1);
  return lut[i] + (lut[j] - lut[i]) * (pos - i);
}

/**
 * Rasterize the displacement field over an arbitrary SDF. Pixels beyond
 * the edge slack or deeper than the bezel band stay neutral (128, 128);
 * inside the band the vector is LUT(distance) along the inward SDF
 * gradient, encoded as channel = 128 + 127 * component / maxDisp. With
 * bezelWidth equal to the shape's inradius the band covers the whole
 * interior — a full dome, nothing left flat.
 *
 * The blue channel carries the field's AA'd body coverage. The SVG filter
 * lifts it into an alpha mask for its own output, which replaces the CSS
 * clip-path: the visible silhouette is then exactly this field, so the
 * refraction can never disagree with the goo shape it is applied to.
 *
 * Pure — exported separately from the canvas step so it can be unit-tested
 * outside the browser.
 *
 * @param {Object} opts
 * @param {number} opts.cssSize          Square map size, CSS px.
 * @param {number} opts.res              Raster pixels per CSS px.
 * @param {(x: number, y: number) => number} opts.sdf Signed distance, CSS
 *   px, y-down, negative inside.
 * @param {Float64Array} opts.lut
 * @param {number} opts.maxDisp
 * @param {number} opts.bezelWidth
 * @param {Uint8ClampedArray} [opts.out] Reused output buffer (every pixel
 *   is overwritten). Allocated fresh when omitted.
 * @returns {Uint8ClampedArray} RGBA, row-major.
 */
export function computeDisplacementField({
  cssSize,
  res,
  sdf,
  lut,
  maxDisp,
  bezelWidth,
  out,
}) {
  const px = Math.round(cssSize * res);
  const data = out ?? new Uint8ClampedArray(px * px * 4);

  for (let yi = 0; yi < px; yi++) {
    const y = (yi + 0.5) / res;
    for (let xi = 0; xi < px; xi++) {
      const x = (xi + 0.5) / res;
      const o = (yi * px + xi) * 4;
      let r = 128;
      let g = 128;

      // The raw smooth-min is not a Euclidean distance — |grad| sags to
      // ~0.78 over a stretched bridge — so `d` under-reports depth there
      // and would widen the bezel band (and the mask's AA ramp) by 1/|grad|
      // exactly over the bridge. `dn` is the gradient-normalized distance;
      // it is what gets spent in px below.
      const d = sdf(x, y);
      let dn = d;
      // Cheap prefilter on the raw distance. |grad| <= 1, so d >= CLIP_SLACK
      // implies dn >= CLIP_SLACK and d <= -bezelWidth implies
      // dn <= -bezelWidth: no pixel that matters is skipped, and the
      // gradient (4 extra sdf calls) stays confined to the band as before.
      if (d < CLIP_SLACK && d > -bezelWidth) {
        // Inward direction = negative SDF gradient (numeric, y-down).
        // Sampled over a 1px span, so len is |grad| directly.
        const e = 0.5;
        const gx = sdf(x + e, y) - sdf(x - e, y);
        const gy = sdf(x, y + e) - sdf(x, y - e);
        const len = Math.hypot(gx, gy);
        if (len > 1e-6) {
          dn = d / len;
          if (dn < CLIP_SLACK && dn > -bezelWidth) {
            const disp = sampleLut(lut, -dn / bezelWidth);
            const s = (127 * disp) / (len * maxDisp);
            r = 128 - gx * s;
            g = 128 - gy * s;
          }
        }
      }

      data[o] = r;
      data[o + 1] = g;
      // Outside the prefilter dn === d, but the ramp is saturated there
      // either way (|d| far exceeds MASK_AA), so the mask is unaffected.
      data[o + 2] = 255 * Math.min(Math.max(0.5 - dn / (2 * MASK_AA), 0), 1);
      data[o + 3] = 255;
    }
  }

  return data;
}

/**
 * Rasterization targets reused across frames, keyed by pixel size (the two
 * res tiers alternate). Allocating a fresh canvas + ImageData per animated
 * frame churns tens of MB/s of garbage during a drag, and the eventual
 * major GC lands as a visible frame drop mid-interaction.
 * @type {Map<number, {canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, image: ImageData}>}
 */
const _scratch = new Map();

function scratchFor(px) {
  let s = _scratch.get(px);
  if (!s) {
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    s = {
      canvas,
      ctx: canvas.getContext("2d"),
      image: new ImageData(px, px),
    };
    _scratch.set(px, s);
  }
  return s;
}

/**
 * Field → PNG data URL + the feDisplacementMap scale that restores px units
 * (the filter shifts by scale * (channel/255 - 0.5), channels hold
 * component * 127 / maxDisp).
 *
 * @param {Parameters<typeof computeDisplacementField>[0]} opts `res`
 *   defaults to 2 for a crisp map on retina displays.
 * @returns {{url: string, scale: number} | null} null when the LUT is
 *   degenerate (zero displacement everywhere).
 */
export function renderDisplacementMap(opts) {
  const { cssSize, maxDisp, res = 2 } = opts;
  if (!(maxDisp > 0)) return null;

  const px = Math.round(cssSize * res);
  const { canvas, ctx, image } = scratchFor(px);
  computeDisplacementField({ ...opts, res, out: image.data });
  ctx.putImageData(image, 0, 0);

  return {
    url: canvas.toDataURL("image/png"),
    scale: (maxDisp * 255) / 127,
  };
}
