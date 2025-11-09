/**
 * @typedef {import('../viewer.js').PDFViewer} PDFViewer
 * @typedef {import('../helpers.js').GestureDetector} GestureDetector;
 */

import { GestureDetector } from "../helpers.js";

export class ViewerControls {
  /**
   * @param {PDFViewer} viewer
   * @param {GestureDetector} gesture
   * @param {HTMLElement} toolEl
   */
  constructor(viewer, el) {
    this.viewer = viewer;
    this.el = el;
    this.gesture = new GestureDetector(el.viewer);
    this.#setupOnetimeListener();
    this.#setupUIListeners();
    this.#setupKeyboardShortcuts();
    this.#setupGestures();
  }

  #setupOnetimeListener() {
    this.viewer.viewerEl.addEventListener("scroll", () => {
      const currentPage = this.viewer.getCurrentPage();
      this.el.pageNum.textContent = currentPage;
    });
    window.addEventListener("resize", () => {
      this.viewer.renderAtScale(this.viewer.getScale());
    });
  }

  #setupUIListeners() {
    this.el.zoomInBtn.addEventListener("click", () => this.viewer.zoom(0.25));
    this.el.zoomOutBtn.addEventListener("click", () => this.viewer.zoom(-0.25));
    this.el.nextBtn.addEventListener("click", () =>
      this.viewer.scrollToRelative(1),
    );
    this.el.prevBtn.addEventListener("click", () =>
      this.viewer.scrollToRelative(-1),
    );
  }

  #setupKeyboardShortcuts() {
    const scroller = this.viewer.viewerEl;
    document.addEventListener("keydown", (e) => {
      const isZoomKey =
        (e.metaKey || e.ctrlKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0");

      const stepY = 100;
      const stepX = 80;

      if (isZoomKey) {
        e.preventDefault();
        if (e.key === "=" || e.key === "+") this.viewer.zoom(0.25);
        else if (e.key === "-" || e.key === "_") this.viewer.zoom(-0.25);
        else if (e.key === "0")
          this.viewer.zoomAt(
            1,
            scroller.clientWidth / 2,
            scroller.clientHeight / 2,
          );
        return;
      }

      if (["ArrowDown", "j"].includes(e.key)) {
        e.preventDefault();
        this.viewer.scrollToRelative(1);
      } else if (["ArrowUp", "k"].includes(e.key)) {
        e.preventDefault();
        this.viewer.scrollToRelative(-1);
      } else if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        scroller.scrollLeft += stepX;
      } else if (e.key === "ArrowLeft" || e.key === "h") {
        e.preventDefault();
        scroller.scrollLeft -= stepX;
      }
    });
  }

  #setupGestures() {
    let startScale = 1;
    let isTransforming = false;
    let pageStates = new Map();
    
    this.gesture.getEventTarget().addEventListener("pinchstart", (e) => {
      startScale = this.viewer.getScale();
      isTransforming = true;
      pageStates.clear();
      
      // Get pinch center in viewport coordinates
      const containerRect = this.el.viewer.getBoundingClientRect();
      const pinchX = e.detail.center.x;
      const pinchY = e.detail.center.y;
      
      // Store original state for each page wrapper
      const wrappers = this.el.viewer.querySelectorAll('.page-wrapper');
      wrappers.forEach(wrapper => {
        const wrapperRect = wrapper.getBoundingClientRect();
        
        // Calculate pinch point as percentage of wrapper dimensions
        const percentX = ((pinchX - wrapperRect.left) / wrapperRect.width) * 100;
        const percentY = ((pinchY - wrapperRect.top) / wrapperRect.height) * 100;
        
        pageStates.set(wrapper, {
          originalTransform: wrapper.style.transform,
          originalOrigin: wrapper.style.transformOrigin,
          percentX: percentX,
          percentY: percentY
        });
      });
    });

    this.gesture.getEventTarget().addEventListener("pinchupdate", (e) => {
      if (!isTransforming) return;
      
      const ratio = e.detail.startScaleRatio;
      const newScale = Math.max(0.5, Math.min(4, startScale * ratio));
      const visualScaleDelta = newScale / startScale;
      
      // Apply scale with fixed transform-origin for each wrapper
      const wrappers = this.el.viewer.querySelectorAll('.page-wrapper');
      wrappers.forEach(wrapper => {
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
      
      // Restore original state for all wrappers
      const wrappers = this.el.viewer.querySelectorAll('.page-wrapper');
      wrappers.forEach(wrapper => {
        const state = pageStates.get(wrapper);
        if (!state) return;
        
        wrapper.style.transform = state.originalTransform;
        wrapper.style.transformOrigin = state.originalOrigin;
      });
      
      const ratio = e.detail.startScaleRatio;
      const finalScale = Math.max(0.5, Math.min(4, startScale * ratio));
      
      // Apply actual zoom (re-renders canvases)
      const containerRect = this.el.viewer.getBoundingClientRect();
      const focusX = e.detail.center.x - containerRect.left;
      const focusY = e.detail.center.y - containerRect.top;
      this.viewer.zoomAt(finalScale, focusX, focusY);
      
      isTransforming = false;
      pageStates.clear();
    });
  }
}
