/**
 * `NavigationTree` is imported as a value below, so it is already usable as a
 * type.
 *
 * @typedef {SplitWindowManager} SplitWindowManager
 * @typedef {ViewerPane} ViewerPane
 */

import { NavigationTree } from "../navigation_tree.js";
import { Config } from "../../settings/config.js";
import { ToolButtonTooltip } from "./tool_button_tooltip.js";
import { JumpPopup } from "./jump_popup.js";
import { JumpIndicators } from "./jump_indicators.js";
import { AutoHideController } from "./auto_hide_controller.js";
import { ExpandController } from "./expand_controller.js";
import { ToolActions } from "./tool_actions.js";
import type { ToolAction } from "./tool_actions.js";
import { TreeIntegration } from "./tree_integration.js";
import { DragController } from "./drag_controller.js";
import { buildToolbarDom } from "./toolbar_dom.js";
import { GlassEffect } from "./liquid_glass/glass_effect.js";

import type { ViewerPane } from "../../../viewer/viewpane.js";
import type { SplitWindowManager } from "../../../viewer/window_manager.js";
export class FloatingToolbar {
  wm: SplitWindowManager;
  lastClickTime: number;
  clickTimeout: ReturnType<typeof setTimeout> | null;
  wrapper: HTMLElement;
  ballOriginalRight: number;
  navigationTree: NavigationTree;
  expandController: ExpandController;
  autoHide: AutoHideController;
  jumpPopup: JumpPopup;
  jumpIndicators: JumpIndicators;
  toolActions: ToolActions;
  treeIntegration: TreeIntegration;
  glassEffect: GlassEffect;
  dragController: DragController;
  gooContainer: HTMLElement;
  ball: HTMLElement;
  toolbarTop: HTMLElement;
  toolbarBottom: HTMLElement;
  tooltip: ToolButtonTooltip;

  /**
   * @param wm ;
   */

  constructor(wm: SplitWindowManager) {
    this.wm = wm;
    this.lastClickTime = 0;
    this.clickTimeout = null;
    this.wrapper = null;

    this.#scrollCallback = () => this.updatePageNumber();

    this.ballOriginalRight = 20;

    this.#createToolbar();
    this.navigationTree = new NavigationTree({
      doc: this.wm.document,
      getPane: () => this.pane,
      getBallCenterY: () => {
        const rect = this.ball.getBoundingClientRect();
        return rect.top + rect.height / 2;
      },
    });
    this.expandController = new ExpandController({
      wrapper: this.wrapper,
      toolbarTop: this.toolbarTop,
      toolbarBottom: this.toolbarBottom,
      autoCollapse: Config.get("toolbar_auto_collapse"),
    });
    this.autoHide = new AutoHideController({
      wrapper: this.wrapper,
      isTreeOpen: () => this.isTreeOpen,
      onSlideOutCollapse: () => this.expandController.collapse(),
    });
    this.autoHide.init();
    this.jumpPopup = new JumpPopup({
      ball: this.ball,
      getPane: () => this.pane,
      onOpen: () => this.autoHide.cancelHideTimer(),
    });
    this.jumpIndicators = new JumpIndicators({
      wrapper: this.wrapper,
      isDragging: () => this.isDragging,
      onExecute: (direction) => this.dragController.executeJump(direction),
    });
    this.toolActions = new ToolActions({
      wm: this.wm,
      toolbarTop: this.toolbarTop,
      toolbarBottom: this.toolbarBottom,
      getPane: () => this.pane,
    });
    this.treeIntegration = new TreeIntegration({
      wrapper: this.wrapper,
      gooContainer: this.gooContainer,
      navigationTree: this.navigationTree,
      expandController: this.expandController,
      ballOriginalRight: this.ballOriginalRight,
    });
    this.glassEffect = new GlassEffect({
      wrapper: this.wrapper,
      gooContainer: this.gooContainer,
      ball: this.ball,
    });
    // The jump popup renders on <body>, outside the wrapper that carries
    // data-glass, so hand its chrome to GlassEffect explicitly. It then
    // follows the liquid-glass toggle and the adaptive text color in step
    // with the tool buttons and the page number.
    this.jumpPopup.glassElements.forEach((el) =>
      this.glassEffect.attachGlassState(el),
    );
    this.dragController = new DragController({
      ball: this.ball,
      gooContainer: this.gooContainer,
      glassEffect: this.glassEffect,
      getPane: () => this.pane,
      isTreeOpen: () => this.isTreeOpen,
      jumpIndicators: this.jumpIndicators,
      treeOpenThreshold: 100,
      hooks: {
        onDragStart: () => {
          this.autoHide.cancelHideTimer();
          this.expandController.cancelExpandTimer();
        },
        onDragEnd: () => {
          setTimeout(() => {
            this.glassEffect.refreshTextColor();
          }, 500);
          if (!this.isTreeOpen) {
            this.expandController.startExpandTimer();
            if (this.wm.isSplit) {
              this.autoHide.startHideTimer();
            }
          }
        },
        onTreeOpenRequested: () => this.treeIntegration.open(),
        onTreeCloseRequested: () => this.treeIntegration.close(),
      },
    });
    this.dragController.init();
    this.#setupEventListeners();
    this.#updatePosition();
    this.#forceGooRepaint();
    if (Config.get("liquid_glass_enabled")) {
      this.glassEffect.setEnabled(true);
    }
  }

