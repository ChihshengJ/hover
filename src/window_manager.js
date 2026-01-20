/**
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./controls/floating_toolbar.js') FloatingToolbar};
 * @typedef {import('./controls/progress_bar.js') ProgressBar};
 */

import { ViewerPane } from "./viewpane.js";
import { FloatingToolbar } from "./controls/floating_toolbar.js";
import { WindowControls } from "./controls/window_controls.js";
import { ProgressBar } from "./controls/progress_bar.js";

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
  }

  #createPaneContainer() {
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

    this.rootEl.appendChild(container);
    return container;
  }

  async split(direction = "vertical") {
    if (this.panes.length >= 2 || this.isSplit) return;

    // capture viewport before split
    const primaryPane = this.activePane;
    this.setActivePane(primaryPane);
    const currentScale = primaryPane.scale;
    const currentScrollTop = primaryPane.scroller.scrollTop;
    const currentScrollLeft = primaryPane.scroller.scrollLeft;

    this.splitDirection = direction;
    const container = this.#createPaneContainer();
    const newPane = new ViewerPane(this.document, container, {
      id: "secondary",
      pinned: false,
    });

    await newPane.initialize(currentScale);

    this.panes.push(newPane);
    this.toolbar.enterSplitMode();
    this.#updateLayout();
    this.#createResizer();

    // Enter split mode for progress bar
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
        newPane.scroller.scrollTop = currentScrollTop;
        newPane.scroller.scrollLeft = currentScrollLeft;
      });
    });

    this.isSplit = true;
    return newPane;
  }

  unsplit() {
    if (this.panes.length <= 1 || !this.isSplit) return;

    const paneToRemove = this.panes[1];
    paneToRemove.destroy();
    paneToRemove.paneEl.remove();

    this.panes = [this.panes[0]];
    this.activePane = this.panes[0];
    this.activePane?.paneEl.classList.remove("active");
    this.splitDirection = null;

    this.toolbar.exitSplitMode();
    this.toolbar.updateActivePane(this.panes[0]);
    this.controls.updateActivePane(this.panes[0]);

    // Exit split mode for progress bar
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
      startPos = this.splitDirection === "vertical" ? e.clientX : e.clientY;
      startRatio = this.splitRatio;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      this.resizer.classList.add("dragging");
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      this.resizer.classList.remove("dragging");
    };

    const onDoubleClick = (e) => {
      e.preventDefault();
      this.splitRatio = 0.5;
      this.#updateLayout();
    };

    this.resizer.addEventListener("mousedown", onMouseDown);
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
