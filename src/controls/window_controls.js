/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./touch_controls.js').GestureDetector} GestureDetector;
 * @typedef {import('./search/search_controller.js').SearchController} SearchController;
 */

import { GestureDetector } from "./touch_controls.js";
import { SearchController } from "./search/search_controller.js";

export class WindowControls {
  /**
   * @param {SplitWindowManager} wm;
   */
  constructor(wm) {
    this.wm = wm;
    /** @type {Map<ViewerPane, GestureDetector>} */
    this.gestureDetectors = new Map();
    /** @type {SearchController} */
    this.searchController = new SearchController(wm);
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
      // Refresh search highlights after resize
      this.searchController?.refresh();
    });

    document.addEventListener("keydown", (e) => {
      // Handle Escape to close search (even when in search input)
      if (e.key === "Escape" && this.searchController?.isActive) {
        e.preventDefault();
        this.searchController.deactivate();
        return;
      }

      const activeEl = document.activeElement;
      const isInputActive =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable);

      const isSearchKey = (e.metaKey || e.ctrlKey) && e.key === "f";

      if (isSearchKey) {
        e.preventDefault();
        this.showSearch();
        return;
      }

      // If in input and not a special key we handle, let it pass
      if (isInputActive) {
        return;
      }

      const pane = this.activePane;
      const scroller = this.activePane?.scroller;
      if (!pane || !scroller) return;

      const isZoomKey =
        (e.metaKey || e.ctrlKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0");

      const stepY = scroller.clientHeight * 0.15;
      const stepX = scroller.clientWidth * 0.1;

      if (isZoomKey) {
        e.preventDefault();
        if (e.key === "=" || e.key === "+") pane.zoom(0.25);
        else if (e.key === "-" || e.key === "_") pane.zoom(-0.25);
        else if (e.key === "0")
          pane.zoomAt(1, scroller.clientWidth / 2, scroller.clientHeight / 2);
        // Refresh search highlights after zoom
        this.searchController?.refresh();
        return;
      }

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

  showSearch() {
    this.searchController?.activate();
  }

  #bindGestures() {
    for (const pane of this.wm.panes) {
      this.#bindGestureToPane(pane);
    }
  }

  #bindGestureToPane(pane) {
    if (this.gestureDetectors.has(pane)) return;

    const gesture = new GestureDetector(pane.paneEl);
    this.gestureDetectors.set(pane, gesture);

    let startScale = 1;
    let isTransforming = false;
    let pageStates = new Map();

    gesture.getEventTarget().addEventListener("pinchstart", (e) => {
      this.wm.setActivePane(pane);

      startScale = pane.scale;
      isTransforming = true;
      pageStates.clear();

      const pinchX = e.detail.center.x;
      const pinchY = e.detail.center.y;

      const paneRect = pane.paneEl.getBoundingClientRect();
      const scrollerRect = pane.scroller.getBoundingClientRect();
      const scrollerOffsetX = scrollerRect.left - paneRect.left;
      const scrollerOffsetY = scrollerRect.top - paneRect.top;

      const docPinchX = pane.scroller.scrollLeft + (pinchX - scrollerOffsetX);
      const docPinchY = pane.scroller.scrollTop + (pinchY - scrollerOffsetY);

      const wrappers = pane.stage.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const wrapperLeft = wrapper.offsetLeft;
        const wrapperTop = wrapper.offsetTop;
        const wrapperWidth = wrapper.offsetWidth;
        const wrapperHeight = wrapper.offsetHeight;

        const percentX = ((docPinchX - wrapperLeft) / wrapperWidth) * 100;
        const percentY = ((docPinchY - wrapperTop) / wrapperHeight) * 100;

        pageStates.set(wrapper, { percentX, percentY });
      });
    });

    gesture.getEventTarget().addEventListener("pinchupdate", (e) => {
      if (!isTransforming) return;

      const ratio = e.detail.startScaleRatio;
      const newScale = Math.max(
        0.5,
        Math.min(this.MAX_RENDER_SCALE, startScale * ratio),
      );
      const visualScaleDelta = newScale / startScale;

      const wrappers = pane.stage.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        const state = pageStates.get(wrapper);
        if (!state) return;

        wrapper.style.transformOrigin = `${state.percentX}% ${state.percentY}%`;
        wrapper.style.transform = `scale(${visualScaleDelta})`;
      });
    });

    gesture.getEventTarget().addEventListener("pinchend", (e) => {
      if (!isTransforming) return;

      // Clear transforms first
      const wrappers = pane.stage.querySelectorAll(".page-wrapper");
      wrappers.forEach((wrapper) => {
        wrapper.style.transform = "";
        wrapper.style.transformOrigin = "";
      });

      const ratio = e.detail.startScaleRatio;
      const finalScale = Math.max(
        0.5,
        Math.min(this.MAX_RENDER_SCALE, startScale * ratio),
      );

      const paneRect = pane.paneEl.getBoundingClientRect();
      const scrollerRect = pane.scroller.getBoundingClientRect();
      const scrollerOffsetX = scrollerRect.left - paneRect.left;
      const scrollerOffsetY = scrollerRect.top - paneRect.top;

      const focusX = e.detail.center.x - scrollerOffsetX;
      const focusY = e.detail.center.y - scrollerOffsetY;

      pane.zoomAt(finalScale, focusX, focusY);

      isTransforming = false;
      pageStates.clear();
      if (!pane.controls.isHidden) {
        pane.controls.updateZoomDisplay();
      }

      // Refresh search highlights after pinch zoom
      this.searchController?.refresh();
    });
  }

  #unbindGestureFromPane(pane) {
    const gesture = this.gestureDetectors.get(pane);
    if (gesture) {
      gesture.destroy?.();
      this.gestureDetectors.delete(pane);
    }
  }

  #switchActivePane() {
    const panes = this.wm.panes;
    if (panes.length < 2) return;

    const currentIndex = panes.indexOf(this.activePane);
    const nextIndex = (currentIndex + 1) % panes.length;
    this.wm.setActivePane(panes[nextIndex]);

    // Notify search controller of pane change
    this.searchController?.onPaneChange();
  }

  updateActivePane() {
    this.#bindGestures();
    // Notify search controller of pane change
    this.searchController?.onPaneChange();
  }

  onPaneAdded(pane) {
    this.#bindGestureToPane(pane);
  }

  onPaneRemoved(pane) {
    this.#unbindGestureFromPane(pane);
  }

  destroy() {
    for (const [pane, gesture] of this.gestureDetectors) {
      gesture.destroy?.();
    }
    this.gestureDetectors.clear();
    this.searchController?.destroy();
  }
}
