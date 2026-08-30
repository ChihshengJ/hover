import { LazyPoint } from "./lazy_point.js";

/**
 * LazyBrush smooths freehand drawing by making the brush trail behind the
 * pointer. The brush only moves when the pointer exceeds a configurable
 * radius from the current brush position.
 */
export class LazyBrush {
  radius: number;
  angle: number;
  distance: number;
  _hasMoved: boolean;
  _isEnabled: boolean;
  pointer: LazyPoint;
  brush: LazyPoint;

  constructor({
    radius = 30,
    enabled = true,
    initialPoint = { x: 0, y: 0 },
  }: {
    /** Lazy radius in pixels. */
    radius?: number;
    /** Whether lazy behaviour is active. */
    enabled?: boolean;
    initialPoint?: { x: number; y: number };
  } = {}) {
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
   * @returns Whether anything changed
   * @param options.both If true, snap both pointer and brush to the new point
   * @param options.friction Friction value between 0 and 1
   */
  update(
    newPointerPoint: { x: number; y: number },
    {
      both = false,
      friction,
    }: {
      /** Snap both pointer and brush to the new point. */
      both?: boolean;
      /** Friction value between 0 and 1. */
      friction?: number;
    } = {},
  ): boolean {
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
   */
  getBrushCoordinates(): { x: number; y: number } {
    return this.brush.toObject();
  }

  /**
   * Get the current pointer coordinates.
   */
  getPointerCoordinates(): { x: number; y: number } {
    return this.pointer.toObject();
  }

  /**
   * Get the current angle from brush to pointer.
   */
  getAngle(): number {
    return this.angle;
  }

  /**
   * Get the current distance from brush to pointer.
   */
  getDistance(): number {
    return this.distance;
  }

  /**
   * Whether the brush moved during the last update.
   */
  brushHasMoved(): boolean {
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
   */
  setRadius(r: number) {
    this.radius = r;
  }

  /**
   * Get the lazy radius.
   */
  getRadius(): number {
    return this.radius;
  }
}
