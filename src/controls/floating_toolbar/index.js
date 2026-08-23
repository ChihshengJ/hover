/**
 * @typedef {import('../../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('../navigation_tree.js').NavigationTree} NavigationTree;
 */

import { NavigationTree } from "../navigation_tree.js";
import { Config } from "../../settings/config.js";
import { ToolButtonTooltip } from "./tool_button_tooltip.js";
import { JumpPopup } from "./jump_popup.js";
import { JumpIndicators } from "./jump_indicators.js";
import { AutoHideController } from "./auto_hide_controller.js";
import { ExpandController } from "./expand_controller.js";
import { ToolActions } from "./tool_actions.js";
import { TreeIntegration } from "./tree_integration.js";
import { DragController } from "./drag_controller.js";
import { buildToolbarDom } from "./toolbar_dom.js";
import { GlassEffect } from "./liquid_glass/glass_effect.js";

export class FloatingToolbar {
  /**
   * @param {SplitWindowManager} wm;
   */

  constructor(wm) {
    this.wm = wm;
    this.lastClickTime = 0;
    this.clickTimeout = null;
    this.wrapper = null;

    this.#scrollCallback = () => this.updatePageNumber();

    this.ballOriginalRight = 20;

    this.#createToolbar();
    /** @type {NavigationTree} */
    this.navigationTree = new NavigationTree(this);
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
            this.glassEffect.refreshTextColor(true);
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

  /** @type {Function} */
  #scrollCallback = null;

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
    this.ball.addEventListener("click", (e) => {
      if (!this.dragController.wasDragged && !this.isTreeOpen) {
        e.preventDefault();
        this.#handleClick();
      }
      this.dragController.clearWasDragged();
    });

    // Right-click on the ball toggles the toolbar expansion.
    this.ball.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.isTreeOpen) {
        this.expandController.toggle();
      }
    });

    this.toolbarTop.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-btn");
      if (btn) {
        this.toolActions.handle(btn.dataset.action);
      }
    });

    this.toolbarBottom.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-btn");
      if (btn) {
        this.toolActions.handle(btn.dataset.action);
      }
    });

    this.toolbarTop.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.expandController.collapse();
    });

    this.toolbarBottom.addEventListener("contextmenu", (e) => {
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

  /** @param {boolean} enabled */
  setAutoCollapse(enabled) {
    this.expandController.setAutoCollapse(enabled);
  }

  /** @param {boolean} enabled */
  setLiquidGlass(enabled) {
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

    this.ball.querySelector(".page-current").textContent = currentPage;
    this.ball.querySelector(".page-total").textContent = totalPages;

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
