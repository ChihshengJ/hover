/**
 * Dispatches tool-button actions (zoom/rotate/split/spread/fit) to the
 * right target (pane or window manager) and keeps the matching icon state
 * (spread, fit, rotate) in sync with the model.
 */

import type { ViewerPane } from "../../../viewer/viewpane.js";
import type { SplitWindowManager } from "../../../viewer/window_manager.js";
import type { SpreadMode } from "../../../viewer/viewpane.js";
export interface ToolActionOptions {
  wm: SplitWindowManager;
  toolbarTop: HTMLElement;
  toolbarBottom: HTMLElement;
  getPane: () => ViewerPane | null;
}

/** The `data-action` of every button the toolbar carries. */
export type ToolAction =
  | "zoom-in"
  | "zoom-out"
  | "rotate"
  | "split-screen"
  | "horizontal-spread"
  | "fit-width";

export class ToolActions {
  wm: ToolActionOptions["wm"];
  toolbarTop: ToolActionOptions["toolbarTop"];
  toolbarBottom: ToolActionOptions["toolbarBottom"];
  getPane: ToolActionOptions["getPane"];
  _cumulativeRotation: number;
  _lastRotateClick: number;
  _rotateClickTimeout: ReturnType<typeof setTimeout> | null;

  /**
   * @param {Object} opts
   * @param {{isSplit: boolean, split: () => void, unsplit: () => void}} opts.wm
   * @param {HTMLElement} opts.toolbarTop
   * @param {HTMLElement} opts.toolbarBottom
   * @param {() => any} opts.getPane  Lazily resolves the active pane.
   */
  constructor({ wm, toolbarTop, toolbarBottom, getPane }: ToolActionOptions) {
    this.wm = wm;
    this.toolbarTop = toolbarTop;
    this.toolbarBottom = toolbarBottom;
    this.getPane = getPane;

    this._cumulativeRotation = 0;
    this._lastRotateClick = 0;
    this._rotateClickTimeout = null;
  }

  handle(action: ToolAction) {
    const pane = this.getPane();
    switch (action) {
      case "zoom-in":
        pane.zoom(0.25);
        if (!pane.controls.isHidden) {
          pane.controls.updateZoomDisplay();
        }
        break;
      case "zoom-out":
        pane.zoom(-0.25);
        if (!pane.controls.isHidden) {
          pane.controls.updateZoomDisplay();
        }
        break;
      case "rotate":
        this.#handleRotateClick();
        break;
      case "split-screen":
        if (!this.wm.isSplit) {
          this.wm.split();
        } else {
          this.wm.unsplit();
        }
        break;
      case "horizontal-spread":
        this.#spread();
        break;
      case "fit-width": {
        const fitMode = pane.fit();
        this.#updateFitIcon(fitMode);
        break;
      }
    }
  }

  /** Called when the active pane changes — sync the rotate icon. */
  syncWithPane() {
    this._cumulativeRotation = this.getPane().rotation;
    this.#updateRotateIcon();
  }

  #spread() {
    if (!this.wm.isSplit) {
      const newMode = this.getPane().spread();
      this.#updateSpreadIcon(newMode);
    }
  }

  #updateSpreadIcon(mode: SpreadMode) {
    const btn = this.toolbarTop.querySelector(
      '[data-action="horizontal-spread"]',
    ) as HTMLElement;
    const img = btn.querySelector("img") as HTMLImageElement;

    const config: Record<SpreadMode, { src: string; title: string }> = {
      0: { src: "assets/book.svg", title: "Single page view" },
      1: { src: "assets/even.png", title: "Even spread (1-2, 3-4...)" },
      2: { src: "assets/odd.png", title: "Odd spread (1, 2-3, 4-5...)" },
    };

    const { src, title } = config[mode];
    img.src = src;
    btn.title = title;
  }

  #updateFitIcon(fitMode: number) {
    const btn = this.toolbarBottom.querySelector(
      '[data-action="fit-width"]',
    ) as HTMLElement;
    const img = btn.querySelector("img") as HTMLImageElement;

    if (fitMode === 1) {
      img.src = "assets/fit_width.svg";
      img.width = 20;
      btn.title = "Fit horizontal";
      btn.classList.add("active");
    } else {
      img.src = "assets/fit_height.svg";
      img.width = 18;
      btn.title = "Fit vertical";
      btn.classList.remove("active");
    }
  }

  #handleRotateClick() {
    const pane = this.getPane();
    const now = Date.now();
    if (this._rotateClickTimeout) {
      clearTimeout(this._rotateClickTimeout);
      this._rotateClickTimeout = null;
    }

    if (now - this._lastRotateClick < 250) {
      // Double-click — reset rotation to 0°
      pane.resetRotation();
      this._cumulativeRotation = 0;
      this.#updateRotateIcon();
      this._lastRotateClick = 0;
    } else {
      // Single-click — wait to distinguish from double-click
      this._lastRotateClick = now;
      this._rotateClickTimeout = setTimeout(() => {
        this._rotateClickTimeout = null;
        pane.rotate();
        this._cumulativeRotation += 90;
        this.#updateRotateIcon();
      }, 250);
    }
  }

  #updateRotateIcon() {
    const btn = this.toolbarTop.querySelector('[data-action="rotate"]');
    const icon = btn?.querySelector(".rotate-icon") as HTMLElement;
    if (!icon) return;

    icon.style.transform = `rotate(${this._cumulativeRotation}deg)`;
    btn.classList.toggle("active", this.getPane().rotation !== 0);
  }
}
