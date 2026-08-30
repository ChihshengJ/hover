// Adapted from Chromium PDF viewer (BSD-3-Clause License)
// https://github.com/chromium/chromium/blob/main/pdf/...

/**
 * The upstream code assumes Chromium's `assert`, which did not come across with
 * it — so every pinch threw a ReferenceError before reaching the maths below.
 */
function assert(condition: boolean, message: string = "assertion failed") {
  if (!condition) throw new Error(`[GestureDetector] ${message}`);
}

/** Where a gesture is centred, in element-local CSS px. */
export interface GesturePoint {
  x: number;
  y: number;
}

/** The `detail` of every event this detector dispatches. */
export interface GestureDetail {
  center: GesturePoint;
  /** Scale since the previous event; pinch only. */
  scaleRatio?: number | null;
  /** Scale since the gesture began; pinch only. */
  startScaleRatio?: number | null;
  direction?: "in" | "out" | "up" | "down";
}

export type GestureType = "pinchstart" | "pinchupdate" | "pinchend" | "wheel";

export class GestureDetector {
  element_: HTMLElement;
  pinchStartEvent_: TouchEvent | null = null;
  lastTouchTouchesCount_ = 0;
  lastEvent_: TouchEvent | null = null;
  isPresentationMode_ = false;
  accumulatedWheelScale_: number | null = null;
  wheelEndTimeout_: number | null = null;
  eventTarget_ = new EventTarget();
  constructor(element: HTMLElement) {
    this.element_ = element;
    this.element_.addEventListener(
      "touchstart",
      this.onTouchStart_.bind(this),
      {
        passive: true,
      },
    );
    const boundOnTouch = this.onTouch_.bind(this);
    this.element_.addEventListener("touchmove", boundOnTouch, {
      passive: true,
    });
    this.element_.addEventListener("touchend", boundOnTouch, {
      passive: true,
    });
    this.element_.addEventListener("touchcancel", boundOnTouch, {
      passive: true,
    });
    this.element_.addEventListener("wheel", this.onWheel_.bind(this), {
      passive: false,
    });
    document.addEventListener(
      "contextmenu",
      this.handleContextMenuEvent_.bind(this),
    );
  }
  setPresentationMode(enabled: boolean) {
    this.isPresentationMode_ = enabled;
  }
  getEventTarget() {
    return this.eventTarget_;
  }
  wasTwoFingerTouch() {
    return this.lastTouchTouchesCount_ === 2;
  }
  notify_(type: GestureType, detail: GestureDetail) {
    const clientRect = this.element_.getBoundingClientRect();
    detail.center = {
      x: detail.center.x - clientRect.x,
      y: detail.center.y - clientRect.y,
    };
    this.eventTarget_.dispatchEvent(
      new CustomEvent(type, {
        detail: detail,
      }),
    );
  }
  onTouchStart_(event: TouchEvent) {
    this.lastTouchTouchesCount_ = event.touches.length;
    if (!this.wasTwoFingerTouch()) {
      return;
    }
    this.pinchStartEvent_ = event;
    this.lastEvent_ = event;
    this.notify_("pinchstart", {
      center: center(event),
    });
  }
  onTouch_(event: TouchEvent) {
    if (!this.pinchStartEvent_) {
      return;
    }
    const lastEvent = this.lastEvent_!;
    if (
      event.touches.length < 2 ||
      lastEvent.touches.length !== event.touches.length
    ) {
      const startScaleRatio = pinchScaleRatio(lastEvent, this.pinchStartEvent_);
      this.pinchStartEvent_ = null;
      this.lastEvent_ = null;
      this.notify_("pinchend", {
        startScaleRatio: startScaleRatio,
        center: center(lastEvent),
      });
      return;
    }
    const scaleRatio = pinchScaleRatio(event, lastEvent);
    const startScaleRatio = pinchScaleRatio(event, this.pinchStartEvent_);
    this.notify_("pinchupdate", {
      scaleRatio: scaleRatio,
      direction: scaleRatio > 1 ? "in" : "out",
      startScaleRatio: startScaleRatio,
      center: center(event),
    });
    this.lastEvent_ = event;
  }
  onWheel_(event: WheelEvent) {
    if (!event.ctrlKey) {
      if (this.isPresentationMode_) {
        this.notify_("wheel", {
          center: {
            x: event.clientX,
            y: event.clientY,
          },
          direction: event.deltaY > 0 ? "down" : "up",
        });
      }
      return;
    }
    event.preventDefault();
    if (this.isPresentationMode_) {
      return;
    }
    const wheelScale = Math.exp(-event.deltaY / 100);
    const scale = Math.min(1.25, Math.max(0.75, wheelScale));
    const position = {
      x: event.clientX,
      y: event.clientY,
    };
    if (this.accumulatedWheelScale_ == null) {
      this.accumulatedWheelScale_ = 1;
      this.notify_("pinchstart", {
        center: position,
      });
    }
    this.accumulatedWheelScale_ *= scale;
    this.notify_("pinchupdate", {
      scaleRatio: scale,
      direction: scale > 1 ? "in" : "out",
      startScaleRatio: this.accumulatedWheelScale_,
      center: position,
    });
    if (this.wheelEndTimeout_ != null) {
      window.clearTimeout(this.wheelEndTimeout_);
      this.wheelEndTimeout_ = null;
    }
    const gestureEndDelayMs = 100;
    const endEvent = {
      startScaleRatio: this.accumulatedWheelScale_,
      center: position,
    };
    this.wheelEndTimeout_ = window.setTimeout(() => {
      this.notify_("pinchend", endEvent);
      this.wheelEndTimeout_ = null;
      this.accumulatedWheelScale_ = null;
    }, gestureEndDelayMs);
  }
  handleContextMenuEvent_(e: MouseEvent) {
    // `sourceCapabilities` is Chromium-only and absent from lib.dom.
    const capabilities = (
      e as MouseEvent & {
        sourceCapabilities?: { firesTouchEvents: boolean };
      }
    ).sourceCapabilities;
    if (
      capabilities &&
      capabilities.firesTouchEvents &&
      !this.wasTwoFingerTouch()
    ) {
      e.preventDefault();
    }
  }
  destroy() {
    this.element_.removeEventListener(
      "touchstart",
      this.onTouchStart_.bind(this),
    );
    this.element_.removeEventListener("touchmove", this.onTouch_.bind(this));
    this.element_.removeEventListener("touchend", this.onTouch_.bind(this));
    this.element_.removeEventListener("touchcancel", this.onTouch_.bind(this));
    this.element_.removeEventListener("wheel", this.onWheel_.bind(this));
    if (this.wheelEndTimeout_) {
      clearTimeout(this.wheelEndTimeout_);
    }
  }
}

function pinchScaleRatio(
  event: TouchEvent,
  prevEvent: TouchEvent,
): number | null {
  const distance1 = distance(prevEvent);
  const distance2 = distance(event);
  return distance1 === 0 ? null : distance2 / distance1;
}

function distance(event: TouchEvent): number {
  assert(event.touches.length > 1);
  const touch1 = event.touches[0];
  const touch2 = event.touches[1];
  const dx = touch1.clientX - touch2.clientX;
  const dy = touch1.clientY - touch2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
function center(event: TouchEvent): GesturePoint {
  assert(event.touches.length > 1);
  const touch1 = event.touches[0];
  const touch2 = event.touches[1];
  return {
    x: (touch1.clientX + touch2.clientX) / 2,
    y: (touch1.clientY + touch2.clientY) / 2,
  };
}
