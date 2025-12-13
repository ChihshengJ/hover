import { ViewerPane } from "./viewpane.js";
import { FloatingToolbar } from "./controls/floating_toolbar.js";

export class SplitWindowManager {
  constructor(rootEl, documentModel) {
    this.rootEl = rootEl;
    this.document = documentModel;
    this.panes = [];
    this.splitDirection = null; // 'horizontal' | 'vertical' | null
    this.splitRatio = 0.5;
    this.activePane = null;
    this.isSplit = false;

    this.toolbar = null;
  }

  async initialize() {
    // Create the first pane
    const container = this.#createPaneContainer();
    const pane = new ViewerPane(this.document, container, { id: "main" });
    await pane.initialize();

    this.panes.push(pane);
    this.activePane = pane;

    this.#updateLayout();
    this.toolbar = new FloatingToolbar(pane, this);
    this.toolbar.updatePageNumber();
  }

  #createPaneContainer() {
    const container = document.createElement("div");
    container.className = "viewer-pane";

    container.addEventListener("click", () => {
      this.setActivePane(this.panes.find((p) => p.viewerEl === container));
    });

    container.addEventListener(
      "focus",
      () => {
        this.setActivePane(this.panes.find((p) => p.viewerEl === container));
      },
      true,
    );

    this.rootEl.appendChild(container);
    return container;
  }

  async split(direction = "vertical") {
    if (this.panes.length >= 2 || this.isSplit) return; // Max 2 panes for now

    this.splitDirection = direction;

    const container = this.#createPaneContainer();
    const newPane = new ViewerPane(this.document, container, {
      id: "secondary",
      pinned: false,
    });
    await newPane.initialize();

    // Start the new pane at the same page as the current
    const currentPage = this.activePane.getCurrentPage();
    newPane.goToPage(currentPage);

    this.panes.push(newPane);

    this.toolbar.enterSplitMode();
    this.#updateLayout();
    this.#createResizer();
    
    this.isSplit = true;

    return newPane;
  }

  unsplit() {
    if (this.panes.length <= 1 || !this.isSplit) return;

    const paneToRemove = this.panes[1];
    paneToRemove.destroy();
    paneToRemove.viewerEl.remove();

    this.panes = [this.panes[0]];
    this.activePane = this.panes[0];
    this.splitDirection = null;

    this.toolbar.exitSplitMode();
    this.toolbar.updateActivePane(this.panes[0]);
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
        paneA.viewerEl.style.width = ratioA;
        paneB.viewerEl.style.width = ratioB;
        paneA.viewerEl.style.height = "100%";
        paneB.viewerEl.style.height = "100%";
      } else {
        paneA.viewerEl.style.height = ratioA;
        paneB.viewerEl.style.height = ratioB;
        paneA.viewerEl.style.width = "100%";
        paneB.viewerEl.style.width = "100%";
      }
    } else if (this.panes[0]) {
      this.panes[0].viewerEl.style.width = "100%";
      this.panes[0].viewerEl.style.height = "100%";
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
    this.rootEl.insertBefore(this.resizer, this.panes[1].viewerEl);
  }

  #removeResizer() {
    this.resizer?.remove();
    this.resizer = null;
  }

  setActivePane(pane) {
    if (!pane || pane === this.activePane) return;

    this.activePane?.viewerEl.classList.remove("active");
    this.activePane = pane;
    this.activePane.viewerEl.classList.add("active");

    this.toolbar.updateActivePane(pane);
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
