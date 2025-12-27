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

    // Add mousedown handler for this text layer
    textLayerDiv.addEventListener("mousedown", (e) => {
      if (
        e.target.matches(".textLayer span") ||
        e.target.closest(".textLayer span")
      ) {
        return;
      }

      textLayerDiv.classList.add("selecting");
    });

    // Add copy handler to normalize unicode and remove null characters
    textLayerDiv.addEventListener("copy", (event) => {
      const selection = document.getSelection();
      const text = this.#normalizeText(selection.toString());
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    });

    // Enable global listener if this is the first registration
    if (this.#textLayers.size === 1) {
      this.#enableGlobalSelectionListener();
    }
  }

  /**
   * Unregister a page's text layer.
   * Called by PageView when releasing/destroying.
   *
   * @param {HTMLElement} textLayerDiv - The text layer element to unregister
   */
  unregister(textLayerDiv) {
    this.#textLayers.delete(textLayerDiv);

    if (this.#textLayers.size === 0 && this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
  }

  /**
   * Normalize text by removing null characters and normalizing unicode.
   * @param {string} text
   * @returns {string}
   */
  #normalizeText(text) {
    // Remove null characters
    return (
      text
        .replace(/\x00/g, "")
        // Normalize unicode (NFC form)
        .normalize("NFC")
    );
  }

  /**
   * Reset a text layer's selection state.
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

  /**
   * Set up document-level event listeners for selection handling.
   */
  #enableGlobalSelectionListener() {
    if (this.#abortController) return;

    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    // Track pointer state
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

  /**
   * Handle selection changes - the core of the stable selection logic.
   */
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
      console.log("Selection anchor outside textLayer, skipping");
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
   * Get the current text selection with page information.
   * Useful for creating highlights from the current selection.
   *
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

        // Get all client rects for the range
        const clientRects = Array.from(range.getClientRects());

        // Filter and transform rects to be relative to the text layer
        const rects = clientRects
          .filter((rect) => {
            // Only include rects that overlap with this text layer
            return (
              rect.bottom > layerRect.top &&
              rect.top < layerRect.bottom &&
              rect.width > 0 &&
              rect.height > 0
            );
          })
          .map((rect) => ({
            // Convert to coordinates relative to the text layer
            left: rect.left - layerRect.left,
            top: rect.top - layerRect.top,
            width: rect.width,
            height: rect.height,
          }));

        if (rects.length > 0) {
          results.push({
            pageNumber: pageView.pageNumber,
            text: selection.toString(),
            rects,
            // Store scale for later coordinate conversion
            scale: pageView.scale,
          });
        }
      }
    }

    return results;
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
