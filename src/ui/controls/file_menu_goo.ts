/**
 * The file menu's goo: button and menu card painted as ONE path, the
 * smooth-min union of two rounded boxes, re-traced on every animation frame.
 *
 * This replaces a `filter: url(#goo)` blur-threshold over two CSS-animated
 * blobs. That broke in Safari: WebKit runs transform/opacity transitions on
 * the compositor, which lifts the animating card blob onto its own layer, and
 * a layer is outside the parent's url() filter (rendered on the CPU into the
 * parent's own backing store). So the card slid in unfused and only joined the
 * button once the transition ended and the layer was flattened back.
 *
 * Here nothing under a filter ever animates on the compositor: the shape is
 * plain path data, the shadow is a CSS drop-shadow() on a static element, and
 * the menu content is moved by the same clock, so card and goo can't drift.
 */
import { fieldContourPath } from "./floating_toolbar/liquid_glass/metaball_path.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Closed pose of the card, about its bottom-right corner:
 *  `scale(0.85) translate(8px, 16px)`. */
const CLOSED_SCALE = 0.85;
const CLOSED_DX = 8;
const CLOSED_DY = 16;

/** Smooth-min width, px. The web where card meets button has a radius of
 *  about 0.4 × this. */
const GOO_K = 12;
/** Marching-squares pitch, px. Crossings are interpolated on an exact
 *  distance field, so the outline error is far below a pixel. */
const CELL = 2;
/** Scan margin around the union, px. Must exceed GOO_K / 6 + CELL. */
const PAD = 3 * CELL + GOO_K / 6;

/** Same timings as --transition-bounce and --transition-fast. */
const MOVE_MS = 300;
const FADE_MS = 150;
const bounce = cubicBezier(0.34, 1.56, 0.64, 1);
const ease = cubicBezier(0.25, 0.1, 0.25, 1);

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
}

/** Layout of the card and button at rest, in the shared positioned parent. */
interface Geometry {
  card: Box;
  button: Box;
}

export class FileMenuGoo {
  #card: HTMLElement;
  #button: HTMLElement;
  #path: SVGPathElement;
  #reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /** Card motion progress: 0 closed, 1 open; overshoots with the bounce. */
  #grow = 0;
  /** Card opacity. */
  #alpha = 0;
  #from = { grow: 0, alpha: 0 };
  #target = 0;
  #t0 = 0;
  #raf = 0;
  #geom: Geometry | null = null;

  /**
   * @param layer Shadowed backdrop layer the shape is drawn into.
   * @param card The menu card; its transform and opacity are driven here.
   * @param button The menu button. Must share the card's offsetParent with `layer`.
   */
  constructor(layer: HTMLElement, card: HTMLElement, button: HTMLElement) {
    this.#card = card;
    this.#button = button;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("file-menu-goo-shape");
    svg.setAttribute("aria-hidden", "true");
    this.#path = document.createElementNS(SVG_NS, "path");
    svg.appendChild(this.#path);
    layer.appendChild(svg);

    this.#render();
  }

  open() {
    this.#animateTo(1);
  }

  close() {
    this.#animateTo(0);
  }

  #animateTo(target: number) {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    // Measured once per transition: the card's size can only change between
    // opens, and offset* ignores the transform we are about to write.
    this.#geom = this.#measure();
    this.#target = target;
    this.#from = { grow: this.#grow, alpha: this.#alpha };

    if (this.#reduceMotion.matches) {
      this.#grow = this.#alpha = target;
      this.#render();
      return;
    }
    this.#t0 = performance.now();
    // First frame synchronously, so the click's own frame already shows it.
    this.#step(this.#t0);
  }

  #step = (now: number) => {
    // rAF timestamps are frame start times and can predate #t0.
    const t = Math.max(0, now - this.#t0);
    const { grow, alpha } = this.#from;
    this.#grow = grow + (this.#target - grow) * bounce(t / MOVE_MS);
    this.#alpha = alpha + (this.#target - alpha) * ease(t / FADE_MS);
    this.#render();
    this.#raf = t < MOVE_MS ? requestAnimationFrame(this.#step) : 0;
  };

  #render() {
    const g = this.#grow;
    const s = CLOSED_SCALE + (1 - CLOSED_SCALE) * g;
    const dx = CLOSED_DX * (1 - g);
    const dy = CLOSED_DY * (1 - g);
    this.#card.style.transform = `scale(${s}) translate(${dx}px, ${dy}px)`;
    this.#card.style.opacity = String(this.#alpha);

    if (this.#alpha <= 0 || !this.#geom) {
      this.#path.removeAttribute("d");
      return;
    }

    // Apply the card's transform (origin: bottom right) to its resting box.
    const { card: rest, button } = this.#geom;
    const x1 = rest.x1 + s * dx;
    const y1 = rest.y1 + s * dy;
    const card: Box = {
      x0: x1 - s * (rest.x1 - rest.x0),
      y0: y1 - s * (rest.y1 - rest.y0),
      x1,
      y1,
      r: s * rest.r,
    };

    const minX = Math.min(card.x0, button.x0) - PAD;
    const minY = Math.min(card.y0, button.y0) - PAD;
    const maxX = Math.max(card.x1, button.x1) + PAD;
    const maxY = Math.max(card.y1, button.y1) + PAD;
    const dCard = roundedBoxSdf(card);
    const dButton = roundedBoxSdf(button);
    const d = fieldContourPath(
      (x, y) => smin(dCard(x + minX, y + minY), dButton(x + minX, y + minY), GOO_K),
      maxX - minX,
      CELL,
      maxY - minY,
    );

    this.#path.setAttribute("d", d);
    this.#path.setAttribute("transform", `translate(${minX} ${minY})`);
    this.#path.style.fillOpacity = String(Math.min(1, this.#alpha));
  }

  #measure(): Geometry {
    return { card: boxOf(this.#card), button: boxOf(this.#button) };
  }
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
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) -
      b.r
    );
  };
}

/** Cubic polynomial smooth-min: the union, with a web of width ~k where the
 *  two shapes meet. Never pushes the outline out by more than k / 6. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * h * k) / 6;
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
