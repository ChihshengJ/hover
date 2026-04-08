import { LazyPoint } from "./lazy_point.js";

/**
 * LazyBrush smooths freehand drawing by making the brush trail behind the
 * pointer. The brush only moves when the pointer exceeds a configurable
 * radius from the current brush position.
 */
export class LazyBrush {
  /**
   * @param {Object} [options]
   * @param {number} [options.radius=30] - Lazy radius in pixels
   * @param {boolean} [options.enabled=true] - Whether lazy behaviour is active
   * @param {{x: number, y: number}} [options.initialPoint={x:0,y:0}] - Starting position
   */
  constructor({ radius = 30, enabled = true, initialPoint = { x: 0, y: 0 } } = {}) {
    this.radius = radius;
    this.angle = 0;
    this.distance = 0;
    this._hasMoved = false;
    this._isEnabled = enabled;
    this.pointer = new LazyPoint(initialPoint.x, initialPoint.y);
    this.brush = new LazyPoint(initialPoint.x, initialPoint.y);
  }

  /**
   * Core update method. Call on every pointer event.
   * @param {{x: number, y: number}} newPointerPoint
   * @param {Object} [options]
   * @param {boolean} [options.both] - If true, snap both pointer and brush to the new point
   * @param {number} [options.friction] - Friction value between 0 and 1
   * @returns {boolean} Whether anything changed
   */
  update(newPointerPoint, { both = false, friction } = {}) {
    this._hasMoved = false;

    if (this.pointer.equalsTo(newPointerPoint) && !both) {
      return false;
    }

    this.pointer.update(newPointerPoint);

    if (both) {
      this._hasMoved = true;
      this.brush.update(newPointerPoint);
      this.distance = 0;
      this.angle = 0;
      return true;
    }

    this.distance = this.brush.getDistanceTo(this.pointer);
    this.angle = this.brush.getAngleTo(this.pointer);

    if (!this._isEnabled) {
      this._hasMoved = true;
      this.brush.update(this.pointer);
      return true;
    }

    if (this.distance > this.radius) {
      this.brush.moveByAngle(this.angle, this.distance - this.radius, friction);
      this._hasMoved = true;
    }

    return true;
  }

  /**
   * Get the current brush coordinates.
   * @returns {{x: number, y: number}}
   */
  getBrushCoordinates() {
    return this.brush.toObject();
  }

  /**
   * Get the current pointer coordinates.
   * @returns {{x: number, y: number}}
   */
  getPointerCoordinates() {
    return this.pointer.toObject();
  }

  /**
   * Get the current angle from brush to pointer.
   * @returns {number}
   */
  getAngle() {
    return this.angle;
  }

  /**
   * Get the current distance from brush to pointer.
   * @returns {number}
   */
  getDistance() {
    return this.distance;
  }

  /**
   * Whether the brush moved during the last update.
   * @returns {boolean}
   */
  brushHasMoved() {
    return this._hasMoved;
  }

  /** Enable lazy brush behaviour. */
  enable() {
    this._isEnabled = true;
  }

  /** Disable lazy brush behaviour (brush tracks pointer directly). */
  disable() {
    this._isEnabled = false;
  }

  /**
   * Set the lazy radius.
   * @param {number} r
   */
  setRadius(r) {
    this.radius = r;
  }

  /**
   * Get the lazy radius.
   * @returns {number}
   */
  getRadius() {
    return this.radius;
  }
}
