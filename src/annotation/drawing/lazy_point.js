/**
 * Circular ease-in function.
 * @param {number} x - Value between 0 and 1
 * @returns {number}
 */
function ease(x) {
  return 1 - Math.sqrt(1 - x * x);
}

/**
 * A simple 2D point with utility methods for distance, angle, and movement.
 */
export class LazyPoint {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /**
   * Set coordinates from a point-like object.
   * @param {{x: number, y: number}} point
   */
  update(point) {
    this.x = point.x;
    this.y = point.y;
  }

  /**
   * Move this point along an angle by a given distance.
   * The angle is rotated by +π/2 to match browser coordinates (top-left origin).
   * @param {number} angle - Angle in radians
   * @param {number} distance - Distance to move in pixels
   * @param {number} [friction] - Optional friction value between 0 and 1
   */
  moveByAngle(angle, distance, friction) {
    if (friction !== undefined && friction > 0 && friction < 1) {
      distance *= ease(1 - friction);
    }
    this.x += Math.sin(angle + Math.PI / 2) * distance;
    this.y -= Math.cos(angle + Math.PI / 2) * distance;
  }

  /**
   * Check strict equality with another point.
   * @param {{x: number, y: number}} point
   * @returns {boolean}
   */
  equalsTo(point) {
    return this.x === point.x && this.y === point.y;
  }

  /**
   * Get euclidean distance to another point.
   * @param {{x: number, y: number}} point
   * @returns {number}
   */
  getDistanceTo(point) {
    const dx = this.x - point.x;
    const dy = this.y - point.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Get angle to another point.
   * @param {{x: number, y: number}} point
   * @returns {number} Angle in radians
   */
  getAngleTo(point) {
    return Math.atan2(point.y - this.y, point.x - this.x);
  }

  /**
   * Return a plain object representation.
   * @returns {{x: number, y: number}}
   */
  toObject() {
    return { x: this.x, y: this.y };
  }
}
