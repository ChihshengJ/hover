/**
 * GlassEffect — controller for the liquid-glass rendering of the floating
 * ball. Owned by the FloatingToolbar facade; fed pointer/drag events by the
 * DragController (all calls are no-ops while disabled).
 *
 * Two layers are inserted into the goo container when enabled:
 *   1. `.glass-backdrop` — a div carrying the native backdrop-filter blur.
 *      This is what makes the glass "see" the live page behind it (PDF
 *      canvases, night mode inversion and all) without any texture capture.
 *      On Chromium the frost is routed through an SVG feDisplacementMap
 *      filter that adds physically-derived refraction and masks itself to
 *      the smooth-min field (see refraction_map.js); elsewhere it is
 *      clipped per frame to the analytic Bézier metaball outline.
 *   2. `.glass-canvas`  — the WebGL2 pass drawing silhouette tint, the lit
 *      edge rim and drop shadow from the same two-circle field (see
 *      glass_shaders.js).
 *
 * Rendering is on-demand: a rAF loop runs only while the goo physics are
 * unsettled (drag, spring return, click impulse); idle cost is one cached
 * frame and a static circular clip.
 *
 * The SVG #goo path is untouched — toggling this feature off restores the
 * original implementation (CSS switches on wrapper[data-glass]).
 */

import { Config } from "../../../settings/config.js";
import { GooState } from "./goo_state.js";
import { GlowState } from "./glow_state.js";
import { GlassRenderer } from "./glass_renderer.js";
import { fieldContourPath, circlePath } from "./metaball_path.js";
import {
  buildBezelLUT,
  metaballSdf,
  renderDisplacementMap,
  supportsSvgBackdropFilter,
} from "./refraction_map.js";

/** Goo container CSS size, px (see .goo-container). */
const CONTAINER_SIZE = 80;
/** Layer overdraw margin around the container, px (see .glass-backdrop/.glass-canvas inset). */
const MARGIN = 60;
/** Visible ball radius, px — matches the SVG path's 70px gradient body. */
const BALL_R = 35;
/**
 * Pointer-normalization padding used by DragController.#computeGooPosition.
 * Normalized coords (0–100) span the container rect expanded by this much
 * on each side; keep in sync with the `padding` constant there.
 */
const EXPANDED_PAD = 45;

/** Night-mode glass tint when the user's ball style doesn't persist. Tunable. */
const NIGHT_TINT_A = [0.6, 0.64, 0.69];
const NIGHT_TINT_B = [0.23, 0.25, 0.28];
const NIGHT_GRAD_DEG = 140;

/**
 * Rim-refraction knobs (Chromium only; see refraction_map.js for the
 * physics). The bezel LUT (the expensive Snell trace) is fixed; every
 * animation frame re-splats it over the live metaball SDF, so the
 * refraction rides the whole goo — ball, blob and bridge.
 * All lengths are CSS px. Tunable.
 */
const REFRACTION = {
  // Height cross-section: "circle" | "squircle" | "concave". "circle" curves
  // all the way to the center; "squircle" flattens past the outer ~15% of
  // the band, which leaves everything deeper (the bridge!) unrefracted.
  profile: "circle",
  // Band that bends light, measured inward from the silhouette. At BALL_R
  // the dome spans the whole goo — ball, blob and the bridge saddle all
  // refract as one liquid body. Shrink it for a flat-topped, rim-only look.
  bezelWidth: 25,
  bezelHeight: 15, // surface rise across the band — steeper = stronger bend
  thickness: 25, // flat glass depth under the dome — amplifies the bend
  refractiveIndex: 2, // 1.5 ≈ glass, 1.33 ≈ water; higher = stronger
  frostBlur: 0, // baked into the SVG filter; mirror the CSS fallback
  frostSaturate: 2, // (blur(2px) saturate(150%)) when changing these
};
const REFRACTION_FILTER_ID = "hover-glass-refraction";

