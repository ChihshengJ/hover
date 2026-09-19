/**
 * TextSelectionManager - Handles text selection across PDF pages
 *
 */

import type { PageView } from "./page.js";

/** A rect in text-layer-local CSS pixels. */
export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One page's worth of a selection: the text, and where it sits on that page
 * in layer-local CSS pixels.
 */
export interface TextSelectionRecord {
  /** 1-based. */
  pageNumber: number;
  text: string;
  rects: SelectionRect[];
  /** The pane scale the rects were measured at. */
  scale: number;
}

/** What one registered text layer needs remembered about it. */
interface TextLayerEntry {
  endOfContent: HTMLElement;
  pageView: PageView;
  handlers: {
    mousedownHandler: (e: PointerEvent) => void;
    copyHandler: (e: ClipboardEvent) => void;
  };
}

export class TextSelectionManager {
  #textLayers = new Map<HTMLElement, TextLayerEntry>();

  #abortController: AbortController | null = null;

  #isPointerDown = false;

  /**
   * The text layer the live pointer gesture started in, or null when the
   * gesture started elsewhere — selections dragged out by other gestures
   * (floating ball, resizer, region select, ...) must not trigger the
   * endOfContent machinery. Doubles as the reference every other layer's
   * endOfContent is parked against for the duration.
   */
  #gestureLayer: HTMLElement | null = null;

  #prevRange: Range | null = null;

  /**
   * Whether to skip the endOfContent repositioning trick (Gecko handles
   * gappy selections natively and the trick breaks it). The build target
   * decides; for cross-loaded builds (e.g. a chrome build opened in
   * Firefox) `null` defers to the runtime probe in #handleSelectionChange.
   */
  #isFirefox: boolean | null =
    typeof __TARGET__ !== "undefined" && __TARGET__ === "firefox" ? true : null;

  // No constructor: selection state is entirely per-registered-text-layer, so
  // this manager needs nothing from the pane that owns it. It took the whole
  // pane and never touched it.

