/**
 * The file menu's goo: button pill and menu card painted as ONE shape, traced
 * per animation frame from the same metaball field the old SVG filter drew,
 * and drawn with its shadows into a canvas.
 *
 * The look is a blur-threshold: each blob is Gaussian-blurred (σ = 3px), the
 * blurred alphas SUM, and everything above a threshold is solid. That sum is
 * what makes it goo — while the card fades in, its weak field adds to the
 * button's, so the button swells toward the card first and the card then
 * pops in already fused. A blurred edge is exactly Φ(-distance / σ), so the
 * field is computed analytically from each box's signed distance, weighted
 * by the blob's alpha, and its threshold contour traced into path data.
 *
 * Why not keep `filter: url(#goo)`: WebKit runs transform/opacity transitions
 * on the compositor, which lifts the animating card onto its own layer, and
 * a layer is outside the parent's url() filter (rendered on the CPU into the
 * parent's own backing store). So in Safari the card slid in unfused and only
 * joined the button once the transition ended. The menu content now rides
 * the same JS clock as the goo, so nothing animates on the compositor.
 *
 * Why a canvas and not an SVG path under a CSS drop-shadow(): when the path
 * changes, WebKit repaints only the path's old and new bounds, not the
 * filter's outsets around them, so the shadow of a shape that has shrunk or
 * gone stays on screen. A canvas is cleared and redrawn whole every frame,
 * shadows included, so there are no stale pixels to leave behind.
 */
import { fieldContourPath } from "./floating_toolbar/liquid_glass/metaball_path.js";

/** Canvas overhang past the stage on every side, px, so shadows of blobs
 *  touching the stage edge (the button sits in its corner) aren't clipped. */
const BLEED = 16;

/** Closed pose of the card, about its bottom-right corner:
 *  `scale(0.85) translate(8px, 16px)`. */
const CLOSED_SCALE = 0.85;
const CLOSED_DX = 8;
const CLOSED_DY = 16;

/** Blur radius of the goo, px (the old feGaussianBlur stdDeviation). Larger
 *  means a fatter bridge that reaches further before the card pops in. */
const GOO_SIGMA = 2;
/** Summed blurred alpha above which the goo is solid. The old color matrix
 *  mapped alpha to 20a − 15, whose half-opaque edge sits at a = 0.775. */
const GOO_THRESHOLD = 0.775;
/** Marching-squares pitch, px. */
const CELL = 2;
/** Scan margin around the blobs, px. The summed field can't reach the
 *  threshold further than ~σ / 3 outside a box; keep a few cells spare. */
const PAD = 3 * CELL + GOO_SIGMA;

/** Same timings as --transition-bounce and --transition-fast. */
const MOVE_MS = 300;
const FADE_MS = 150;
const bounce = cubicBezier(0.34, 1.56, 0.64, 1);
const ease = cubicBezier(0.25, 0.1, 0.25, 1);

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
}

/** A blob in the goo field: a rounded box at some alpha. */
export interface Blob {
  box: Box;
  /** Alpha, 0..1 — scales the blob's contribution to the field. */
  weight: number;
}

interface Channel {
  value: number;
  from: number;
  to: number;
  t0: number;
  ms: number;
  curve: (x: number) => number;
}

function channel(ms: number, curve: (x: number) => number): Channel {
  return { value: 0, from: 0, to: 0, t0: -Infinity, ms, curve };
}

/** One `--file-menu-goo-shadow-*` value: `<x> <y> <blur> <color>`, px. */
interface Shadow {
  x: number;
  y: number;
  blur: number;
  color: string;
}

export class FileMenuGoo {
  #layer: HTMLElement;
  #card: HTMLElement;
  #button: HTMLElement;
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  /** Last traced shape, kept so a theme change can repaint without a retrace. */
  #goo: { path: Path2D; x: number; y: number } | null = null;
  #reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /** Button pill alpha (hover). Bounce-timed like the old background fade;
   *  the overshoot is clamped, as a color channel would be. */
  #pill = channel(MOVE_MS, bounce);
  /** Card motion: 0 closed pose, 1 open; overshoots with the bounce. */
  #grow = channel(MOVE_MS, bounce);
  /** Card alpha, shared by the goo blob and the menu content. */
  #fade = channel(FADE_MS, ease);