export class GlassEffect {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.wrapper      Toolbar wrapper — carries data-glass.
   * @param {HTMLElement} opts.gooContainer Host for the glass layers.
   * @param {HTMLElement} opts.ball         Top hit layer — source of hover events.
   */
  constructor({ wrapper, gooContainer, ball }) {
    this.wrapper = wrapper;
    this.gooContainer = gooContainer;
    this.ball = ball;
    this.enabled = false;

    this.backdrop = null;
    this.canvas = null;
    this.renderer = null;
    this.refractionSvg = null;
    this.refraction = null;
    this.rafId = null;
    this.lastT = 0;
    this.lastClip = "";

    // Adaptive page-number color (see #updateTextColor). Null until the first
    // sample; then true = light text, false = dark. Hysteresis holds the last
    // decision so scrolling past mixed content doesn't flicker it.
    this.pageDisplay = null;
    this.textLight = null;
    this.lastSampleX = null;
    this.lastSampleY = null;

    const c = CONTAINER_SIZE / 2 + MARGIN;
    this.state = new GooState({ cx: c, cy: c, ballR: BALL_R });
    this.glow = new GlowState({ cx: c, cy: c });

    // Hover glow is self-contained here (DragController is untouched): the
    // ball is the top hit layer, so it sees pointer moves both while merely
    // hovering and — via pointer capture — throughout a drag.
    this._onHoverMove = (e) => {
      this.#setGlowFromClient(e.clientX, e.clientY);
      this.glow.setHovering(true);
      this.#wake();
    };
    this._onHoverEnter = () => {
      this.glow.setHovering(true);
      this.#wake();
    };
    this._onHoverLeave = () => {
      this.glow.setHovering(false);
      this.#wake();
    };

    this.style = {
      tintA: [1, 1, 1],
      tintB: [0.75, 0.75, 0.75],
      grad: [0.87, 0.5],
      night: 0,
    };

    // Restyle on night-mode / ball-night-persist class flips and on ball
    // gradient edits; both only cost one re-render.
    this._bodyObserver = new MutationObserver(() => this.#refreshStyle());
    this._unsubBallStyle = Config.subscribe("ball_style", () =>
      this.#refreshStyle(),
    );
    // The page number reads its color from the wallpaper where the ball floats
    // over the page margin, so recolor when the wallpaper changes. The applied
    // image lands in body's inline style (WallpaperManager sets
    // body.style.backgroundImage), which happens *after* the wallpaper_meta
    // config write — so watch the DOM directly rather than the config event,
    // and dedupe on the background-image value so unrelated inline-style
    // changes (e.g. the drag cursor) don't trigger a resample. A second pass
    // fires via onWallpaperReady once the new image has decoded.
    this._lastBg = "";
    this._wallpaperObserver = new MutationObserver(() => {
      const bg = document.body.style.backgroundImage;
      if (bg === this._lastBg) return;
      this._lastBg = bg;
      this.refreshTextColor();
    });
    this._unsubWallpaperReady = onWallpaperReady(() => this.refreshTextColor());
  }

  // ╍╍╍ Lifecycle ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /** @param {boolean} on */
  setEnabled(on) {
    if (on === this.enabled) return;
    if (on) {
      if (!this.#mount()) return; // WebGL2 unavailable — stay on SVG goo
      this.enabled = true;
      this.wrapper.dataset.glass = "on";
      this._bodyObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
      });
      this._lastBg = document.body.style.backgroundImage;
      this._wallpaperObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["style"],
      });
      this.#refreshStyle();
    } else {
      this.enabled = false;
      delete this.wrapper.dataset.glass;
      this._bodyObserver.disconnect();
      this._wallpaperObserver.disconnect();
      this.#unmount();
    }
  }

  #mount() {
    this.pageDisplay = this.gooContainer.querySelector(".page-display");

    this.backdrop = document.createElement("div");
    this.backdrop.className = "glass-backdrop";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "glass-canvas";

    this.gooContainer.prepend(this.canvas);
    this.gooContainer.prepend(this.backdrop);

    this.renderer = new GlassRenderer(this.canvas, () => this.#renderFrame());
    if (!this.renderer.init()) {
      console.warn("[hover] WebGL2 unavailable — liquid glass disabled");
      this.#unmount();
      return false;
    }
    const size = CONTAINER_SIZE + MARGIN * 2;
    this.renderer.resize(size, size, window.devicePixelRatio || 1);
    this.#mountRefraction(size);

    this.ball?.addEventListener("pointermove", this._onHoverMove);
    this.ball?.addEventListener("pointerenter", this._onHoverEnter);
    this.ball?.addEventListener("pointerleave", this._onHoverLeave);

    this.#renderFrame();
    return true;
  }

  /**
   * Chromium-only rim refraction: swap the backdrop's plain frost for an
   * SVG filter (feImage displacement map → feDisplacementMap → blur →
   * saturate), activated by data-glass-refract in liquid_glass.css.
   *
   * Only the shell is built here; the map itself is (re)splatted by
   * #renderFrame from the live metaball SDF, so the refraction follows
   * the goo. The LUT never changes, so neither does the filter's scale.
   */
  #mountRefraction(size) {
    if (!supportsSvgBackdropFilter()) return;

    const { lut, maxDisp } = buildBezelLUT(REFRACTION);
    if (!(maxDisp > 0)) return;

    // Same hidden-svg pattern as toolbar_dom's #goo filter. The explicit
    // userSpaceOnUse region pins the feImage to the backdrop div's fixed
    // 200×200 border box; sRGB interpolation keeps the encoded vectors
    // from being remapped to linear light.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    // The map's blue channel holds the field's body coverage; the second
    // feColorMatrix lifts it into alpha and the feComposite masks the
    // filter's own output with it. That mask — not the Bézier clip-path —
    // defines the visible silhouette in refract mode, so the frost can
    // never extend past (or fall short of) the refracting field.
    svg.innerHTML = `
      <defs>
        <filter id="${REFRACTION_FILTER_ID}" x="0" y="0" width="${size}" height="${size}"
                filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feImage x="0" y="0" width="${size}" height="${size}" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="0"
                             xChannelSelector="R" yChannelSelector="G" result="refracted" />
          <feGaussianBlur in="refracted" stdDeviation="${REFRACTION.frostBlur}" result="frosted" />
          <feColorMatrix in="frosted" type="saturate" values="${REFRACTION.frostSaturate}" result="tinted" />
          <feColorMatrix in="map" type="matrix"
                         values="0 0 0 0 0
                                 0 0 0 0 0
                                 0 0 0 0 0
                                 0 0 1 0 0" result="mask" />
          <feComposite in="tinted" in2="mask" operator="in" />
        </filter>
      </defs>
    `;
    document.body.appendChild(svg);
    this.refractionSvg = svg;
    this.refraction = {
      lut,
      maxDisp,
      size,
      feImage: svg.querySelector("feImage"),
      feDisp: svg.querySelector("feDisplacementMap"),
      sig: "",
      scaleSet: false,
    };
    this.wrapper.dataset.glassRefract = "on";
  }

  /**
   * Re-splat the LUT over the current goo shape when it changed. Runs at
   * 1× map resolution while the rAF loop is live (the encode cost is paid
   * per animation frame) and 2× for the crisp resting frame.
   * @param {ReturnType<import('./goo_state.js').GooState['sample']>} s
   */
  #updateRefractionMap(s) {
    const r = this.refraction;
    const sig =
      `${this.rafId !== null ? 1 : 2}:` +
      [s.ballR, s.blobX, s.blobY, s.blobR].map((v) => v.toFixed(1)).join();
    if (sig === r.sig) return;
    r.sig = sig;

    const map = renderDisplacementMap({
      cssSize: r.size,
      res: this.rafId !== null ? 1 : 2,
      sdf: metaballSdf(s),
      lut: r.lut,
      maxDisp: r.maxDisp,
      bezelWidth: REFRACTION.bezelWidth,
    });
    r.feImage.setAttribute("href", map.url);
    if (!r.scaleSet) {
      r.scaleSet = true;
      r.feDisp.setAttribute("scale", map.scale);
    }
  }

  #unmount() {
    this.#stopLoop();
    this.ball?.removeEventListener("pointermove", this._onHoverMove);
    this.ball?.removeEventListener("pointerenter", this._onHoverEnter);
    this.ball?.removeEventListener("pointerleave", this._onHoverLeave);
    this.glow.setHovering(false);
    this.glow.setPressed(false);
    this.renderer?.destroy();
    this.renderer = null;
    this.backdrop?.remove();
    this.canvas?.remove();
    this.backdrop = null;
    this.canvas = null;
    this.refractionSvg?.remove();
    this.refractionSvg = null;
    this.refraction = null;
    delete this.wrapper.dataset.glassRefract;
    delete this.wrapper.dataset.glassText;
    this.pageDisplay = null;
    this.textLight = null;
    this.lastSampleX = null;
    this.lastSampleY = null;
    this.lastClip = "";
  }

  /** Re-check devicePixelRatio (window moved across displays, zoom). */
  handleResize() {
    if (!this.enabled) return;
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.renderer.dpr) {
      const size = CONTAINER_SIZE + MARGIN * 2;
      this.renderer.resize(size, size, dpr);
    }
    this.#renderFrame();
  }

  destroy() {
    this.setEnabled(false);
    this._unsubBallStyle();
    this._unsubWallpaperReady();
  }

  // ╍╍╍ DragController / facade hooks ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Pointer position in DragController's normalized goo space (0–100 over
   * the container rect expanded by EXPANDED_PAD on each side).
   */
  onPointer(nx, ny) {
    if (!this.enabled) return;
    const span = CONTAINER_SIZE + EXPANDED_PAD * 2;
    this.state.setTarget(
      (nx / 100) * span - EXPANDED_PAD + MARGIN,
      (ny / 100) * span - EXPANDED_PAD + MARGIN,
    );
  }

  /**
   * Map a viewport point to the glow's canvas-local px space (origin at the
   * layer's top-left, i.e. the container inset by MARGIN). The scale factor
   * absorbs page zoom; a drag translateX shifts rect and clientX together.
   */
  #setGlowFromClient(clientX, clientY) {
    const rect = this.gooContainer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (clientX - rect.left) * (CONTAINER_SIZE / rect.width) + MARGIN;
    const y = (clientY - rect.top) * (CONTAINER_SIZE / rect.height) + MARGIN;
    this.glow.setTarget(x, y);
  }

  onDragStart() {
    if (!this.enabled) return;
    this.state.setDragging(true);
    this.glow.setPressed(true);
    this.#wake();
  }

  onDragEnd() {
    if (!this.enabled) return;
    this.state.setDragging(false);
    this.glow.setPressed(false);
    this.#wake();
  }

  /** Click bounce. */
  pulse() {
    if (!this.enabled) return;
    this.state.pulse();
    this.#wake();
  }

  // ╍╍╍ Render loop ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  #wake() {
    if (this.rafId !== null) return;
    this.lastT = performance.now();
    const tick = (now) => {
      const dt = (now - this.lastT) / 1000;
      this.lastT = now;
      this.state.step(dt);
      // Leash the press glow to the live lag blob so it rides the dragged
      // secondary circle, not the fixed main ball.
      this.glow.setLeash(this.state.blobX, this.state.blobY, this.state.blobR);
      this.glow.step(dt);
      this.#renderFrame();
      if (this.state.isSettled() && this.glow.isSettled()) {
        this.rafId = null;
        // One extra frame outside the loop re-splats the refraction map
        // at resting resolution (the in-loop frames run at 1×).
        this.#renderFrame();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  #stopLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** One frame: WebGL pass + backdrop shaping + refraction map. DOM writes only. */
  #renderFrame() {
    if (!this.renderer) return;
    const s = this.state.sample();
    this.renderer.render(s, this.style, this.glow.sample());
    this.#updateTextColor(false);

    if (this.refraction) {
      // Refract mode: the filter masks its own output with the field's
      // coverage (map blue channel), so no clip-path — the Bézier outline
      // and the smooth-min field disagree at the bridge taper, and a clip
      // would carve refraction-free slivers out of the silhouette.
      this.#updateRefractionMap(s);
      return;
    }

    // Fallback frost shaping: trace the clip from the same smooth-min
    // field the shader draws, so the taper gets frosted too (an analytic
    // outline would disagree with the field exactly there).
    const clip =
      s.blobR < 0.5
        ? circlePath(s.ballX, s.ballY, s.ballR)
        : fieldContourPath(metaballSdf(s), CONTAINER_SIZE + MARGIN * 2);
    if (clip !== this.lastClip) {
      this.lastClip = clip;
      this.backdrop.style.clipPath = `path("${clip}")`;
    }
  }

  // ╍╍╍ Style uniforms ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /** Recompute tint/night uniforms from body classes + ball_style config. */
  #refreshStyle() {
    if (!this.enabled) return;
    const body = document.body;
    const night = body.classList.contains("night-mode");
    const useNightDefault =
      night && !body.classList.contains("ball-night-persist");

    if (useNightDefault) {
      this.style = {
        tintA: NIGHT_TINT_A,
        tintB: NIGHT_TINT_B,
        grad: gradDirVector(NIGHT_GRAD_DEG),
        night: 1,
      };
    } else {
      const { gradient } = Config.get("ball_style");
      const stops = [...gradient.stops].sort((a, b) => a.position - b.position);
      this.style = {
        tintA: hexToRgb01(stops[0]?.color || "#ffffff"),
        tintB: hexToRgb01(stops[stops.length - 1]?.color || "#bebebe"),
        grad: gradDirVector(gradient.direction),
        night: night ? 1 : 0,
      };
    }
    this.#renderFrame();
    // Night-mode flip inverts the page canvases; force a fresh read so the
    // digits recolor even if the ball hasn't moved.
    this.#updateTextColor(true);
  }

  // ╍╍╍ Adaptive page-number color ╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍

  /**
   * Re-sample the page behind the ball and recolor the page number. Called
   * externally (from FloatingToolbar) when the content scrolls or the ball is
   * repositioned without an animation frame running.
   */
  refreshTextColor() {
    if (this.enabled) this.#updateTextColor(true);
  }

  /**
   * Pick light or dark digits from the displayed luminance of whatever is
   * directly behind the page-number text — a PDF page canvas or the body
   * wallpaper (see sampleBackdropLuminance). A dead-band around 0.5 holds the
   * last choice so mixed content doesn't cause flicker.
   * @param {boolean} force Bypass the movement throttle (scroll / mode change).
   */
  #updateTextColor(force) {
    if (!this.enabled || !this.pageDisplay) return;

    const rect = this.pageDisplay.getBoundingClientRect();
    if (!rect.width) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // The animation loop calls this every frame; skip re-sampling until the
    // text has moved enough to matter. Forced calls (scroll, reposition,
    // mode change) always sample — the ball may be still while content isn't.
    if (
      !force &&
      this.lastSampleX !== null &&
      Math.abs(cx - this.lastSampleX) < 4 &&
      Math.abs(cy - this.lastSampleY) < 4
    ) {
      return;
    }
    this.lastSampleX = cx;
    this.lastSampleY = cy;

    const night = this.style.night === 1;
    // Displayed luminance of whatever is behind the digits — a PDF canvas
    // (night mode shows it CSS-inverted), or the body wallpaper. Null means
    // nothing readable there (the default gradient, or a cross-origin image):
    // fall back to the known backdrop tone for the current mode.
    const sampled = sampleBackdropLuminance(cx, cy, night);
    const lum = sampled === null ? (night ? 0.15 : 0.75) : sampled;

    let light;
    if (this.textLight === null) {
      light = lum < 0.5;
    } else if (this.textLight) {
      light = lum <= 0.6; // stay light until the backdrop is clearly bright
    } else {
      light = lum < 0.4; // stay dark until the backdrop is clearly dark
    }

    if (light === this.textLight) return;
    this.textLight = light;
    this.wrapper.dataset.glassText = light ? "light" : "dark";
  }
}

