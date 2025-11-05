// Adapted from Chromium PDF viewer (BSD-3-Clause License)
// https://github.com/chromium/chromium/blob/main/pdf/...
export class GestureDetector {
  element_;
  pinchStartEvent_ = null;
  lastTouchTouchesCount_ = 0;
  lastEvent_ = null;
  isPresentationMode_ = false;
  accumulatedWheelScale_ = null;
  wheelEndTimeout_ = null;
  eventTarget_ = new EventTarget();
  constructor(element) {
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
  setPresentationMode(enabled) {
    this.isPresentationMode_ = enabled;
  }
  getEventTarget() {
    return this.eventTarget_;
  }
  wasTwoFingerTouch() {
    return this.lastTouchTouchesCount_ === 2;
  }
  notify_(type, detail) {
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
  onTouchStart_(event) {
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
  onTouch_(event) {
    if (!this.pinchStartEvent_) {
      return;
    }
    const lastEvent = this.lastEvent_;
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
  onWheel_(event) {
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
  handleContextMenuEvent_(e) {
    const capabilities = e.sourceCapabilities;
    if (
      capabilities &&
      capabilities.firesTouchEvents &&
      !this.wasTwoFingerTouch()
    ) {
      e.preventDefault();
    }
  }
}

function pinchScaleRatio(event, prevEvent) {
  const distance1 = distance(prevEvent);
  const distance2 = distance(event);
  return distance1 === 0 ? null : distance2 / distance1;
}

function distance(event) {
  assert(event.touches.length > 1);
  const touch1 = event.touches[0];
  const touch2 = event.touches[1];
  const dx = touch1.clientX - touch2.clientX;
  const dy = touch1.clientY - touch2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
function center(event) {
  assert(event.touches.length > 1);
  const touch1 = event.touches[0];
  const touch2 = event.touches[1];
  return {
    x: (touch1.clientX + touch2.clientX) / 2,
    y: (touch1.clientY + touch2.clientY) / 2,
  };
}