  #raf = 0;
  #cardRest: Box | null = null;
  #buttonRest: Box | null = null;

  /**
   * @param layer Shadowed backdrop layer the shape is drawn into.
   * @param card The menu card; its transform and opacity are driven here.
   * @param button The menu button. Must share the card's offsetParent with `layer`.
   */
  constructor(layer: HTMLElement, card: HTMLElement, button: HTMLElement) {
    this.#layer = layer;
    this.#card = card;
    this.#button = button;

    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "file-menu-goo-canvas";
    this.#canvas.setAttribute("aria-hidden", "true");
    this.#canvas.style.left = this.#canvas.style.top = `${-BLEED}px`;
    this.#ctx = this.#canvas.getContext("2d")!;
    layer.appendChild(this.#canvas);

    // Fill and shadows come from CSS, and the night-mode switch lives inside
    // the open menu, so repaint when the body's theme class flips.
    new MutationObserver(() => this.#paint()).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    this.#render();
  }

  /** Show or hide the button's own pill (hover / menu open). */
  setActive(on: boolean) {
    this.#start([[this.#pill, on ? 1 : 0]]);
  }

  open() {
    this.#start([
      [this.#grow, 1],
      [this.#fade, 1],
    ]);
  }

  close() {
    this.#start([
      [this.#grow, 0],
      [this.#fade, 0],
    ]);
  }

  #start(targets: [Channel, number][]) {
    const now = performance.now();
    let changed = false;
    for (const [c, to] of targets) {
      if (c.to === to) continue;
      c.from = c.value;
      c.to = to;
      c.t0 = this.#reduceMotion.matches ? -Infinity : now;
      changed = true;
    }
    if (!changed) return;

    // Measured per transition: sizes only change between opens, and offset*
    // ignores the transform written below.
    this.#cardRest = boxOf(this.#card);
    this.#buttonRest = boxOf(this.#button);

    cancelAnimationFrame(this.#raf);
    // First frame synchronously, so the triggering event's frame shows it.
    this.#step(now);
  }

  #step = (now: number) => {
    let running = false;
    for (const c of [this.#pill, this.#grow, this.#fade]) {
      // rAF timestamps are frame start times and can predate t0.
      const p = Math.max(0, now - c.t0) / c.ms;
      c.value = c.from + (c.to - c.from) * c.curve(p);
      if (p < 1) running = true;
    }
    this.#render();
    this.#raf = running ? requestAnimationFrame(this.#step) : 0;
  };

  #render() {
    const g = this.#grow.value;
    const s = CLOSED_SCALE + (1 - CLOSED_SCALE) * g;
    const dx = CLOSED_DX * (1 - g);
    const dy = CLOSED_DY * (1 - g);
    this.#card.style.transform = `scale(${s}) translate(${dx}px, ${dy}px)`;
    this.#card.style.opacity = String(this.#fade.value);

    const blobs: Blob[] = [];
    const pill = clamp01(this.#pill.value);
    const fade = clamp01(this.#fade.value);
    if (pill > 0 && this.#buttonRest) {
      blobs.push({ box: this.#buttonRest, weight: pill });
    }
    if (fade > 0 && this.#cardRest) {
      // The card's transform (origin: bottom right) applied to its rest box.
      const rest = this.#cardRest;
      const x1 = rest.x1 + s * dx;
      const y1 = rest.y1 + s * dy;
      blobs.push({
        box: {
          x0: x1 - s * (rest.x1 - rest.x0),
          y0: y1 - s * (rest.y1 - rest.y0),
          x1,
          y1,
          r: s * rest.r,
        },
        weight: fade,
      });
    }

    const goo = traceGoo(blobs);
    this.#goo = goo && { path: new Path2D(goo.d), x: goo.x, y: goo.y };
    this.#paint();
  }

  /** Clear the whole canvas and draw the current shape with its shadows. */
  #paint() {
    const canvas = this.#canvas;
    if (!this.#goo) {
      // Nothing to show: drop the backing store (a zero-size canvas is blank).
      if (canvas.width) canvas.width = canvas.height = 0;
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cssW = this.#layer.clientWidth + 2 * BLEED;
    const cssH = this.#layer.clientHeight + 2 * BLEED;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; // also clears
      canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }

    const ctx = this.#ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const style = getComputedStyle(this.#layer);
    const read = (name: string) => style.getPropertyValue(name).trim();
    const shadows = [
      read("--file-menu-goo-shadow-1"),
      read("--file-menu-goo-shadow-2"),
    ]
      .map(parseShadow)
      .filter((sh): sh is Shadow => sh !== null);

    const { path, x, y } = this.#goo;
    ctx.setTransform(dpr, 0, 0, dpr, (x + BLEED) * dpr, (y + BLEED) * dpr);
    ctx.fillStyle = read("--file-menu-goo-fill") || "#f0f0f0";
    // Shadow offsets and blur ignore the transform: give them device pixels.
    // Painted last-listed first, so the first sits on top, as in a CSS
    // filter chain.
    for (const sh of shadows.reverse()) {
      ctx.shadowOffsetX = sh.x * dpr;
      ctx.shadowOffsetY = sh.y * dpr;
      ctx.shadowBlur = sh.blur * dpr;
      ctx.shadowColor = sh.color;
      ctx.fill(path);
    }
    ctx.shadowColor = "transparent";
    ctx.fill(path);
  }
}

/** Parse `<x> <y> <blur> <color>` (lengths in px); null if malformed. */
function parseShadow(value: string): Shadow | null {
  const m =
    /^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?\s+(.+)$/.exec(
      value,
    );
  if (!m) return null;
  return { x: +m[1], y: +m[2], blur: +m[3], color: m[4] };
}

/**
 * Trace the solid region of the blobs' summed, blurred field.
 * @returns Path data relative to (x, y), or null when nothing is solid.
 */
export function traceGoo(
  blobs: Blob[],
): { d: string; x: number; y: number } | null {
  // The field can't exceed the summed weights; below threshold, no goo.
  const live = blobs.filter((b) => b.weight > 0);
  if (live.reduce((sum, b) => sum + b.weight, 0) < GOO_THRESHOLD) return null;

  const x = Math.min(...live.map((b) => b.box.x0)) - PAD;
  const y = Math.min(...live.map((b) => b.box.y0)) - PAD;
  const w = Math.max(...live.map((b) => b.box.x1)) + PAD - x;
  const h = Math.max(...live.map((b) => b.box.y1)) + PAD - y;

  const fields = live.map((b) => ({
    sdf: roundedBoxSdf(b.box),
    weight: b.weight,
  }));
  const d = fieldContourPath(
    (px, py) => {
      let f = 0;
      for (const { sdf, weight } of fields) {
        f += weight * blurredEdge(sdf(px + x, py + y));
      }
      return GOO_THRESHOLD - f; // negative inside
    },
    w,
    CELL,
    h,
  );
  return d ? { d, x, y } : null;
}

/** Untransformed border box and corner radius, in offsetParent space. */
function boxOf(el: HTMLElement): Box {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return {
    x0: el.offsetLeft,
    y0: el.offsetTop,
    x1: el.offsetLeft + w,
    y1: el.offsetTop + h,
    r: Math.min(r, w / 2, h / 2),
  };
}

/** Exact signed distance to a rounded box; negative inside. */
function roundedBoxSdf(b: Box): (x: number, y: number) => number {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const hx = (b.x1 - b.x0) / 2 - b.r;
  const hy = (b.y1 - b.y0) / 2 - b.r;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    // sqrt, not Math.hypot: this runs ~25k times a frame and hypot is far
    // slower in JavaScriptCore.
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - b.r;
  };
}

/**
 * Alpha of a Gaussian-blurred solid edge at signed distance d: Φ(−d / σ).
 * Exact for straight edges, and the boxes' 16px corners are gentle enough
 * next to σ = 3 that the error there is invisible.
 */
function blurredEdge(d: number): number {
  const z = -d / GOO_SIGMA;
  if (z > 4) return 1;
  if (z < -4) return 0;
  return normalCdf(z);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** CSS `cubic-bezier()` as a function of progress; clamps outside [0, 1]. */
function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (x: number) => number {
  const curve = (p1: number, p2: number, t: number) => {
    const u = 1 - t;
    return 3 * p1 * u * u * t + 3 * p2 * u * t * t + t * t * t;
  };
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // x(t) is monotonic for x1, x2 in [0, 1], so bisection always converges.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (curve(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return curve(y1, y2, (lo + hi) / 2);
  };
}
