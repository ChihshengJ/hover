/** How long the button stays up before it fades on its own, in ms. */
const DISMISS_AFTER_MS = 7000;

export interface ScrollBackButtonOptions {
  /** the button is appended here */
  paneEl: HTMLElement;
  /** the scrolling element, once it exists */
  getScroller: () => HTMLElement;
}

/**
 * Offers the reader a way back after a citation jump: a button returning the
 * scroller to where it was, which fades on its own after a while.
 */
export class ScrollBackButton {
  options: ScrollBackButtonOptions;
  #scrollTop = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #el: HTMLElement | null = null;

  constructor(options: ScrollBackButtonOptions) {
    this.options = options;
  }

  /** Offer a way back to `scrollTop`, which showed `page`. */
  show(scrollTop: number, page: number) {
    this.dismiss(true);

    this.#scrollTop = scrollTop;

    const btn = document.createElement("button");
    btn.className = "scroll-back-btn";
    btn.title = `Back to page ${page}`;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M11 7H3M3 7L6.5 3.5M3 7L6.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span> Back to page ${page}</span>
    `;

    btn.addEventListener("click", () => {
      this.options.getScroller().scrollTo({
        top: this.#scrollTop,
        behavior: "instant",
      });
      this.dismiss();
    });

    this.options.paneEl.appendChild(btn);
    this.#el = btn;

    requestAnimationFrame(() => btn.classList.add("visible"));

    this.#timer = setTimeout(() => this.dismiss(), DISMISS_AFTER_MS);
  }

  dismiss(immediate = false) {
    const el = this.#el;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!el) return;

    if (immediate) {
      el.remove();
      this.#el = null;
      return;
    }

    el.classList.add("fading");
    el.addEventListener(
      "transitionend",
      () => {
        el.remove();
        if (this.#el === el) this.#el = null;
      },
      { once: true },
    );
  }

  destroy() {
    this.dismiss(true);
  }
}
