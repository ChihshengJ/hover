import {
  beginCustomSelectionGesture,
  isPointerToolActive,
} from "./pointer_gesture.js";

import type { PageView } from "./page.js";

/** How far off the nearest span, in px, a pointerdown still anchors to it. */
const MAX_ANCHOR_DISTANCE = 500;

export interface NearestSpanSelectionHost {
  scroller: HTMLElement;
  getVisiblePages: () => Iterable<PageView>;
  getHandMode: () => boolean;
}

/** How far (x, y) lies outside `rect` on each axis; 0 on an axis it spans. */
function outside(rect: DOMRect, x: number, y: number) {
  return {
    dx: Math.max(0, rect.left - x, x - rect.right),
    dy: Math.max(0, rect.top - y, y - rect.bottom),
  };
}

/**
 * Selection for pointerdowns that land *off* a text span: anchor to the
 * nearest span and drive the range ourselves. Because we compute the
 * selection, the engine must not also run its own — see pointer_gesture.js.
 */
export class NearestSpanSelection {
  #host: NearestSpanSelectionHost;
  #isSelecting = false;
  #anchorNode: Node | null = null;
  #anchorOffset = 0;
  #releaseGesture: (() => void) | null = null;

  constructor(host: NearestSpanSelectionHost) {
    this.#host = host;
    host.scroller.addEventListener("pointerdown", this.#onPointerDown);
    document.addEventListener("pointermove", this.#onPointerMove);
    document.addEventListener("pointerup", this.#onPointerUp);
  }

  destroy() {
    this.#host.scroller.removeEventListener("pointerdown", this.#onPointerDown);
    document.removeEventListener("pointermove", this.#onPointerMove);
    document.removeEventListener("pointerup", this.#onPointerUp);
    this.#endSelection();
  }

  #findNearestSpanAndOffset(clientX: number, clientY: number) {
    let nearestSpan: HTMLSpanElement | null = null;
    let nearestDistance = Infinity;

    for (const pageView of this.#host.getVisiblePages()) {
      const spans = pageView.textLayer.querySelectorAll("span");

      for (const span of spans) {
        if (!span.textContent || !span.firstChild) continue;

        const { dx, dy } = outside(span.getBoundingClientRect(), clientX, clientY);
        const distSq = dx * dx + dy * dy * 4;

        if (distSq < nearestDistance) {
          nearestDistance = distSq;
          nearestSpan = span;
        }
      }
    }

    if (!nearestSpan || !nearestSpan.firstChild) return null;

    // Calculate offset within text
    const rect = nearestSpan.getBoundingClientRect();
    const textNode = nearestSpan.firstChild;
    const text = textNode.textContent ?? "";

    let offset: number;
    if (clientX <= rect.left) {
      offset = 0;
    } else if (clientX >= rect.right) {
      offset = text.length;
    } else {
      const proportion = (clientX - rect.left) / rect.width;
      offset = Math.round(proportion * text.length);
    }

    return { node: textNode, offset, span: nearestSpan };
  }

  #updateSelection(clientX: number, clientY: number) {
    const focus = this.#findNearestSpanAndOffset(clientX, clientY);
    const anchorNode = this.#anchorNode;
    const anchorOffset = this.#anchorOffset;
    if (!focus || !anchorNode) return;

    const selection = document.getSelection()!;
    const range = document.createRange();

    const position = anchorNode.compareDocumentPosition(focus.node);

    let startNode: Node;
    let startOffset: number;
    let endNode: Node;
    let endOffset: number;

    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      // Anchor comes before focus
      startNode = anchorNode;
      startOffset = anchorOffset;
      endNode = focus.node;
      endOffset = focus.offset;
    } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      // Focus comes before anchor
      startNode = focus.node;
      startOffset = focus.offset;
      endNode = anchorNode;
      endOffset = anchorOffset;
    } else {
      // Same node
      startNode = anchorNode;
      endNode = anchorNode;
      if (anchorOffset < focus.offset) {
        startOffset = anchorOffset;
        endOffset = focus.offset;
      } else {
        startOffset = focus.offset;
        endOffset = anchorOffset;
      }
    }

    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      console.warn("Selection range error:", e);
    }
  }

  #onPointerDown = (e: PointerEvent) => {
    // Lowest of the three gestures: a drag tool owns the pointer outright,
    // and in hand mode the pan does. See pointer_gesture.js.
    if (isPointerToolActive() || this.#host.getHandMode()) return;

    if ((e.target as Element).closest(".textLayer span")) return;

    if (
      (e.target as Element).closest(
        "a, button, .pane-controls, .annotationLayer a",
      )
    )
      return;

    if (e.button !== 0) return;

    const anchor = this.#findNearestSpanAndOffset(e.clientX, e.clientY);
    if (!anchor) return;

    const { dx, dy } = outside(
      anchor.span.getBoundingClientRect(),
      e.clientX,
      e.clientY,
    );
    if (dx * dx + dy * dy > MAX_ANCHOR_DISTANCE * MAX_ANCHOR_DISTANCE) return;

    e.preventDefault();
    // preventDefault() above only suppresses the engine's own selection on
    // Blink; WebKit/Gecko need the claim.
    this.#releaseGesture = beginCustomSelectionGesture();

    this.#isSelecting = true;
    this.#anchorNode = anchor.node;
    this.#anchorOffset = anchor.offset;

    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(anchor.node, anchor.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    anchor.span.closest(".textLayer")?.classList.add("selecting");
    anchor.span.closest(".page-wrapper")?.classList.add("text-selecting");
  };

  #onPointerMove = (e: PointerEvent) => {
    if (!this.#isSelecting) return;
    e.preventDefault();
    this.#updateSelection(e.clientX, e.clientY);
  };

  #onPointerUp = () => {
    if (!this.#isSelecting) return;
    this.#endSelection();
  };

  #endSelection() {
    this.#isSelecting = false;
    this.#anchorNode = null;
    this.#anchorOffset = 0;
    this.#releaseGesture?.();
    this.#releaseGesture = null;
  }
}
