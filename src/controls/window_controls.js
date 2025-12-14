/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('../touch_controls.js').GestureDetector} GestureDetector;
 */

import { GestureDetector } from "./touch_controls.js";

export class WindowControls {
  /**
  * @param {SplitWindowManager} wm;
  */
  constructor(wm) {
    this.wm = wm;
    this.gesture = null;
    this.#setupKeyboardShortcuts();
    this.#setupGestures();
  }

  get activePane() {
    return this.wm.activePane;
  }

  #setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      const pane = this.activePane;
      const scroller = this.activePane.scroller;
      if (!pane) return;
      const isZoomKey =
        (e.metaKey || e.ctrlKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0");

      const stepY = scroller.clientHeight * 0.15;
      const stepX = scroller.clientWidth * 0.1;

      if (isZoomKey) {
        e.preventDefault();

        // Zoom in/out
        if (e.key === "=" || e.key === "+") pane.zoom(0.25);
        else if (e.key === "-" || e.key === "_") pane.zoom(-0.25);
        else if (e.key === "0")
          pane.zoomAt(
            1,
            scroller.clientWidth / 2,
            scroller.clientHeight / 2,
          );
        return;
      }

      // Normal scrolling
      if (["ArrowDown", "j"].includes(e.key)) {
        e.preventDefault();
        scroller.scrollBy({ top: stepY, behavior: "smooth" });
      } else if (["ArrowUp", "k"].includes(e.key)) {
        e.preventDefault();
        scroller.scrollBy({ top: -stepY, behavior: "smooth" });
      } else if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        scroller.scrollBy({ left: stepX, behavior: "smooth" });
      } else if (e.key === "ArrowLeft" || e.key === "h") {
        e.preventDefault();
        scroller.scrollBy({ left: -stepX, behavior: "smooth" });
      }

      // Page jump (Shift + j/k or Page Up/Down)
      if (e.shiftKey && e.key === "J") {
        e.preventDefault();
        pane.scrollToRelative(1);
      } else if (e.shiftKey && e.key === "K") {
        e.preventDefault();
        pane.scrollToRelative(-1);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        pane.scrollToRelative(1);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        pane.scrollToRelative(-1);
      }

      if (e.key === "Tab" && this.wm.isSplit) {
        e.preventDefault();
        this.#switchActivePane();
      }
    });
  }

  #setupGestures() {
    this.#rebindGestures();
  }

  #rebindGestures() {
    if (this.gesture) {
      this.gesture.destory?.();
    }

    const pane = this.activePane;
    if (!pane) return;

    this.gesture = new GestureDetector(pane.viewerEl);

    let startScale = 1;
    let isTransforming = false;
    let pageStates = new Map();

    this.gesture.getEventTarget().addEventListener("pinchstart", (e) => {
      const currentPane = this.activePane;
      startScale = currentPane.getScale();
      isTransforming = true;
      pageStates.clear();

      // Get pinch center in viewport coordinates
      const containerRect = currentPane.viewerEl.getBoundingClientRect();
      const pinchX = e.detail.center.x;
      const pinchY = e.detail.center.y;

      // Store original state for each page wrapper
      const wrappers = currentPane.viewerEl.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const wrapperRect = wrapper.getBoundingClientRect();

        // Calculate pinch point as percentage of wrapper dimensions
        const percentX =
          ((pinchX - wrapperRect.left) / wrapperRect.width) * 100;
        const percentY =
          ((pinchY - wrapperRect.top) / wrapperRect.height) * 100;

        pageStates.set(wrapper, {
          originalTransform: wrapper.style.transform,
          originalOrigin: wrapper.style.transformOrigin,
          percentX: percentX,
          percentY: percentY,
        });
      });
    });

    this.gesture.getEventTarget().addEventListener("pinchupdate", (e) => {
      if (!isTransforming) return;

      const currentPane = this.activePane;

      const ratio = e.detail.startScaleRatio;
      const newScale = Math.max(0.5, Math.min(4, startScale * ratio));
      const visualScaleDelta = newScale / startScale;

      // Apply scale with fixed transform-origin for each wrapper
      const wrappers = currentPane.viewerEl.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const state = pageStates.get(wrapper);
        if (!state) return;

        // Use percentage-based transform-origin (stays consistent during scaling)
        wrapper.style.transformOrigin = `${state.percentX}% ${state.percentY}%`;

        // Apply the pinch scale on top of the original transform
        if (state.originalTransform) {
          wrapper.style.transform = `${state.originalTransform} scale(${visualScaleDelta})`;
        } else {
          wrapper.style.transform = `scale(${visualScaleDelta})`;
        }
      });
    });

    this.gesture.getEventTarget().addEventListener("pinchend", (e) => {
      if (!isTransforming) return;

      const currentPane = this.activePane;
      // Restore original state for all wrappers
      const wrappers = currentPane.viewerEl.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const state = pageStates.get(wrapper);
        if (!state) return;

        wrapper.style.transform = state.originalTransform;
        wrapper.style.transformOrigin = state.originalOrigin;
      });

      const ratio = e.detail.startScaleRatio;
      const finalScale = Math.max(0.5, Math.min(4, startScale * ratio));

      // Apply actual zoom (re-renders canvases)
      const containerRect = currentPane.viewerEl.getBoundingClientRect();
      const focusX = e.detail.center.x - containerRect.left;
      const focusY = e.detail.center.y - containerRect.top;
      currentPane.zoomAt(finalScale, focusX, focusY);

      isTransforming = false;
      pageStates.clear();
    });
  }

  #switchActivePane() {
    const panes = this.wm.panes;
    if (panes.length < 2) return;

    const currentIndex = panes.indexOf(this.activePane);
    const nextIndex = (currentIndex + 1) % panes.length;
    this.wm.setActivePane(panes[nextIndex]);

    this.#rebindGestures();
  }

  updateActivePane() {
    this.#rebindGestures();
  }

  destroy() {
    this.gesture?.destroy?.();
  }
}
