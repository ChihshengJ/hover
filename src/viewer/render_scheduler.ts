import { covers, deviceRegion, unrotate } from "./detail_region.js";
import { isQuarterTurn } from "./page_layout.js";

import type { PageView } from "./page.js";
import type { Edges } from "./detail_region.js";

/**
 * How far above and below the viewport pages are kept rendered, in viewport
 * heights. A page renders this far ahead of reaching the screen; at 5K a
 * render can take 100 ms, so a fixed few hundred px let a quick scroll
 * arrive first.
 */
const RENDER_MARGIN = 1;
/**
 * How far past the viewport a detail region reaches once scrolling settles,
 * as a fraction of the viewport on each side, so a short scroll stays sharp.
 */
const DETAIL_MARGIN = 0.125;
/** How long scrolling must pause before detail regions follow it, in ms. */
const DETAIL_SETTLE_MS = 100;
/**
 * Below the size cap, an on-screen page renders the region in view first only
 * when that is under this fraction of the page. Its whole page follows at full
 * resolution anyway, so a crop of most of the page saves the frame little and
 * costs a second render of the same pixels.
 */
const CROP_FIRST_BELOW = 0.75;

export interface RenderSchedulerHost {
  scroller: HTMLElement;
  pages: readonly PageView[];
  getScale(): number;
  getRotation(): number;
  /** devicePixelRatio the pages were last laid out for. */
  getLayoutDpr(): number;
  /** True while nothing should render, as during a pinch. */
  isPaused(): boolean;
}

/**
 * Decides which pages hold pixels and when they get them: tracks the pages in
 * range of the viewport, renders the ones on screen at once and queues the
 * rest, and keeps a capped page's detail region over the part in view.
 */
export class RenderScheduler {
  /** Pages within `RENDER_MARGIN` of the viewport, as last reported. */
  readonly visiblePages = new Set<PageView>();