/**
 * Displayed luminance (0..1) of the backdrop under a viewport point, or null
 * when nothing readable is there. The ball floats over two possible opaque
 * layers: a PDF page canvas (only where a page is) or, in the margins around
 * the page, the body wallpaper. Both are checked. Night mode CSS-inverts the
 * page canvases (but not the wallpaper), so canvas samples are flipped here to
 * match what's on screen.
 * @param {number} x @param {number} y viewport CSS px
 * @param {boolean} night body.night-mode is active
 */
function sampleBackdropLuminance(x, y, night) {
  const canvas = document
    .elementsFromPoint(x, y)
    .find(
      (el) => el instanceof HTMLCanvasElement && el.dataset.pageNumber != null,
    );
  if (canvas && canvas.width) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      const raw = sampleCanvasLuminance(
        canvas,
        (x - rect.left) * (canvas.width / rect.width),
        (y - rect.top) * (canvas.height / rect.height),
      );
      if (raw !== null) return night ? 1 - raw : raw;
    }
  }

  // No page under the ball — read the wallpaper (not inverted in night mode).
  return sampleWallpaperLuminance(x, y);
}

/**
 * Average perceived luminance (0..1) of a small patch of a canvas backing
 * store around image-space (px, py), or null if it can't be read.
 */
function sampleCanvasLuminance(canvas, px, py) {
  const S = 28; // sample patch, canvas px
  const x0 = Math.max(0, Math.min(canvas.width - S, Math.round(px - S / 2)));
  const y0 = Math.max(0, Math.min(canvas.height - S, Math.round(py - S / 2)));
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return averageLuminance(ctx.getImageData(x0, y0, S, S).data);
  } catch {
    return null; // tainted canvas — leave the caller on its fallback
  }
}

