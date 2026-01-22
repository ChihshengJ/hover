export class TextSelectionManager {
  /** @type {Map<HTMLElement, {endOfContent: HTMLElement, pageView: PageView}>} */
  #textLayers = new Map();

  /** @type {AbortController|null} */
  #abortController = null;

  /** @type {boolean} */
  #isPointerDown = false;

  /** @type {Range|null} */
  #prevRange = null;

  /** @type {boolean|null} */
  #isFirefox = null;

  /**
   * @param {ViewerPane} pane - The pane this manager belongs to
   */
  constructor(pane) {
    this.pane = pane;
  }

  /**
   * @param {PageView} pageView - The PageView instance
   * @param {HTMLElement} textLayerDiv - The text layer element
   * @param {HTMLElement} endOfContent - The endOfContent element for selection stability
   */
  register(pageView, textLayerDiv, endOfContent) {
    this.#textLayers.set(textLayerDiv, { endOfContent, pageView });

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
      const text = this.#normalizeText(selection.toString());
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    };

    textLayerDiv.addEventListener("mousedown", mousedownHandler);
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
   * @param {HTMLElement} textLayerDiv - The text layer element to unregister
   */
  unregister(textLayerDiv) {
    const entry = this.#textLayers.get(textLayerDiv);
    if (entry?.handlers) {
      textLayerDiv.removeEventListener(
        "mousedown",
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
   * @param {string} text
   * @returns {string}
   */
  #normalizeText(text) {
    return text
      .replace(/\x00/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/-\s/g, "")
      .normalize("NFC");
  }

  /**
   * @param {{endOfContent: HTMLElement}} entry
   * @param {HTMLElement} textLayerDiv
   */
  #reset(entry, textLayerDiv) {
    const { endOfContent, pageView } = entry;
    // Move endOfContent back to the end of the text layer
    textLayerDiv.append(endOfContent);
    endOfContent.style.width = "";
    endOfContent.style.height = "";
    textLayerDiv.classList.remove("selecting");
    pageView.wrapper.classList.remove("text-selecting");
  }

  #enableGlobalSelectionListener() {
    if (this.#abortController) return;

    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    document.addEventListener(
      "pointerdown",
      () => {
        this.#isPointerDown = true;
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
    const selection = document.getSelection();

    if (selection.rangeCount === 0) {
      this.#textLayers.forEach((entry, div) => this.#reset(entry, div));
      return;
    }

    // Find which text layers are involved in the current selection.
    // Firefox can create multiple ranges when selecting across pages.
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

    // Firefox handles selection natively without the endOfContent trick
    if (this.#isFirefox === null) {
      const firstDiv = this.#textLayers.keys().next().value;
      if (firstDiv) {
        this.#isFirefox =
          getComputedStyle(firstDiv).getPropertyValue("-moz-user-select") ===
          "none";
      }
    }
    if (this.#isFirefox) return;

    // Chrome/Safari: Reposition endOfContent to limit selection jumps.
    // When hovering over empty space, selection can jump wildly. By moving
    // endOfContent next to the anchor point, we limit jumps to single spans.
    const range = selection.getRangeAt(0);

    // Determine if user is modifying the start or end of selection
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

    // Find the text layer containing the anchor and reposition its endOfContent
    // const parentTextLayer = anchor.parentElement?.closest(".textLayer");
    const entry = this.#textLayers.get(parentTextLayer);

    if (entry) {
      const { endOfContent } = entry;
      endOfContent.style.width = parentTextLayer.style.width;
      endOfContent.style.height = parentTextLayer.style.height;
      endOfContent.style.userSelect = "text";

      anchor.parentElement?.insertBefore(
        endOfContent,
        modifyStart ? anchor : anchor.nextSibling,
      );
    }

    this.#prevRange = range.cloneRange();
  }

  /**
   * @returns {Array<{pageNumber: number, text: string, rects: Array<{left: number, top: number, width: number, height: number}>}>}
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

        // Filter rects that overlap with this text layer, then clip to layer bounds
        let rects = clientRects
          .filter((rect) => {
            // Only include rects that overlap with this text layer
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
            // Clip rect to text layer bounds before converting to relative coordinates
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
            // Get rid of the selection on the entire page
            const isWholePage = rect.left * rect.top === 0;
            // Get rid of the Arxiv banner and page numbers (numbers are heuristically selected)
            const isNearEdge =
              rect.top < layerRect.height * 0.07 ||
              rect.top > layerRect.height * 0.92 ||
              rect.left < layerRect.width * 0.06;
            if (isExist && !isWholePage && !isNearEdge) return true;
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

  #mergeRects(rects) {
    if (rects.length === 0) return [];

    rects.sort((a, b) => {
      const topDiff = a.top - b.top;
      if (Math.abs(topDiff) > 2) return topDiff;
      return a.left - b.left;
    });

    const merged = [];
    let current = { ...rects[0] };

    for (let i = 1; i < rects.length; i++) {
      const rect = rects[i];

      const sameLine =
        Math.abs(rect.top - current.top) < 3 &&
        Math.abs(rect.height - current.height) < 3;

      const overlapsOrAdjacent = rect.left <= current.left + current.width + 2;

      if (sameLine && overlapsOrAdjacent) {
        const newRight = Math.max(
          current.left + current.width,
          rect.left + rect.width,
        );
        current.width = newRight - current.left;
        const newBottom = Math.max(
          current.top + current.height,
          rect.top + rect.height,
        );
        const newTop = Math.min(current.top, rect.top);
        current.top = newTop;
        current.height = newBottom - newTop;
      } else {
        merged.push(current);
        current = { ...rect };
      }
    }
    merged.push(current);
    return merged;
  }

  /**
   * Clear the current selection.
   */
  clearSelection() {
    document.getSelection()?.removeAllRanges();
  }

  /**
   * Check if there's an active text selection.
   * @returns {boolean}
   */
  hasSelection() {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 && !selection.isCollapsed;
  }

  /**
   * Clean up all listeners and state.
   */
  destroy() {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#textLayers.clear();
    this.#prevRange = null;
  }
}