  /**
   * Force repaint the goo filter on Safari so it renders
   */
  #forceGooRepaint() {
    requestAnimationFrame(() => {
      this.gooContainer.style.display = "none";
      void this.gooContainer.offsetHeight; // flush layout
      this.gooContainer.style.display = "";
    });
  }

  get isExpanded() {
    return this.expandController.isExpanded;
  }

  get isTreeOpen() {
    return this.treeIntegration ? this.treeIntegration.isOpen : false;
  }

  get isDragging() {
    return this.dragController ? this.dragController.isDragging : false;
  }

  get dragMode() {
    return this.dragController ? this.dragController.dragMode : null;
  }

  #scrollCallback: (() => void) | null = null;

  /** @returns {ViewerPane} */
  get pane() {
    return this.wm.activePane;
  }

  #createToolbar() {
    const dom = buildToolbarDom();
    this.wrapper = dom.wrapper;
    this.gooContainer = dom.gooContainer;
    this.ball = dom.ball;
    this.toolbarTop = dom.toolbarTop;
    this.toolbarBottom = dom.toolbarBottom;

    this.tooltip = new ToolButtonTooltip(this.wrapper);
    this.tooltip.attach();
  }

  #setupEventListeners() {
    // Ball click — distinguish from drag via the drag controller's wasDragged flag.
    this.ball.addEventListener("click", (e: MouseEvent) => {
      if (!this.dragController.wasDragged && !this.isTreeOpen) {
        e.preventDefault();
        this.#handleClick();
      }
      this.dragController.clearWasDragged();
    });

    // Right-click on the ball toggles the toolbar expansion.
    this.ball.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      if (!this.isTreeOpen) {
        this.expandController.toggle();
      }
    });

    const onToolClick = (e: MouseEvent) => {
      const btn = (e.target as Element).closest<HTMLElement>(".tool-btn");
      if (btn?.dataset.action) {
        this.toolActions.handle(btn.dataset.action as ToolAction);
      }
    };
    this.toolbarTop.addEventListener("click", onToolClick);
    this.toolbarBottom.addEventListener("click", onToolClick);

    this.toolbarTop.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      this.expandController.collapse();
    });

    this.toolbarBottom.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      this.expandController.collapse();
    });

    window.addEventListener("resize", () => {
      this.#updatePosition();
      this.glassEffect.handleResize();
      if (this.isTreeOpen) {
        this.treeIntegration.close();
      }
      if (this.jumpPopup.isOpen) {
        this.jumpPopup.reposition();
      }
    });

    this.pane.controls.onScroll(this.#scrollCallback);
  }

  setAutoCollapse(enabled: boolean) {
    this.expandController.setAutoCollapse(enabled);
  }

  setLiquidGlass(enabled: boolean) {
    this.glassEffect.setEnabled(enabled);
  }

  enterSplitMode() {
    this.autoHide.enterSplitMode();
  }

  exitSplitMode() {
    this.autoHide.exitSplitMode();
    this.updatePageNumber();
  }

  #handleClick() {
    this.glassEffect.pulse();
    const now = Date.now();
    const timeSinceLastClick = now - this.lastClickTime;

    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
    }

    if (timeSinceLastClick < 220) {
      // Double-click: open jump-to-page popup
      this.jumpPopup.toggle();
      this.lastClickTime = 0;
    } else {
      // Single click: open toolbar
      this.lastClickTime = now;
      this.clickTimeout = setTimeout(() => {
        this.clickTimeout = null;
        this.expandController.toggle();
      }, 220);
    }
  }

  #updatePosition() {
    const containerRect = this.pane.paneEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2 - 37;

    this.wrapper.style.top = `${centerY}px`;
    if (!this.isTreeOpen) {
      this.wrapper.style.right = `${this.ballOriginalRight}px`;
    }

    this.autoHide.reposition(centerY);
    this.glassEffect.refreshTextColor();
  }

  updatePageNumber() {
    const currentPage = this.pane.getCurrentPage();
    const totalPages = this.pane.pages.length || "?";

    this.ball.querySelector(".page-current").textContent = String(currentPage);
    this.ball.querySelector(".page-total").textContent = String(totalPages);

    // Content scrolled behind a resting ball — recolor the page number to the
    // page now under it (no-op unless liquid glass is on).
    this.glassEffect.refreshTextColor();
  }

  updateActivePane() {
    if (this.#scrollCallback) {
      this.pane.controls.offScroll(this.#scrollCallback);
    }
    this.#scrollCallback = () => this.updatePageNumber();
    this.pane.controls.onScroll(this.#scrollCallback);

    this.toolActions.syncWithPane();
  }

  destroy() {
    this.autoHide.destroy();
    this.glassEffect.destroy();
    this.navigationTree?.destroy();
    this.wrapper.remove();
  }
}