  #host: RenderSchedulerHost;
  #pageMap: Map<Element, PageView>;
  #observer: IntersectionObserver | null = null;
  /** Margin pages waiting to render; see `renderVisible()`. */
  #queue: PageView[] = [];
  #queueTimer: ReturnType<typeof setTimeout> | null = null;
  #detailTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: RenderSchedulerHost) {
    this.#host = host;
    this.#pageMap = new Map(host.pages.map((page) => [page.wrapper, page]));
    host.scroller.addEventListener("scroll", this.#scheduleDetailRefresh, {
      passive: true,
    });
  }

  /** Start watching which pages are in range; each report renders them. */
  observe() {
    this.#observer?.disconnect();

    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageView = this.#pageMap.get(entry.target);
          if (!pageView) continue;

          // In range, the page is painted ahead like the rest of the screen,
          // not left for `content-visibility` to paint as it arrives; see
          // viewer.css.
          pageView.wrapper.classList.toggle("in-range", entry.isIntersecting);
          if (entry.isIntersecting) {
            this.visiblePages.add(pageView);
          } else {
            this.visiblePages.delete(pageView);
            pageView.dropDetail();
            this.#maybeRelease(pageView);
          }
        }
        this.renderVisible();
      },
      {
        root: this.#host.scroller,
        rootMargin: `${RENDER_MARGIN * 100}% 0px`,
        threshold: 0.1,
      },
    );

    for (const pageView of this.#host.pages) {
      this.#observer.observe(pageView.wrapper);
    }
  }

  destroy() {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#queueTimer !== null) clearTimeout(this.#queueTimer);
    this.#queueTimer = null;
    this.#queue = [];
    this.#host.scroller.removeEventListener(
      "scroll",
      this.#scheduleDetailRefresh,
    );
    if (this.#detailTimer !== null) clearTimeout(this.#detailTimer);
    this.#detailTimer = null;
  }

  #maybeRelease(page: PageView) {
    const rect = page.wrapper.getBoundingClientRect();
    const threshold = window.innerHeight * 2;

    if (rect.bottom < -threshold || rect.top > window.innerHeight + threshold) {
      page.release();
    }
  }

  /**
   * Render the visible pages that need it. PDFium renders synchronously on
   * this thread, so a batch holds the frame until every page in it is done.
   * Only the pages on screen render now, for the frame being built; those
   * only in the observer's margin are queued, nearest the viewport first, and
   * render one per task so frames can paint in between.
   *
   * An on-screen page renders only the region in view now, at full
   * resolution, when it is past the size cap or mostly out of view; its whole
   * page — capped or not — joins the front of the queue. The work in the
   * frame then follows the viewport rather than the pages it cuts across.
   *
   * Nothing renders while paused (mid-pinch): the scale is about to change,
   * and the pinch calls this again when it ends.
   */
  renderVisible() {
    if (this.#host.isPaused()) return;

    const scale = this.#host.getScale();
    const view = this.#host.scroller.getBoundingClientRect();
    // Measure everything before rendering any of it, as a render touches the
    // DOM and the next read would force another layout.
    const pending: { page: PageView; rect: DOMRect }[] = [];
    for (const page of this.visiblePages) {
      if (page.canvas.dataset.rendered === "false") {
        pending.push({ page, rect: page.wrapper.getBoundingClientRect() });
      }
    }

    const queued: { page: PageView; gap: number }[] = [];
    for (const { page, rect } of pending) {
      const gapX = Math.max(view.left - rect.right, rect.left - view.right);
      const gapY = Math.max(view.top - rect.bottom, rect.top - view.bottom);
      if (gapX >= 0 || gapY >= 0) {
        queued.push({ page, gap: Math.max(gapX, 0) + Math.max(gapY, 0) });
        continue;
      }
      const region = this.#detailRegion(page, rect, view, 0);
      const cropFirst =
        region &&
        (page.capped ||
          (region.right - region.left) * (region.bottom - region.top) <
            CROP_FIRST_BELOW * page.fullWidth * page.fullHeight);
      if (cropFirst) {
        page.renderDetail(region, scale);
        queued.push({ page, gap: -1 });
      } else {
        page.render(scale);
      }
    }

    this.#queue = queued
      .sort((a, b) => a.gap - b.gap)
      .map(({ page }) => page);
    if (this.#queue.length > 0 && this.#queueTimer === null) {
      this.#queueTimer = setTimeout(() => this.#renderNextQueued(), 0);
    }
  }

  #renderNextQueued() {
    this.#queueTimer = null;
    // The pinch's end rebuilds the queue for the scale it commits.
    if (this.#host.isPaused()) return;

    // A page may have been rendered by a rebuild, or moved out of range,
    // since it was queued — after a zoom with no pinch, the visible set is
    // the one from before it until the observer next reports.
    const view = this.#host.scroller.getBoundingClientRect();
    let page: PageView | undefined;
    while ((page = this.#queue.shift())) {
      if (
        !this.visiblePages.has(page) ||
        page.canvas.dataset.rendered !== "false"
      ) {
        continue;
      }
      const rect = page.wrapper.getBoundingClientRect();
      if (
        rect.bottom < view.top - view.height * RENDER_MARGIN ||
        rect.top > view.bottom + view.height * RENDER_MARGIN
      ) {
        continue;
      }
      page.render(this.#host.getScale());
      break;
    }
    if (this.#queue.length > 0) {
      this.#queueTimer = setTimeout(() => this.#renderNextQueued(), 0);
    }
  }

  /**
   * The region of `page` to render in detail, in its full-resolution device
   * px: the part inside the viewport, grown by `margin` of the viewport on
   * each side. Null when none of the page is in range. `rect` and `view` are
   * the page wrapper's and the scroller's client rects.
   */
  #detailRegion(
    page: PageView,
    rect: DOMRect,
    view: DOMRect,
    margin: number,
  ): Edges | null {
    const mx = view.width * margin;
    const my = view.height * margin;
    const local = {
      left: Math.max(view.left - mx, rect.left) - rect.left,
      top: Math.max(view.top - my, rect.top) - rect.top,
      right: Math.min(view.right + mx, rect.right) - rect.left,
      bottom: Math.min(view.bottom + my, rect.bottom) - rect.top,
    };
    const rotation = this.#host.getRotation();
    const swapped = isQuarterTurn(rotation);
    const inner = unrotate(
      local,
      rotation,
      swapped ? rect.height : rect.width,
      swapped ? rect.width : rect.height,
    );
    return deviceRegion(inner, this.#host.getLayoutDpr(), {
      width: page.fullWidth,
      height: page.fullHeight,
    });
  }

  #scheduleDetailRefresh = () => {
    if (this.#detailTimer !== null) clearTimeout(this.#detailTimer);
    this.#detailTimer = setTimeout(
      () => this.#refreshDetails(),
      DETAIL_SETTLE_MS,
    );
  };

  /**
   * Once scrolling settles, move each on-screen page's detail region to
   * where the page now is, if it no longer covers the part in view. Until
   * then the uncovered part shows the capped base, a little soft.
   */
  #refreshDetails() {
    this.#detailTimer = null;
    if (this.#host.isPaused()) return;

    const view = this.#host.scroller.getBoundingClientRect();
    const updates: { page: PageView; region: Edges }[] = [];
    for (const page of this.visiblePages) {
      if (!page.capped) continue;
      const rect = page.wrapper.getBoundingClientRect();
      const inView = this.#detailRegion(page, rect, view, 0);
      if (!inView) {
        page.dropDetail();
        continue;
      }
      if (page.detailRegion && covers(page.detailRegion, inView)) continue;
      updates.push({
        page,
        region: this.#detailRegion(page, rect, view, DETAIL_MARGIN)!,
      });
    }
    const scale = this.#host.getScale();
    for (const { page, region } of updates) {
      page.renderDetail(region, scale);
    }
  }
}
