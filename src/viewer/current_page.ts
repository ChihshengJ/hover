import type { PageView } from "./page.js";

/**
 * Tracks the page under the viewport's vertical centre. The negative
 * top/bottom rootMargin collapses the observer root to a thin band at the
 * scroller's mid-height, so a page is "intersecting" exactly while it
 * crosses that centre line.
 */
export class CurrentPageTracker {
  /** 1-based; 0 until a page has been seen over the centre line. */
  current = 0;

  #scroller: HTMLElement;
  #pages: readonly PageView[];
  #pageMap: Map<Element, PageView>;
  #onChange: () => void;
  #observer: IntersectionObserver | null = null;
  /** Pages currently over the centre line. */
  #centered = new Set<PageView>();

  /** `onChange` runs whenever the observer moves `current`. */
  constructor(
    scroller: HTMLElement,
    pages: readonly PageView[],
    onChange: () => void,
  ) {
    this.#scroller = scroller;
    this.#pages = pages;
    this.#pageMap = new Map(pages.map((page) => [page.wrapper, page]));
    this.#onChange = onChange;
  }

  observe() {
    this.#observer?.disconnect();
    this.#centered.clear();

    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageView = this.#pageMap.get(entry.target);
          if (!pageView) continue;
          if (entry.isIntersecting) {
            this.#centered.add(pageView);
          } else {
            this.#centered.delete(pageView);
          }
        }
        // In gaps between pages the set is briefly empty — keep the last value.
        // In spread mode two pages share the center line; pick the lower number
        // to match the old left-to-right scan order.
        let min = Infinity;
        for (const pv of this.#centered) {
          if (pv.pageNumber < min) min = pv.pageNumber;
        }
        // Notify on change so page indicators refresh even when the page
        // changed via an instant jump (where the scroll handler already ran
        // before this async callback updated `current`).
        if (min !== Infinity && min !== this.current) {
          this.current = min;
          this.#onChange();
        }
      },
      {
        root: this.#scroller,
        rootMargin: "-50% 0px -50% 0px",
        threshold: 0,
      },
    );

    for (const pageView of this.#pages) {
      this.#observer.observe(pageView.wrapper);
    }
  }

  /** The current page, measured if the observer hasn't reported one yet. */
  get(): number {
    return this.current || this.measure();
  }

  /**
   * Precise synchronous measurement of the centered page. Use after a
   * programmatic instant scroll, where the async observer hasn't fired yet.
   * Updates `current` as a side effect.
   */
  measure(): number {
    const viewRect = this.#scroller.getBoundingClientRect();
    const viewportMidY = viewRect.top + viewRect.height / 2;
    for (const page of this.#pages) {
      const rect = page.canvas.getBoundingClientRect();
      if (rect.top <= viewportMidY && rect.bottom >= viewportMidY) {
        this.current = page.pageNumber;
        return this.current;
      }
    }
    return this.current;
  }

  destroy() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#centered.clear();
  }
}
