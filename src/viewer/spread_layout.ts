/** 0: no spread; 1: even spread; 2: odd spread. */
export type SpreadMode = 0 | 1 | 2;

type SpreadRole = "left" | "right" | "single";

/** What the layout needs of a page; PageView, structurally. */
interface SpreadPage {
  wrapper: HTMLElement;
}

const ROLE_CLASSES = [
  "spread-page",
  "spread-page-left",
  "spread-page-right",
  "spread-page-single",
];

/**
 * Group pages into the rows of a spread: pairs from the first page in even
 * mode, or from the second in odd mode, with the first page alone. A page
 * left without a partner at the end gets a row of its own.
 */
export function pairPages<T>(pages: T[], mode: Exclude<SpreadMode, 0>): T[][] {
  const pairs: T[][] = [];
  let start = 0;
  if (mode === 2 && pages.length > 0) {
    pairs.push([pages[0]]);
    start = 1;
  }
  for (let i = start; i < pages.length; i += 2) {
    pairs.push(pages.slice(i, i + 2));
  }
  return pairs;
}

function setSpreadRole(wrapper: HTMLElement, role: SpreadRole | null) {
  wrapper.classList.remove(...ROLE_CLASSES);
  if (role) wrapper.classList.add("spread-page", `spread-page-${role}`);
}

/**
 * Arranges the page wrappers on the stage: a single column, or rows of
 * spreads inside a spread container.
 */
export class SpreadLayout {
  #container: HTMLDivElement | null = null;
  #rows: HTMLElement[] = [];

  /** Lay `pages` out on `stage` for `mode`, undoing any spread first. */
  apply(stage: HTMLElement, pages: SpreadPage[], mode: SpreadMode) {
    this.clear(stage);

    if (mode === 0) {
      for (const pageView of pages) {
        setSpreadRole(pageView.wrapper, null);
        stage.appendChild(pageView.wrapper);
      }
      return;
    }

    this.#container = document.createElement("div");
    this.#container.className = "spread-container";
    stage.appendChild(this.#container);

    for (const pair of pairPages(pages, mode)) {
      const row = document.createElement("div");
      row.className = "spread-row";

      if (pair.length === 1) {
        // Single page (first page in odd mode, or last page if odd total)
        setSpreadRole(pair[0].wrapper, "single");
        row.appendChild(pair[0].wrapper);
        row.classList.add("spread-row-single");
      } else {
        const [left, right] = pair;
        setSpreadRole(left.wrapper, "left");
        row.appendChild(left.wrapper);
        setSpreadRole(right.wrapper, "right");
        row.appendChild(right.wrapper);
      }

      this.#container.appendChild(row);
      this.#rows.push(row);
    }
  }

  /** Move every wrapper out of its spread row back onto `stage`. */
  clear(stage: HTMLElement) {
    for (const row of this.#rows) {
      while (row.firstChild) {
        stage.appendChild(row.firstChild);
      }
      row.remove();
    }
    this.#rows = [];

    if (this.#container) {
      while (this.#container.firstChild) {
        stage.appendChild(this.#container.firstChild);
      }
      this.#container.remove();
      this.#container = null;
    }
  }
}
