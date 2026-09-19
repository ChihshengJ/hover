/**
 * The pane plumbing every drag tool needs: own the pointer while the tool is
 * on, and keep a `pointerdown` listener on *every* pane's scroller.
 *
 * Panes come and go under an active tool (split, unsplit), so `sync()` is
 * idempotent and the pane lifecycle calls it freely; see
 * WindowControls.updateActivePane.
 */

import { claimPointerTool } from "../../viewer/pointer_gesture.js";

import type { ViewerPane } from "../../viewer/viewpane.js";
import type { SplitWindowManager } from "../../viewer/window_manager.js";

export interface PaneToolBindingOptions {
  /** Marks a bound scroller — the tool's cursor and layer-disabling CSS. */
  className: string;
  /** Bound handler; the same reference is added to and removed from each scroller. */
  onPointerDown: (e: PointerEvent) => void;
}

export class PaneToolBinding {
  #wm: SplitWindowManager;
  #className: string;
  #onPointerDown: (e: PointerEvent) => void;

  #scrollers = new Set<HTMLElement>();
  #attached = false;

  /** Drops the tool's claim on the pointer; see pointer_gesture.js. */
  #releaseTool: (() => void) | null = null;

  constructor(
    wm: SplitWindowManager,
    { className, onPointerDown }: PaneToolBindingOptions,
  ) {
    this.#wm = wm;
    this.#className = className;
    this.#onPointerDown = onPointerDown;
  }

  /** Claim the pointer for this tool and bind every live pane. */
  attach() {
    if (this.#attached) return;
    this.#attached = true;
    this.#releaseTool = claimPointerTool();
    this.sync();
  }

  /** Unbind every pane and give the pointer back. */
  detach() {
    if (!this.#attached) return;
    this.#attached = false;
    for (const scroller of [...this.#scrollers]) {
      this.#unbind(scroller);
    }
    this.#releaseTool?.();
    this.#releaseTool = null;
  }

  /** Bind panes that appeared, drop panes that went away. Idempotent. */
  sync() {
    if (!this.#attached) return;

    const live = new Set(
      this.#wm.panes.map((p) => p.scroller).filter(Boolean) as HTMLElement[],
    );
    for (const scroller of [...this.#scrollers]) {
      if (!live.has(scroller)) this.#unbind(scroller);
    }
    for (const scroller of live) {
      if (!this.#scrollers.has(scroller)) this.#bind(scroller);
    }
  }

  /**
   * The pane the gesture is happening in — resolved from the scroller the
   * listener fired on, not from `wm.activePane`. In split mode those differ
   * until the click that follows the pointerdown.
   *
   * Also promotes that pane to active, since dragging in a pane is as good a
   * claim on it as clicking it.
   */
  paneFor(e: Event): ViewerPane | null {
    const pane =
      this.#wm.panes.find((p) => p.scroller === e.currentTarget) ?? null;
    if (pane && this.#wm.activePane !== pane) this.#wm.setActivePane(pane);
    return pane;
  }

  #bind(scroller: HTMLElement) {
    scroller.classList.add(this.#className);
    scroller.addEventListener("pointerdown", this.#onPointerDown);
    this.#scrollers.add(scroller);
  }

  #unbind(scroller: HTMLElement) {
    scroller.classList.remove(this.#className);
    scroller.removeEventListener("pointerdown", this.#onPointerDown);
    this.#scrollers.delete(scroller);
  }
}
