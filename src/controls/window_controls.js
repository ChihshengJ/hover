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
    this.#bindGestures();
    this.MAX_RENDER_SCALE = 7;
  }

  get activePane() {
    return this.wm.activePane;
  }

  #setupKeyboardShortcuts() {
    window.addEventListener("resize", async () => {
      for (const p of this.wm.panes) {
        await p.refreshAllPages();
      }
    });
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
          pane.zoomAt(1, scroller.clientWidth / 2, scroller.clientHeight / 2);
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

  /* TODO: bug in split mode right window zooming behavior */
  #bindGestures() {
    if (this.gesture) {
      this.gesture.destory?.();
    }

    const pane = this.activePane;
    if (!pane) return;

    this.gesture = new GestureDetector(pane.paneEl);

    let startScale = 1;
    let isTransforming = false;
    let pageStates = new Map();

    this.gesture.getEventTarget().addEventListener("pinchstart", (e) => {
      startScale = pane.scale;
      isTransforming = true;
      pageStates.clear();

      const pinchX = e.detail.center.x;
      const pinchY = e.detail.center.y;

      const wrappers = pane.paneEl.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const wrapperRect = wrapper.getBoundingClientRect();
        const percentX =
          ((pinchX - wrapperRect.left) / wrapperRect.width) * 100;
        const percentY =
          ((pinchY - wrapperRect.top) / wrapperRect.height) * 100;

        pageStates.set(wrapper, { percentX, percentY });
      });
    });

    this.gesture.getEventTarget().addEventListener("pinchupdate", (e) => {
      if (!isTransforming) return;
      const ratio = e.detail.startScaleRatio;
      const newScale = Math.max(
        0.5,
        Math.min(this.MAX_RENDER_SCALE, startScale * ratio),
      );
      const visualScaleDelta = newScale / startScale;

      const wrappers = pane.paneEl.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const state = pageStates.get(wrapper);
        if (!state) return;

        wrapper.style.transformOrigin = `${state.percentX}% ${state.percentY}%`;
        wrapper.style.transform = `scale(${visualScaleDelta})`;
      });
    });

    this.gesture.getEventTarget().addEventListener("pinchend", (e) => {
      if (!isTransforming) return;

      const wrappers = pane.paneEl.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        wrapper.style.transform = "";
        wrapper.style.transformOrigin = "";
      });

      const ratio = e.detail.startScaleRatio;
      const finalScale = Math.max(
        0.5,
        Math.min(this.MAX_RENDER_SCALE, startScale * ratio),
      );

      console.log(finalScale);

      const containerRect = pane.paneEl.getBoundingClientRect();
      const focusX = e.detail.center.x - containerRect.left;
      const focusY = e.detail.center.y - containerRect.top;
      pane.zoomAt(finalScale, focusX, focusY);

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

    this.#bindGestures();
  }

  updateActivePane() {
    this.#bindGestures();
  }

  destroy() {
    this.gesture?.destroy?.();
  }
}