// Wallpaper image cache: the loaded <img> plus a scratch canvas to read it.
// Keyed by the resolved url so a wallpaper change reloads on the next sample.
let _wpUrl = null;
let _wpImg = null;
let _wpReady = false;
let _wpScratch = null;
// Notified when a wallpaper image finishes decoding, so a resting ball can
// recolor once the pixels are actually readable (the sample that triggered the
// load returned null and used the fallback).
const _wpReadyListeners = new Set();

/** Subscribe to wallpaper-decode-complete. @returns {() => void} unsubscribe */
export function onWallpaperReady(fn) {
  _wpReadyListeners.add(fn);
  return () => _wpReadyListeners.delete(fn);
}

/**
 * Displayed luminance (0..1) of the body wallpaper under a viewport point, or
 * null when there's no readable image wallpaper (the default gradient shows no
 * url; a cross-origin image taints the scratch canvas; the image is still
 * loading). The background is `cover`, `center`, `fixed`, so it's mapped from
 * the viewport, not the document.
 * @param {number} x @param {number} y viewport CSS px
 */
function sampleWallpaperLuminance(x, y) {
  const bg = getComputedStyle(document.body).backgroundImage;
  const m = bg && bg.match(/url\((?:"|')?(.*?)(?:"|')?\)/);
  if (!m) return null; // gradient default / no image (also night-mode hidden)
  const url = m[1];

  if (url !== _wpUrl) {
    _wpUrl = url;
    _wpReady = false;
    _wpImg = new Image();
    _wpImg.crossOrigin = "anonymous"; // blob:/extension urls are same-origin
    _wpImg.onload = () => {
      _wpReady = true;
      _wpReadyListeners.forEach((fn) => fn());
    };
    _wpImg.src = url;
    return null; // not decoded yet — caller uses its fallback this frame
  }
  if (!_wpReady || !_wpImg.naturalWidth) return null;

  // cover: scale so the image fills the viewport, centered.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const nw = _wpImg.naturalWidth;
  const nh = _wpImg.naturalHeight;
  const scale = Math.max(vw / nw, vh / nh);
  const ix = (x - (vw - nw * scale) / 2) / scale;
  const iy = (y - (vh - nh * scale) / 2) / scale;

  const S = 8;
  const sx = Math.max(0, Math.min(nw - S, Math.round(ix - S / 2)));
  const sy = Math.max(0, Math.min(nh - S, Math.round(iy - S / 2)));

  if (!_wpScratch) _wpScratch = document.createElement("canvas");
  _wpScratch.width = S;
  _wpScratch.height = S;
  try {
    const ctx = _wpScratch.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(_wpImg, sx, sy, S, S, 0, 0, S, S);
    return averageLuminance(ctx.getImageData(0, 0, S, S).data);
  } catch {
    return null; // tainted (cross-origin without CORS)
  }
}

/** Mean Rec.601 luminance (0..1) of an RGBA pixel buffer. */
function averageLuminance(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / 4) / 255;
}

/** CSS gradient angle (0deg = to top, clockwise) → unit vector in y-down px space. */
function gradDirVector(deg) {
  const a = (deg * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

/** @returns {number[]} [r, g, b] in 0..1 */
function hexToRgb01(hex) {
  const h = hex.replace("#", "");
  return [
    (parseInt(h.substring(0, 2), 16) || 0) / 255,
    (parseInt(h.substring(2, 4), 16) || 0) / 255,
    (parseInt(h.substring(4, 6), 16) || 0) / 255,
  ];
}
