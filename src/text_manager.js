/**
 * TextSelectionManager - Handles text selection across PDF pages
 *
 */

export class TextSelectionManager {
  /** @type {Map<HTMLElement, {endOfContent: HTMLElement, pageView: import('./page.js').PageView}>} */
  #textLayers = new Map();

  /** @type {AbortController|null} */
  #abortController = null;

  /** @type {boolean} */
  #isPointerDown = false;

  /**
   * Whether the current pointer gesture started inside a text layer.
   * Selections caused by other drags (floating ball, resizer, region
   * select, ...) must not trigger the endOfContent machinery.
   * @type {boolean}
   */
  #pointerDownInTextLayer = false;

  /** @type {Range|null} */
  #prevRange = null;

  /** @type {boolean|null} */
  #isFirefox = null;

  /**
   * @param {import('./viewpane.js').ViewerPane} pane - The pane this manager belongs to
   */
  constructor(pane) {
    this.pane = pane;
  }

  /**
   * Register a text layer for selection management
   * @param {import('./page.js').PageView} pageView - The PageView instance
   * @param {HTMLElement} textLayerDiv - The text layer element
   * @param {HTMLElement} endOfContent - The endOfContent element for selection stability
   */
  register(pageView, textLayerDiv, endOfContent) {
    const mousedownHandler = (e) => {
      if (
        e.target.matches(".textLayer span") ||
        e.target.closest(".textLayer span")
      ) {
        return;
      }
      textLayerDiv.classList.add("selecting");
    };

    const copyHandler = (e) => {
      const selection = document.getSelection();
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

  /**
   * Unregister a text layer
   * @param {HTMLElement} textLayerDiv - The text layer element to unregister
   */
  unregister(textLayerDiv) {
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
   * Reset a text layer's selection state
   * @param {{endOfContent: HTMLElement, pageView: import('./page.js').PageView}} entry
   * @param {HTMLElement} textLayerDiv
   */
  #reset(entry, textLayerDiv) {
    const { endOfContent, pageView } = entry;
    // Move endOfContent back to the end of the text layer
    textLayerDiv.append(endOfContent);
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
        this.#pointerDownInTextLayer = !!(
          e.target instanceof Element && e.target.closest(".textLayer")
        );
      },
      { signal },
    );

    document.addEventListener(
      "pointerup",
      () => {
        this.#isPointerDown = false;
        this.#textLayers.forEach((entry, div) => this.#reset(entry, div));
      },
      { signal },
    );

    window.addEventListener(
      "blur",
      () => {
        this.#isPointerDown = false;
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
    if (this.#isPointerDown && !this.#pointerDownInTextLayer) {
      return;
    }

    const selection = document.getSelection();

    if (selection.rangeCount === 0) {
      this.#textLayers.forEach((entry, div) => this.#reset(entry, div));
      return;
    }

    // Find which text layers are involved in the current selection
    const activeTextLayers = new Set();
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

    // Update selecting class on each text layer
    for (const [textLayerDiv, entry] of this.#textLayers) {
      const wrapper = entry.pageView.wrapper;
      if (activeTextLayers.has(textLayerDiv)) {
        textLayerDiv.classList.add("selecting");
        wrapper.classList.add("text-selecting");
      } else {
        this.#reset(entry, textLayerDiv);
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
    if (this.#isFirefox) return;

    // Chrome/Safari: Reposition endOfContent to limit selection jumps
    const range = selection.getRangeAt(0);

    const modifyStart =
      this.#prevRange &&
      (range.compareBoundaryPoints(Range.END_TO_END, this.#prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, this.#prevRange) === 0);

    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) {
      anchor = anchor.parentNode;
    }

    const parentTextLayer = anchor.closest?.(".textLayer");
    if (!parentTextLayer) {
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

    const entry = this.#textLayers.get(parentTextLayer);

    if (entry) {
      const { endOfContent } = entry;
      endOfContent.style.width = parentTextLayer.style.width;
      endOfContent.style.height = parentTextLayer.style.height;
      endOfContent.style.userSelect = "text";
      // Safari < 18.4 only honors the prefixed property
      endOfContent.style.webkitUserSelect = "text";

      anchor.parentElement?.insertBefore(
        endOfContent,
        modifyStart ? anchor : anchor.nextSibling,
      );
    }

    this.#prevRange = range.cloneRange();
  }

  /**
   * Get the current selection with page information and rectangles
   * @returns {Array<{pageNumber: number, text: string, rects: Array<{left: number, top: number, width: number, height: number}>, scale: number}>}
   */
  getSelection() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return [];
    }

    const results = [];

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

  /**
   * Merge adjacent rectangles on the same line
   * @param {Array<{left: number, top: number, width: number, height: number}>} rects
   * @returns {Array<{left: number, top: number, width: number, height: number}>}
   */
  #mergeRects(rects) {
    if (rects.length === 0) return [];

    const LINE_TOLERANCE = 8;

    rects.sort((a, b) => {
      const bottomDiff = a.top + a.height - (b.top + b.height);
      if (Math.abs(bottomDiff) > LINE_TOLERANCE) return bottomDiff;
      return a.left - b.left;
    });

    const merged = [];
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

  /**
   * Check if there's an active text selection
   * @returns {boolean}
   */
  hasSelection() {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 && !selection.isCollapsed;
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
