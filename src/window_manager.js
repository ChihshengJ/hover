/**
 * @typedef {import('./viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('./doc.js').PDFDocumentModel} PDFDocumentModel;
 * @typedef {import('./controls/floating_toolbar.js') FloatingToolbar};
 */

import { ViewerPane } from "./viewpane.js";
import { FloatingToolbar } from "./controls/floating_toolbar.js";
import { WindowControls } from "./controls/window_controls.js";

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
  }

  async initialize() {
    const container = this.#createPaneContainer();
    const pane = new ViewerPane(this.document, container, { id: "main" });
    await pane.initialize();

    this.panes.push(pane);
    this.activePane = pane;

    this.#updateLayout();
    this.toolbar = new FloatingToolbar(this);
    this.toolbar.updatePageNumber();

    this.controls = new WindowControls(this);
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
    for (const p of this.panes) {
      p.controls.show();
    }
    this.#updateLayout();
    this.#createResizer();

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
    this.splitDirection = null;

    this.toolbar.exitSplitMode();
    this.toolbar.updateActivePane(this.panes[0]);
    this.controls.updateActivePane(this.panes[0]);
    for (const p of this.panes) {
      p.controls.hide();
    }
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
      const ratioA = `${this.splitRatio * 100}%`;
      const ratioB = `${(1 - this.splitRatio) * 100}%`;

      if (this.splitDirection === "vertical") {
        paneA.paneEl.style.width = ratioA;
        paneB.paneEl.style.width = ratioB;
        paneA.paneEl.style.height = "100%";
        paneB.paneEl.style.height = "100%";
      } else {
        paneA.paneEl.style.height = ratioA;
        paneB.paneEl.style.height = ratioB;
        paneA.paneEl.style.width = "100%";
        paneB.paneEl.style.width = "100%";
      }
    } else if (this.panes[0]) {
      this.panes[0].paneEl.style.width = "100%";
      this.panes[0].paneEl.style.height = "100%";
    }
  }

  #createResizer() {
    this.resizer = document.createElement("div");
    this.resizer.className = `split-resizer ${this.splitDirection}`;

    let startPos, startRatio;

    const onMouseDown = (e) => {
      e.preventDefault();
      startPos = this.splitDirection === "vertical" ? e.clientX : e.clientY;
      startRatio = this.splitRatio;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      this.resizer.classList.add("dragging");
    };

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

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      this.resizer.classList.remove("dragging");
    };

    this.resizer.addEventListener("mousedown", onMouseDown);

    // Insert resizer between panes
    this.rootEl.insertBefore(this.resizer, this.panes[1].paneEl);
  }

  #removeResizer() {
    this.resizer?.remove();
    this.resizer = null;
  }

  setActivePane(pane) {
    if (!pane || pane === this.activePane) return;

    this.activePane?.paneEl.classList.remove("active");
    this.activePane = pane;
    this.activePane.paneEl.classList.add("active");

    this.toolbar.updateActivePane();
    this.controls.updateActivePane();
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
  }
}
