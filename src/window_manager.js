/**
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./controls/floating_toolbar/index.js') FloatingToolbar};
 * @typedef {import('./controls/progress_bar.js') ProgressBar};
 */

import { ViewerPane } from "./viewpane.js";
import { FloatingToolbar } from "./controls/floating_toolbar/index.js";
import { WindowControls } from "./controls/window_controls.js";
import { ProgressBar } from "./controls/progress_bar.js";
import { Config } from "./settings/config.js";
import { beginDragGuard, endDragGuard } from "./drag_guard.js";

export class SplitWindowManager {
  /**
   * @param {HTMLElement} rootEl;
   * @param {PDFDocumentModel} DocumentModel;
   */
  constructor(rootEl, documentModel) {
    this.rootEl = rootEl;
    this.document = documentModel;
    /** @type {ViewerPane[]} */
    this.panes = [];
    this.splitDirection = null; // 'horizontal' | 'vertical' | null
    this.splitRatio = 0.5;
    /** @type {ViewerPane} */
    this.activePane = null;
    this.isSplit = false;

    this.survivorSide = "left";
    /** @type {{ side: 'left'|'right', scale: number, scrollTop: number, scrollLeft: number } | null} */
    this.savedSlot = null;
    this.paneCounter = 0;

    this.toolbar = null;
    this.controls = null;
    /** @type {ProgressBar} */
    this.progressBar = null;
  }

  async initialize() {
    const container = this.#createPaneContainer();
    const pane = new ViewerPane(this.document, container, { id: "main" });
    await pane.initialize();

    this.panes.push(pane);
    this.activePane = pane;

    // The order matters here, the toolbar needs to be initialized first.
    this.#updateLayout();
    this.toolbar = new FloatingToolbar(this);
    this.toolbar.updatePageNumber();
    this.controls = new WindowControls(this);
    this.progressBar = new ProgressBar(this);
    await this.progressBar.initialize();

    await this.#applyPersistedSplit();
  }

