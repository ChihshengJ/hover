/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./touch_controls.js').GestureDetector} GestureDetector;
 * @typedef {import('./search/search_controller.js').SearchController} SearchController;
 */

import { GestureDetector } from "./touch_controls.js";
import { SearchController } from "./search/search_controller.js";
import { ActionButton } from "./action_button.js";
import { RegionSelectController } from "../tools/region_select.js";
import { DrawingController } from "../tools/drawing_controller.js";

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
    /** @type {RegionSelectController} */
    this.regionSelectController = new RegionSelectController(wm);
    /** @type {DrawingController} */
    this.drawingController = null; // initialized after action button
    this.#createDOM();
    this.drawingController = new DrawingController(wm, this.actionButton);
    this.#setupKeyboardShortcuts();
    this.#bindGestures();
    this.MAX_RENDER_SCALE = 7;

    this._lastNavKey = null;
    this._lastNavKeyTime = 0;
  }

  get activePane() {
    return this.wm.activePane;
  }

  #createDOM() {
    const tools = [
      {
        id: "search",
        name: "Search",
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>
        </svg>`,
        activate: () => this.showSearch(),
        deactivate: () => {
          if (this.searchController.isActive)
            this.searchController.deactivate();
        },
      },
      {
        id: "drawing",
        name: "Drawing",
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293z"/>
        </svg>`,
        activate: () => {
          if (this.drawingController?.isActive) {
            this.drawingController.deactivate();
          } else {
            this.drawingController?.activate();
          }
        },
        deactivate: () => this.drawingController?.deactivate(),
      },
      {
        id: "crop",
        name: "Crop",
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M3.5.5A.5.5 0 0 1 4 1v13h13a.5.5 0 0 1 0 1h-2v2a.5.5 0 0 1-1 0v-2H3.5a.5.5 0 0 1-.5-.5V4H1a.5.5 0 0 1 0-1h2V1a.5.5 0 0 1 .5-.5m2.5 3a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-1 0V4H6.5a.5.5 0 0 1-.5-.5"/>
        </svg>`,
        activate: () => {
          if (this.regionSelectController.isActive) {
            this.regionSelectController.deactivate();
          } else {
            this.regionSelectController.activate();
          }
        },
        deactivate: () => this.regionSelectController.deactivate(),
      },
      // {
      //   id: "translation",
      //   name: "Translation",
      //   icon: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
      //     <path d="M4.545 6.714 4.11 8H3l1.862-5h1.284L8 8H6.833l-.435-1.286zm1.634-.736L5.5 3.956h-.049l-.679 2.022z"/>
      //     <path d="M0 2a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3H2a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm7.138 9.995q.289.451.63.846c-.748.575-1.673 1.001-2.768 1.292.178.217.451.635.555.867 1.125-.359 2.08-.844 2.886-1.494.777.665 1.739 1.165 2.93 1.472.133-.254.414-.673.629-.89-1.125-.253-2.057-.694-2.82-1.284.681-.747 1.222-1.651 1.621-2.757H14V8h-3v1.047h.765c-.318.844-.74 1.546-1.272 2.13a6 6 0 0 1-.415-.492 2 2 0 0 1-.94.31"/>
      //   </svg>`,
      //   activate: () => {},
      // },
    ];

    this.actionButton = new ActionButton(tools);
  }

  #setupKeyboardShortcuts() {
    window.addEventListener("resize", async () => {
      for (const p of this.wm.panes) {
        await p.refreshAllPages();
      }
      this.searchController?.refresh();
    });

    document.addEventListener("keydown", (e) => {
      // Handle Escape to close drawing mode
      if (e.key === "Escape" && this.drawingController?.isActive) {
        e.preventDefault();
        this.drawingController.deactivate();
        return;
      }

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
        this.actionButton.activateToolById("search");
        return;
      }

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
        scroller.scrollBy({ top: stepY, behavior: "instant" });
      } else if (["ArrowUp", "k"].includes(e.key)) {
        e.preventDefault();
        scroller.scrollBy({ top: -stepY, behavior: "instant" });
      } else if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        scroller.scrollBy({ left: stepX, behavior: "instant" });
      } else if (e.key === "ArrowLeft" || e.key === "h") {
        e.preventDefault();
        scroller.scrollBy({ left: -stepX, behavior: "instant" });
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

      if (e.key === "G" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pane.scrollToBottom();
        this._lastNavKey = null;
        return;
      }

      if (e.key === "g" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const now = Date.now();
        if (this._lastNavKey === "g" && now - this._lastNavKeyTime < 300) {
          e.preventDefault();
          pane.scrollToTop();
          this._lastNavKey = null;
          return;
        }
        this._lastNavKey = "g";
        this._lastNavKeyTime = now;
        return;
      }

      // Reset sequence tracker on any other key
      this._lastNavKey = null;
    });
  }

  showSearch() {
    if (this.searchController.isActive) {
      this.searchController.deactivate();
    } else {
      this.searchController?.activate();
    }
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
    this.regionSelectController?.deactivate();
    this.drawingController?.deactivate();
    this.searchController?.destroy();
    this.actionButton?.destroy();
  }
}
