/**
 * GooState — pure physics for the liquid-glass ball. No DOM access.
 *
 * Models two circles in canvas-local CSS px (y-down):
 *   - the ball: fixed at the container center, radius perturbed by a
 *     decaying click impulse ("bump") for the jelly bounce and by the
 *     hover swell (see below),
 *   - the lag blob: spring-follows the pointer during a drag and shrinks
 *     back into the ball on release. The renderer's smooth-min of the two
 *     circle SDFs produces the dough bridge between them.
 *
 * The spring is critically damped so the blob trails without oscillating;
 * the release wobble comes from the blob retracting while the container
 * itself snaps back via its CSS bounce transition.
 */

/** Blob radius while a drag is active, px. */
const ACTIVE_BLOB_R = 15;
/**
 * Max distance the blob target may sit from the ball center, px. Acts as
 * the "viscosity leash": keeps the blob within smooth-min bridging range
 * of the ball (ballR + blobR + k) so the goo never detaches, and well
 * inside the 200px canvas so it never clips at the edge.
 */
const MAX_STRETCH = 45;
/** Spring angular frequency, rad/s. Higher = tighter pointer tracking. */
const OMEGA = 24;
/** Click impulse: radius scale amplitude and decay/oscillation rates. */
const BUMP_AMP = 0.085;
const BUMP_DECAY = 5;
const BUMP_FREQ = 24;
/** Impulse is fully decayed after this many seconds. */
const BUMP_LIFETIME = 1.2;

/**
 * Hover swell: radius multiplier while the pointer is over the ball.
 * Matches the 1.1 of `.goo-container:hover` — but in glass mode the swell
 * has to be *geometry*, not a CSS transform on the container. Scaling an
 * ancestor of a backdrop-filtered layer makes Chromium (on the SVG
 * refraction path) and Gecko (on every backdrop-filter) re-register the
 * backdrop against the live transform each frame, so the page seen through
 * the glass swims while the scale animates — and the overshooting bounce
 * easing turns that swim into a visible jiggle. Growing the SDF instead
 * leaves the glass layers untransformed, so the backdrop stays pinned and
 * only the silhouette moves.
 */
const HOVER_SWELL = 1.1;
/**
 * Swell spring, rad/s + damping ratio. Underdamped so the radius lands with
 * the same small overshoot as the CSS bounce easing the SVG ball animates
 * with (var(--transition-bounce)).
 */
const SWELL_OMEGA = 26;
const SWELL_ZETA = 0.6;
/** Settle thresholds for the swell spring. */
const SWELL_EPS = 0.002;
const SWELL_VEL_EPS = 0.02;

export class GooState {
  cx: number;
  cy: number;
  ballR: number;
  blobX: number;
  blobY: number;
  velX: number;
  velY: number;
  targetX: number;
  targetY: number;
  blobR: number;
  dragging: boolean;
  hovering: boolean;
  swell: number;
  swellVel: number;
  pulseT: number;

  /**
   * @param {Object} opts
   */
  constructor({
    cx,
    cy,
    ballR,
  }: {
    /** Ball center x, canvas-local px. */
    cx: number;
    /** Ball center y, canvas-local px. */
    cy: number;
    /** Ball radius, px. */
    ballR: number;
  }) {
    this.cx = cx;
    this.cy = cy;
    this.ballR = ballR;

    this.blobX = cx;
    this.blobY = cy;
    this.velX = 0;
    this.velY = 0;
    this.targetX = cx;
    this.targetY = cy;
    this.blobR = 0;
    this.dragging = false;
    this.hovering = false;
    /** Hover swell progress, 0 (rest) → 1 (fully swollen). Spring-eased. */
    this.swell = 0;
    this.swellVel = 0;
    /** Seconds since the last pulse; Infinity = no pulse pending. */
    this.pulseT = Infinity;
  }

  /** Point the blob spring at a canvas-local position, leashed to MAX_STRETCH. */
  setTarget(x: number, y: number) {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const d = Math.hypot(dx, dy);
    if (d > MAX_STRETCH) {
      const s = MAX_STRETCH / d;
      x = this.cx + dx * s;
      y = this.cy + dy * s;
    }
    this.targetX = x;
    this.targetY = y;
  }

