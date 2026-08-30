/**
 * Circular ease-in function.
 * @param x Value between 0 and 1
 */
function ease(x: number): number {
  return 1 - Math.sqrt(1 - x * x);
}

/**
 * A simple 2D point with utility methods for distance, angle, and movement.
 */
export class LazyPoint {
  x: number;
  y: number;

  constructor(x: number = 0, y: number = 0) {
    this.x = x;
    this.y = y;
  }

  /**
   * Set coordinates from a point-like object.
   */
  update(point: { x: number; y: number }) {
    this.x = point.x;
    this.y = point.y;
  }

  /**
   * Move this point along an angle by a given distance.
   * The angle is rotated by +π/2 to match browser coordinates (top-left origin).
   * @param angle Angle in radians
   * @param distance Distance to move in pixels
   * @param friction Optional friction value between 0 and 1
   */
  moveByAngle(angle: number, distance: number, friction?: number) {
    if (friction !== undefined && friction > 0 && friction < 1) {
      distance *= ease(1 - friction);
    }
    this.x += Math.sin(angle + Math.PI / 2) * distance;
    this.y -= Math.cos(angle + Math.PI / 2) * distance;
  }

  /**
   * Check strict equality with another point.
   */
  equalsTo(point: { x: number; y: number }): boolean {
    return this.x === point.x && this.y === point.y;
  }

  /**
   * Get euclidean distance to another point.
   */
  getDistanceTo(point: { x: number; y: number }): number {
    const dx = this.x - point.x;
    const dy = this.y - point.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Get angle to another point.
   * @returns Angle in radians
   */
  getAngleTo(point: { x: number; y: number }): number {
    return Math.atan2(point.y - this.y, point.x - this.x);
  }

  /**
   * Return a plain object representation.
   */
  toObject(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }
}
