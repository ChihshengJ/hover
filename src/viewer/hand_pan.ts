import { beginDragGesture, isPointerToolActive } from "./pointer_gesture.js";

/**
 * Hand mode: a left-button drag on the scroller pans it. Enabling parks
 * listeners on `document`, so a pane that enabled it must disable it before
 * it goes, or they outlive it and keep scrolling a detached scroller.
 */
export class HandPan {
  #getScroller: () => HTMLElement;
  #enabled = false;
  #panning = false;
  #start = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };
  /** Releases the pan's gesture claim; see pointer_gesture.js. */
  #release: (() => void) | null = null;

  /** `getScroller` is read on enable, as the scroller may not exist yet. */
  constructor(getScroller: () => HTMLElement) {
    this.#getScroller = getScroller;
  }

  enable() {
    if (this.#enabled) return;
    this.#enabled = true;
    const scroller = this.#getScroller();
    scroller.classList.add("hand-mode");
    scroller.addEventListener("pointerdown", this.#onStart);
    document.addEventListener("pointermove", this.#onMove);
    document.addEventListener("pointerup", this.#onEnd);
  }

  disable() {
    this.#release?.();
    this.#release = null;
    this.#panning = false;
    if (!this.#enabled) return;
    this.#enabled = false;
    const scroller = this.#getScroller();
    scroller.classList.remove("hand-mode", "panning");
    scroller.removeEventListener("pointerdown", this.#onStart);
    document.removeEventListener("pointermove", this.#onMove);
    document.removeEventListener("pointerup", this.#onEnd);
  }

  #onStart = (e: PointerEvent) => {
    // Only handle left mouse button
    if (e.button !== 0) return;

    // A drawing or region-select drag outranks the hand: without this both
    // ran, and the page scrolled out from under the tool's own gesture.
    if (isPointerToolActive()) return;

    // Ignore clicks on interactive elements
    if (
      (e.target as Element).closest(
        "a, button, .pane-controls, .annotation-toolbar-container",
      )
    )
      return;

    e.preventDefault();
    // The pan outranks text selection in turn. The hand-mode CSS already
    // makes the text layer unselectable, but a drag that starts off it can
    // still arm a selection in WebKit, which no CSS can call back.
    this.#release = beginDragGesture();
    this.#panning = true;
    const scroller = this.#getScroller();
    scroller.classList.add("panning");

    this.#start = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };
  };

  #onMove = (e: PointerEvent) => {
    if (!this.#panning) return;

    const scroller = this.#getScroller();
    scroller.scrollLeft = this.#start.scrollLeft - (e.clientX - this.#start.x);
    scroller.scrollTop = this.#start.scrollTop - (e.clientY - this.#start.y);
  };

  #onEnd = () => {
    if (!this.#panning) return;
    this.#panning = false;
    this.#getScroller().classList.remove("panning");
    this.#release?.();
    this.#release = null;
  };
}