  setDragging(on: boolean) {
    this.dragging = on;
    if (!on) {
      this.targetX = this.cx;
      this.targetY = this.cy;
    }
  }

  /**
   * @param on Pointer is over the ball.
   */
  setHovering(on: boolean) {
    this.hovering = on;
  }

  /**
   * Swell the radius eases toward, 0..1. Suppressed while dragging, which
   * mirrors the `:not(.dragging)` on the CSS hover rule: a ball being
   * dragged sits at its rest size and lets the lag blob do the deforming.
   */
  get #swellTarget() {
    return this.hovering && !this.dragging ? 1 : 0;
  }

  /** Trigger the click bounce. */
  pulse() {
    this.pulseT = 0;
  }

  /**
   * Advance the simulation.
   * @param dt Seconds. Clamped to avoid tunneling after tab-idle.
   */
  step(dt: number) {
    dt = Math.min(dt, 1 / 30);

    // Critically damped spring: x'' = -ω²(x − target) − 2ωx'
    const ax =
      -OMEGA * OMEGA * (this.blobX - this.targetX) - 2 * OMEGA * this.velX;
    const ay =
      -OMEGA * OMEGA * (this.blobY - this.targetY) - 2 * OMEGA * this.velY;
    this.velX += ax * dt;
    this.velY += ay * dt;
    this.blobX += this.velX * dt;
    this.blobY += this.velY * dt;

    const targetR = this.dragging ? ACTIVE_BLOB_R : 0;
    this.blobR += (targetR - this.blobR) * (1 - Math.exp(-10 * dt));

    // Hover swell: damped spring on the 0..1 progress, x'' = -ω²(x − t) − 2ζωx'
    const swellTarget = this.#swellTarget;
    const as =
      -SWELL_OMEGA * SWELL_OMEGA * (this.swell - swellTarget) -
      2 * SWELL_ZETA * SWELL_OMEGA * this.swellVel;
    this.swellVel += as * dt;
    this.swell += this.swellVel * dt;

    if (isFinite(this.pulseT)) {
      this.pulseT += dt;
    }
  }

  /** Current radius perturbation from the click impulse, ~[-0.085, 0.085]. */
  get bump() {
    const t = this.pulseT;
    if (!isFinite(t) || t > BUMP_LIFETIME) return 0;
    return BUMP_AMP * Math.exp(-BUMP_DECAY * t) * Math.cos(BUMP_FREQ * t);
  }

  /** Radius multiplier from the hover swell, 1 at rest → HOVER_SWELL. */
  get swellScale() {
    return 1 + (HOVER_SWELL - 1) * this.swell;
  }

  /** Snapshot for the renderer / clip-path generator. */
  sample() {
    return {
      ballX: this.cx,
      ballY: this.cy,
      ballR: this.ballR * this.swellScale * (1 + this.bump),
      blobX: this.blobX,
      blobY: this.blobY,
      blobR: this.blobR,
      // Smoothing radius for the SDF smooth-min: grows with the blob so a
      // retracted blob leaves the ball a clean circle. The cubic smin's
      // peak correction is k/6 against the old quadratic's k/4, so these
      // carry a 1.5x to hold the bridge at the same depth (25 -> 37.5,
      // 0.8 -> 1.2). At rest the 37.5 leaves the circle off by 0.002px.
      k: 37.5 + 1.2 * this.blobR,
      bump: this.bump,
    };
  }

  /** True when nothing is moving and rendering can stop. */
  isSettled() {
    if (this.dragging) return false;
    if (isFinite(this.pulseT) && this.pulseT < BUMP_LIFETIME) return false;
    return (
      Math.abs(this.blobX - this.targetX) < 0.1 &&
      Math.abs(this.blobY - this.targetY) < 0.1 &&
      Math.abs(this.velX) < 0.5 &&
      Math.abs(this.velY) < 0.5 &&
      this.blobR < 0.1 &&
      Math.abs(this.swell - this.#swellTarget) < SWELL_EPS &&
      Math.abs(this.swellVel) < SWELL_VEL_EPS
    );
  }
}