  /**
   * @param endOfContent The overlay that keeps a cross-page selection stable.
   */
  register(
    pageView: PageView,
    textLayerDiv: HTMLElement,
    endOfContent: HTMLElement,
  ) {
    const mousedownHandler = (e: PointerEvent) => {
      const target = e.target as Element;
      if (
        target.matches(".textLayer span") ||
        target.closest(".textLayer span")
      ) {
        return;
      }
      textLayerDiv.classList.add("selecting");
    };

    const copyHandler = (e: ClipboardEvent) => {
      const selection = document.getSelection()!;
      const text = selection
        .toString()
        .replace(/\x00/g, "")
        .replace(/[\r\n]+/g, " ")
        .replace(/-\s/g, "")
        .normalize("NFC");
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    };

    textLayerDiv.addEventListener("pointerdown", mousedownHandler);
    textLayerDiv.addEventListener("copy", copyHandler);

    this.#textLayers.set(textLayerDiv, {
      endOfContent,
      pageView,
      handlers: { mousedownHandler, copyHandler },
    });

    // Enable global listener if this is the first registration
    if (this.#textLayers.size === 1) {
      this.#enableGlobalSelectionListener();
    }
  }

  /** Unregister a text layer. */
  unregister(textLayerDiv: HTMLElement) {
    const entry = this.#textLayers.get(textLayerDiv);
    if (entry?.handlers) {
      textLayerDiv.removeEventListener(
        "pointerdown",
        entry.handlers.mousedownHandler,
      );
      textLayerDiv.removeEventListener("copy", entry.handlers.copyHandler);
    }
    this.#textLayers.delete(textLayerDiv);

    if (this.#textLayers.size === 0 && this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
  }

  /**
   * Reset a text layer's selection state.
   *
   * A layer the selection has left is still one the drag may re-enter, so when
   * a gesture is live its overlay is parked on the edge facing
   * `referenceLayer` instead of returning to the end of the layer.
   *
   */
  #reset(
    entry: TextLayerEntry,
    textLayerDiv: HTMLElement,
    referenceLayer: HTMLElement | null = null,
  ) {
    const { endOfContent, pageView } = entry;
    if (referenceLayer && referenceLayer !== textLayerDiv) {
      this.#parkEndOfContent(entry, textLayerDiv, referenceLayer);
    } else {
      // Move endOfContent back to the end of the text layer
      textLayerDiv.append(endOfContent);
    }
    endOfContent.style.width = "";
    endOfContent.style.height = "";
    endOfContent.style.userSelect = "";
    endOfContent.style.webkitUserSelect = "";
    textLayerDiv.classList.remove("selecting");
    pageView.wrapper.classList.remove("text-selecting");
  }

  #enableGlobalSelectionListener() {
    if (this.#abortController) return;

    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    document.addEventListener(
      "pointerdown",
      (e) => {
        this.#isPointerDown = true;
        // Guard right button from starting a selection.
        this.#gestureLayer =
          e.button === 0 && e.target instanceof Element
            ? e.target.closest<HTMLElement>(".textLayer")
            : null;

        if (!this.#gestureLayer) return;

        // A gesture starting inside a text layer starts from a clean slate:
        // WebKit can strand a range that a click elsewhere won't collapse.
        // Shift-click still extends.
        if (e.isPrimary && !e.shiftKey) {
          const selection = document.getSelection();
          if (selection && !selection.isCollapsed) {
            selection.removeAllRanges();
          }
        }

        // Park every other page's overlay before the drag can reach it, so no
        // page is ever entered while its endOfContent still sits after the
        // last span.
        for (const [textLayerDiv, entry] of this.#textLayers) {
          if (textLayerDiv !== this.#gestureLayer) {
            this.#parkEndOfContent(entry, textLayerDiv, this.#gestureLayer);
          }
        }
      },
      { signal },
    );

    document.addEventListener(
      "pointerup",
      () => {
        this.#isPointerDown = false;
        this.#gestureLayer = null;
        this.#textLayers.forEach((entry, div) => this.#reset(entry, div));
      },
      { signal },
    );

    window.addEventListener(
      "blur",
      () => {
        this.#isPointerDown = false;
        this.#gestureLayer = null;
        this.#textLayers.forEach((entry, div) => this.#reset(entry, div));
      },
      { signal },
    );

    document.addEventListener(
      "keyup",
      () => {
        if (!this.#isPointerDown) {
          this.#textLayers.forEach((entry, div) => this.#reset(entry, div));
        }
      },
      { signal },
    );

    document.addEventListener(
      "selectionchange",
      () => {
        this.#handleSelectionChange();
      },
      { signal },
    );
  }

  #handleSelectionChange() {
    // Ignore selections dragged out by other pointer gestures (floating
    // ball, split resizer, region select, ...). Safari starts a native
    // selection even when those controls preventDefault() their
    // pointerdown; reacting here would expand endOfContent and shuffle
    // the DOM in the middle of their drag. Keyboard-driven selection
    // changes (pointer up) still pass through.
    if (this.#isPointerDown && !this.#gestureLayer) {
      return;
    }

    const selection = document.getSelection();

    if (selection.rangeCount === 0) {
      this.#textLayers.forEach((entry, div) =>
        this.#reset(entry, div, this.#gestureLayer),
      );
      this.#prevRange = null;
      return;
    }

    // Find which text layers are involved in the current selection
    const activeTextLayers = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      for (const textLayerDiv of this.#textLayers.keys()) {
        if (
          !activeTextLayers.has(textLayerDiv) &&
          range.intersectsNode(textLayerDiv)
        ) {
          activeTextLayers.add(textLayerDiv);
        }
      }
    }

    // Firefox handles selection natively without the endOfContent trick.
    // The probe must run against an element that has `user-select: none`
    // applied (endOfContent) — only Gecko aliases it to -moz-user-select,
    // so Chrome/Safari compute "" here while Firefox computes "none".
    // Probing the textLayer div itself would always yield false.
    if (this.#isFirefox === null) {
      const firstEntry = this.#textLayers.values().next().value;
      if (firstEntry) {
        this.#isFirefox =
          getComputedStyle(firstEntry.endOfContent).getPropertyValue(
            "-moz-user-select",
          ) === "none";
      }
    }

    const range = selection.getRangeAt(0);

    const modifyStart =
      this.#prevRange &&
      (range.compareBoundaryPoints(Range.END_TO_END, this.#prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, this.#prevRange) === 0);

    let anchor: Node | null = modifyStart
      ? range.startContainer
      : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) {
      anchor = anchor.parentNode;
    }

    // Resolve from the anchor's *parent*: when the endpoint lands on the text
    // layer div itself (WebKit does this for points over the endOfContent
    // overlay) the layer is not a valid insertion parent, and inserting
    // relative to it moves endOfContent out next to the <canvas>.
    const anchorLayer: HTMLElement | null = this.#isFirefox
      ? null
      : ((anchor as Element)?.parentElement?.closest<HTMLElement>(
          ".textLayer",
        ) ?? null);

    // Update selecting class on each text layer, parking newly involved and
    // departed layers against the live anchor.
    const referenceLayer = anchorLayer ?? this.#gestureLayer;
    for (const [textLayerDiv, entry] of this.#textLayers) {
      if (!activeTextLayers.has(textLayerDiv)) {
        this.#reset(entry, textLayerDiv, referenceLayer);
        continue;
      }
      const wasSelecting = textLayerDiv.classList.contains("selecting");
      textLayerDiv.classList.add("selecting");
      entry.pageView.wrapper.classList.add("text-selecting");
      if (!wasSelecting && textLayerDiv !== referenceLayer) {
        this.#parkEndOfContent(entry, textLayerDiv, referenceLayer);
      }
    }

    if (this.#isFirefox) return;

    if (!anchorLayer) {
      this.#prevRange = range.cloneRange();
      return;
    }

    // Handle edge case where endOffset is 0
    if (!modifyStart && range.endOffset === 0) {
      try {
        while (!anchor.previousSibling) {
          anchor = anchor.parentNode;
        }
        anchor = anchor.previousSibling;
        while (anchor.childNodes?.length) {
          anchor = anchor.lastChild;
        }
      } catch (e) {
        // Ignore navigation errors at document boundaries
      }
    }

    const entry = this.#textLayers.get(anchorLayer);

    // The walk above can climb out of the layer; endOfContent must never leave it.
    if (
      entry &&
      anchor.parentElement &&
      anchorLayer.contains(anchor.parentElement)
    ) {
      const { endOfContent } = entry;
      endOfContent.style.width = anchorLayer.style.width;
      endOfContent.style.height = anchorLayer.style.height;
      endOfContent.style.userSelect = "text";
      // Safari < 18.4 only honors the prefixed property
      endOfContent.style.webkitUserSelect = "text";

      anchor.parentElement.insertBefore(
        endOfContent,
        modifyStart ? anchor : anchor.nextSibling,
      );
    }

    this.#prevRange = range.cloneRange();
  }

  /**
   * Park a layer's endOfContent on the edge facing the anchor.
   *
   * `.selecting` stretches endOfContent over the whole page, and WebKit
   * resolves a point over it to a DOM position inside it — so an overlay
   * sitting after the last span selects the entire page the instant a drag
   * crosses the boundary. On the near edge, the same landing selects nothing.
   *
   */
  #parkEndOfContent(
    entry: TextLayerEntry,
    textLayerDiv: HTMLElement,
    anchorLayer: HTMLElement | null,
  ) {
    const enteredFromAbove =
      anchorLayer &&
      anchorLayer.compareDocumentPosition(textLayerDiv) &
        Node.DOCUMENT_POSITION_FOLLOWING;

    if (enteredFromAbove) {
      textLayerDiv.prepend(entry.endOfContent);
    } else {
      textLayerDiv.append(entry.endOfContent);
    }
  }

  /**
   * Get the current selection with page information and rectangles.
   * A multi-page selection yields one record per page it covers.
   */
  getSelection(): TextSelectionRecord[] {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return [];
    }

    const results: TextSelectionRecord[] = [];

    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);

      for (const [textLayerDiv, entry] of this.#textLayers) {
        if (!range.intersectsNode(textLayerDiv)) continue;

        const { pageView } = entry;
        const layerRect = textLayerDiv.getBoundingClientRect();

        const clientRects = Array.from(range.getClientRects());

        let rects = clientRects
          .filter((rect) => {
            const overlaps =
              rect.bottom > layerRect.top &&
              rect.top < layerRect.bottom &&
              rect.right > layerRect.left &&
              rect.left < layerRect.right &&
              rect.width > 0 &&
              rect.height > 0;
            if (!overlaps) return false;
            return true;
          })
          .map((rect) => {
            const clippedLeft = Math.max(rect.left, layerRect.left);
            const clippedTop = Math.max(rect.top, layerRect.top);
            const clippedRight = Math.min(rect.right, layerRect.right);
            const clippedBottom = Math.min(rect.bottom, layerRect.bottom);

            return {
              left: clippedLeft - layerRect.left,
              top: clippedTop - layerRect.top,
              width: clippedRight - clippedLeft,
              height: clippedBottom - clippedTop,
            };
          })
          .filter((rect) => {
            const isExist = rect.width > 0 && rect.height > 0;
            // Get rid of the Arxiv banner and page numbers
            const isNearEdge =
              rect.top < layerRect.height * 0.07 ||
              rect.top > layerRect.height * 0.92 ||
              rect.left < layerRect.width * 0.06;
            if (isExist && !isNearEdge) return true;
            return false;
          });

        rects = this.#mergeRects(rects);

        if (rects.length > 0) {
          results.push({
            pageNumber: pageView.pageNumber,
            text: selection.toString(),
            rects,
            scale: pageView.scale,
          });
        }
      }
    }

    return results;
  }

  /** Merge adjacent rectangles on the same line. */
  #mergeRects(rects: SelectionRect[]): SelectionRect[] {
    if (rects.length === 0) return [];

    const LINE_TOLERANCE = 8;

    rects.sort((a, b) => {
      const bottomDiff = a.top + a.height - (b.top + b.height);
      if (Math.abs(bottomDiff) > LINE_TOLERANCE) return bottomDiff;
      return a.left - b.left;
    });

    const merged: SelectionRect[] = [];
    let current = { ...rects[0] };

    for (let i = 1; i < rects.length; i++) {
      const rect = rects[i];

      const sameLine =
        Math.abs(rect.top + rect.height - (current.top + current.height)) <
        LINE_TOLERANCE;
      const overlapsOrAdjacent =
        rect.left <= current.left + current.width + LINE_TOLERANCE;

      if (sameLine && overlapsOrAdjacent) {
        const right = Math.max(
          current.left + current.width,
          rect.left + rect.width,
        );
        const bottom = Math.max(
          current.top + current.height,
          rect.top + rect.height,
        );
        current.left = Math.min(current.left, rect.left);
        current.top = Math.min(current.top, rect.top);
        current.width = right - current.left;
        current.height = bottom - current.top;
      } else {
        merged.push(current);
        current = { ...rect };
      }
    }
    merged.push(current);
    return merged;
  }

  /**
   * Clear the current selection
   */
  clearSelection() {
    document.getSelection()?.removeAllRanges();
  }

  /** Check if there's an active text selection. */
  hasSelection(): boolean {
    const selection = document.getSelection();
    return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
  }

  /**
   * Clean up all listeners and state
   */
  destroy() {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#textLayers.clear();
    this.#prevRange = null;
  }
}
