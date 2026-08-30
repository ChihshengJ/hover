/**
 * GlowState — pure physics for the pointer-tracking specular glow. No DOM.
 *
 * A single soft highlight that rides the glass surface under the pointer.
 * Two eased quantities:
 *   - position  → exponentially trails the pointer for the liquid lag.
 *     While hovering it tracks the raw pointer freely (and drifts off the
 *     edge with it). While pressed/dragging it is leashed to the *lag
 *     blob* — the secondary metaball circle that trails the pointer — so
 *     the glow stays trapped inside the ball being dragged rather than the
 *     fixed main ball or the open page. GlassEffect feeds the live blob
 *     center/radius each frame via setLeash(),
 *   - intensity → 0 when the pointer is off the ball, a faint HOVER level
 *     while hovering, and a bright PRESS level while pressed/dragging.
 *     Attack is faster than release so a press pops and then relaxes.
 *
 * Sampled by GlassEffect into the shader's u_glow uniform. Participates in
 * the same on-demand rAF loop as GooState: isSettled() lets the loop stop
 * once a still pointer's glow has caught up (so a resting hover costs
 * nothing), and reports unsettled while anything is still easing.
 */

/** Steady intensity while hovering (not pressed), 0..1. Tunable. */
const HOVER_LEVEL = 0.3;
/** Steady intensity while pressed / dragging, 0..1. Tunable. */
const PRESS_LEVEL = 0.6;
/** Position ease rate, 1/s — higher tracks the pointer tighter. */
const POS_RATE = 18;
/** Intensity ease rates, 1/s — attack (rising) is snappier than release. */
const INTENSITY_ATTACK = 22;
const INTENSITY_RELEASE = 9;
/**
 * While pressed, the glow core is leashed to this fraction of the blob
 * radius from the blob center, so it stays trapped inside the dragged
 * silhouette. Tunable — 1 lets the core reach the blob's rim.
 */
const PRESS_LEASH_FRAC = 0.7;

/** Settle thresholds. */
const POS_EPS = 0.3;
const INTENSITY_EPS = 0.004;

export class GlowState {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  leashX: number;
  leashY: number;
  leashR: number;
  intensity: number;
  hovering: boolean;
  pressed: boolean;

  constructor({
    cx,
    cy,
  }: {
    /** Rest x, canvas-local px (ball center). */
    cx: number;
    /** Rest y, canvas-local px (ball center). */
    cy: number;
  }) {
    this.x = cx;
    this.y = cy;
    // Raw pointer target (unleashed); the press leash is applied per-frame.
    this.targetX = cx;
    this.targetY = cy;
    // Live blob anchor for the press leash, updated each frame by setLeash.
    this.leashX = cx;
    this.leashY = cy;
    this.leashR = 0;
    this.intensity = 0;
    this.hovering = false;
    this.pressed = false;
  }

  /** Point the glow at a raw canvas-local pointer position. */
  setTarget(x: number, y: number) {
    this.targetX = x;
    this.targetY = y;
  }

  /**
   * Set the press-leash anchor to the current lag-blob circle. Called each
   * frame while dragging so the glow follows the blob as it trails.
   * @param bx Blob center x, canvas-local px.
   * @param by Blob center y, canvas-local px.
   * @param br Blob radius, px.
   */
  setLeash(bx: number, by: number, br: number) {
    this.leashX = bx;
    this.leashY = by;
    this.leashR = br * PRESS_LEASH_FRAC;
  }

  /**
   * @param on Pointer is over the ball.
   */
  setHovering(on: boolean) {
    this.hovering = on;
  }

  /**
   * @param on Pointer is pressed / dragging.
   */
  setPressed(on: boolean) {
    this.pressed = on;
  }

  /** Intensity the current hover/press state eases toward. */
  get #targetIntensity() {
    if (this.pressed) return PRESS_LEVEL;
    return this.hovering ? HOVER_LEVEL : 0;
  }

  /**
   * Effective easing target: the raw pointer while hovering; while pressed,
   * that target clamped into the blob leash so the glow rides the dragged
   * blob's leading edge instead of the open pointer.
   */
  #effectiveTarget() {
    if (!this.pressed) return { x: this.targetX, y: this.targetY };
    const dx = this.targetX - this.leashX;
    const dy = this.targetY - this.leashY;
    const d = Math.hypot(dx, dy);
    if (d <= this.leashR || d < 1e-5) {
      return { x: this.targetX, y: this.targetY };
    }
    const s = this.leashR / d;
    return { x: this.leashX + dx * s, y: this.leashY + dy * s };
  }

  /**
   * Advance the eased position and intensity.
   * @param dt Seconds. Clamped to match GooState's tunneling guard.
   */
  step(dt: number) {
    dt = Math.min(dt, 1 / 30);

    const t = this.#effectiveTarget();
    const kp = 1 - Math.exp(-POS_RATE * dt);
    this.x += (t.x - this.x) * kp;
    this.y += (t.y - this.y) * kp;

    const target = this.#targetIntensity;
    const rate = target > this.intensity ? INTENSITY_ATTACK : INTENSITY_RELEASE;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-rate * dt));
  }

  /** Snapshot for the renderer's u_glow uniform. */
  sample() {
    return { x: this.x, y: this.y, intensity: this.intensity };
  }

  /**
   * True when nothing is moving. Position only matters while the glow is
   * visible, so a faded-out glow settles regardless of a stale target.
   */
  isSettled() {
    if (Math.abs(this.intensity - this.#targetIntensity) >= INTENSITY_EPS) {
      return false;
    }
    if (this.intensity < INTENSITY_EPS) return true;
    const t = this.#effectiveTarget();
    return Math.abs(this.x - t.x) < POS_EPS && Math.abs(this.y - t.y) < POS_EPS;
  }
}