  async #applyPersistedSplit() {
    if (!Config.get("split_persist")) return;
    const saved = Config.get("split_state");
    if (!saved || !saved.direction) return;
    if (typeof saved.ratio === "number") this.splitRatio = saved.ratio;
    await this.split(saved.direction);
  }

  #persistSplitStateIfEnabled() {
    if (!Config.get("split_persist")) return;
    if (this.isSplit) {
      Config.set("split_state", {
        direction: this.splitDirection,
        ratio: this.splitRatio,
      });
    } else {
      Config.set("split_state", null);
    }
  }

  /**
   * @param {HTMLElement | null} insertBeforeEl - if provided, the container is
   *   inserted before this element (left/top slot); otherwise appended (right).
   */
  #createPaneContainer(insertBeforeEl = null) {
    const container = document.createElement("div");
    container.className = "viewer-pane";

    container.addEventListener("click", () => {
      this.setActivePane(this.panes.find((p) => p.paneEl === container));
    });

    container.addEventListener(
      "focus",
      () => {
        this.setActivePane(this.panes.find((p) => p.paneEl === container));
      },
      true,
    );

    if (insertBeforeEl) {
      this.rootEl.insertBefore(container, insertBeforeEl);
    } else {
      this.rootEl.appendChild(container);
    }
    return container;
  }

  async split(direction = "vertical") {
    if (this.panes.length >= 2 || this.isSplit) return;

    const existingPane = this.activePane;
    this.setActivePane(existingPane);
    this.splitDirection = direction;
    const newPaneSide = this.survivorSide === "left" ? "right" : "left";
    const restore =
      this.savedSlot && this.savedSlot.side === newPaneSide
        ? this.savedSlot
        : null;
    const seedScale = restore ? restore.scale : existingPane.scale;
    const seedScrollTop = restore
      ? restore.scrollTop
      : existingPane.scroller.scrollTop;
    const seedScrollLeft = restore
      ? restore.scrollLeft
      : existingPane.scroller.scrollLeft;

    const container = this.#createPaneContainer(
      newPaneSide === "left" ? existingPane.paneEl : null,
    );
    const newPane = new ViewerPane(this.document, container, {
      id: `secondary-${++this.paneCounter}`,
      pinned: false,
    });

    await newPane.initialize(seedScale);

    if (newPaneSide === "left") {
      this.panes.unshift(newPane);
    } else {
      this.panes.push(newPane);
    }
    this.toolbar.enterSplitMode();
    this.#updateLayout();
    this.#createResizer();

    this.progressBar?.enterSplitMode();
    for (const p of this.panes) {
      p.controls.attach();
    }

    // Ensuring controls are rendered before being shown
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const p of this.panes) {
          p.controls.show();
        }
      });
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newPane.scroller.scrollTop = seedScrollTop;
        newPane.scroller.scrollLeft = seedScrollLeft;
      });
    });

    this.isSplit = true;
    this.savedSlot = null;
    this.#persistSplitStateIfEnabled();
    return newPane;
  }

  unsplit() {
    if (this.panes.length <= 1 || !this.isSplit) return;
    const paneToKeep = this.activePane ?? this.panes[0];
    const paneToRemove =
      this.panes.find((p) => p !== paneToKeep) ?? this.panes[1];
    this.survivorSide = this.panes.indexOf(paneToKeep) === 0 ? "left" : "right";
    this.savedSlot = {
      side: this.panes.indexOf(paneToRemove) === 0 ? "left" : "right",
      scale: paneToRemove.scale,
      scrollTop: paneToRemove.scroller.scrollTop,
      scrollLeft: paneToRemove.scroller.scrollLeft,
    };

    paneToRemove.destroy();
    paneToRemove.paneEl.remove();

    this.panes = [paneToKeep];
    this.activePane = paneToKeep;
    this.activePane?.paneEl.classList.remove("active");
    this.splitDirection = null;

    this.toolbar.exitSplitMode();
    this.toolbar.updateActivePane(paneToKeep);
    this.controls.updateActivePane(paneToKeep);

    this.progressBar?.exitSplitMode();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const p of this.panes) {
          p.controls.hide();
        }
      });
    });
    setTimeout(() => {
      for (const p of this.panes) {
        p.controls.element.remove();
      }
    }, 200);
    this.#removeResizer();
    this.#updateLayout();
    this.isSplit = false;
    this.#persistSplitStateIfEnabled();
  }

  #updateLayout() {
    this.rootEl.classList.add("window-container");
    this.rootEl.classList.toggle(
      "split-horizontal",
      this.splitDirection === "horizontal",
    );
    this.rootEl.classList.toggle(
      "split-vertical",
      this.splitDirection === "vertical",
    );
    this.rootEl.classList.toggle("single-pane", !this.splitDirection);

    if (this.splitDirection) {
      const [paneA, paneB] = this.panes;
      // This must match the CSS!!!
      const resizerSize = 4;

      if (this.splitDirection === "vertical") {
        paneA.paneEl.style.flex = "none";
        paneB.paneEl.style.flex = "none";
        paneA.paneEl.style.width = `calc(${this.splitRatio * 100}% - ${resizerSize / 2}px)`;
        paneB.paneEl.style.width = `calc(${(1 - this.splitRatio) * 100}% - ${resizerSize / 2}px)`;
        paneA.paneEl.style.height = "100%";
        paneB.paneEl.style.height = "100%";
      } else {
        paneA.paneEl.style.flex = "none";
        paneB.paneEl.style.flex = "none";
        paneA.paneEl.style.height = `calc(${this.splitRatio * 100}% - ${resizerSize / 2}px)`;
        paneB.paneEl.style.height = `calc(${(1 - this.splitRatio) * 100}% - ${resizerSize / 2}px)`;
        paneA.paneEl.style.width = "100%";
        paneB.paneEl.style.width = "100%";
      }
    } else if (this.panes[0]) {
      this.panes[0].paneEl.style.flex = "1";
      this.panes[0].paneEl.style.width = "100%";
      this.panes[0].paneEl.style.height = "100%";
    }
  }

  #createResizer() {
    this.resizer = document.createElement("div");
    this.resizer.className = `split-resizer ${this.splitDirection}`;

    let startPos, startRatio;

    const onMouseMove = (e) => {
      const rect = this.rootEl.getBoundingClientRect();
      const currentPos =
        this.splitDirection === "vertical" ? e.clientX : e.clientY;
      const totalSize =
        this.splitDirection === "vertical" ? rect.width : rect.height;
      const delta = (currentPos - startPos) / totalSize;

      this.splitRatio = Math.max(0.2, Math.min(0.8, startRatio + delta));
      this.#updateLayout();
    };

    const onMouseDown = (e) => {
      e.preventDefault();
      // preventDefault() on pointerdown doesn't stop native text selection
      // on Safari/Firefox — the guard does.
      beginDragGuard();
      this.resizer.setPointerCapture(e.pointerId);
      startPos = this.splitDirection === "vertical" ? e.clientX : e.clientY;
      startRatio = this.splitRatio;
      document.addEventListener("pointermove", onMouseMove);
      document.addEventListener("pointerup", onMouseUp);
      document.addEventListener("pointercancel", onMouseUp);
      this.resizer.classList.add("dragging");
    };

    const onMouseUp = () => {
      endDragGuard();
      document.removeEventListener("pointermove", onMouseMove);
      document.removeEventListener("pointerup", onMouseUp);
      document.removeEventListener("pointercancel", onMouseUp);
      this.resizer.classList.remove("dragging");
      this.#persistSplitStateIfEnabled();
    };

    const onDoubleClick = (e) => {
      e.preventDefault();
      this.splitRatio = 0.5;
      this.#updateLayout();
      this.#persistSplitStateIfEnabled();
    };

    this.resizer.addEventListener("pointerdown", onMouseDown);
    this.resizer.addEventListener("dblclick", onDoubleClick);

    this.rootEl.insertBefore(this.resizer, this.panes[1].paneEl);
  }

  #removeResizer() {
    this.resizer?.remove();
    this.resizer = null;
  }

  setActivePane(pane) {
    if (!pane) return;

    this.activePane?.paneEl.classList.remove("active");
    this.activePane = pane;
    this.activePane.paneEl.classList.add("active");

    this.toolbar.updateActivePane();
    this.controls.updateActivePane();

    // Update progress bar active pane
    this.progressBar?.updateActivePane();
  }

  get currentPage() {
    return this.activePane?.getCurrentPage() || 1;
  }

  get totalPages() {
    return this.document.numPages;
  }

  get scale() {
    return this.activePane?.scale || 1;
  }

  zoom(delta) {
    this.activePane?.zoom(delta);
    // Refresh progress bar after zoom
    this.progressBar?.refresh();
  }
}
