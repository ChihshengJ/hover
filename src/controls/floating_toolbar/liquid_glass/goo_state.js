/**
 * GooState — pure physics for the liquid-glass ball. No DOM access.
 *
 * Models two circles in canvas-local CSS px (y-down):
 *   - the ball: fixed at the container center, radius perturbed by a
 *     decaying click impulse ("bump") for the jelly bounce,
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

export class GooState {
  /**
   * @param {Object} opts
   * @param {number} opts.cx    Ball center x, canvas-local px.
   * @param {number} opts.cy    Ball center y, canvas-local px.
   * @param {number} opts.ballR Ball radius, px.
   */
  constructor({ cx, cy, ballR }) {
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
    /** Seconds since the last pulse; Infinity = no pulse pending. */
    this.pulseT = Infinity;
  }

  /** Point the blob spring at a canvas-local position, leashed to MAX_STRETCH. */
  setTarget(x, y) {
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

  /** @param {boolean} on */
  setDragging(on) {
    this.dragging = on;
    if (!on) {
      this.targetX = this.cx;
      this.targetY = this.cy;
    }
  }

  /** Trigger the click bounce. */
  pulse() {
    this.pulseT = 0;
  }

  /**
   * Advance the simulation.
   * @param {number} dt Seconds. Clamped to avoid tunneling after tab-idle.
   */
  step(dt) {
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

  /** Snapshot for the renderer / clip-path generator. */
  sample() {
    return {
      ballX: this.cx,
      ballY: this.cy,
      ballR: this.ballR * (1 + this.bump),
      blobX: this.blobX,
      blobY: this.blobY,
      blobR: this.blobR,
      // Smoothing radius for the SDF smooth-min: grows with the blob so a
      // retracted blob leaves the ball a clean circle.
      k: 25 + 0.8 * this.blobR,
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
      this.blobR < 0.1
    );
  }
}
