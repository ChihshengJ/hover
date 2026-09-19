/**
 * Toolbar glyph markup.
 *
 * Every glyph here is inline SVG painted in `currentColor`, never an `<img>`.
 * The toolbar's icon color is a single CSS token — `--tool-icon-color`, see
 * the comment above it in floating_toolbar.css — that the night-mode themes
 * and the adaptive glass state both drive, and only inline SVG can follow it.
 * Raster icons had to be filter-inverted instead, which is what used to make
 * the glyphs fight the palette.
 *
 * The two stateful buttons (spread, fit) swap between the variants below, so
 * the markup lives here rather than inside toolbar_dom.ts: one copy, shared
 * by the initial build and by the swap in tool_actions.ts. The `assets/*.png`
 * spread icons these replace are gone from the DOM for the same reason —
 * a PNG cannot take a color.
 */

import type { SpreadMode } from "../../../viewer/viewpane.js";

/**
 * The open-book outline both spread glyphs are built on — the single-page
 * icon on its own, and the frame the page digits sit inside.
 */
const BOOK_PATHS = `
    <path d="M5 17H9C10.6569 17 12 18.3431 12 20V10C12 7.17157 12 5.75736 11.1213 4.87868C10.2426 4 8.82843 4 6 4H5C4.05719 4 3.58579 4 3.29289 4.29289C3 4.58579 3 5.05719 3 6V15C3 15.9428 3 16.4142 3.29289 16.7071C3.58579 17 4.05719 17 5 17Z" stroke="currentColor"/>
    <path d="M19 17H15C13.3431 17 12 18.3431 12 20V10C12 7.17157 12 5.75736 12.8787 4.87868C13.7574 4 15.1716 4 18 4H19C19.9428 4 20.4142 4 20.7071 4.29289C21 4.58579 21 5.05719 21 6V15C21 15.9428 21 16.4142 20.7071 16.7071C20.4142 17 19.9428 17 19 17Z" stroke="currentColor"/>`;

/**
 * Wrap page digits in the book frame.
 *
 * The digits are drawn, not typeset: `<text>` would pick up whatever the
 * system substitutes for the UI font and shift between platforms, and these
 * glyphs are 25px wide.
 */
const spreadIcon = (digits: string) => `
  <svg class="tool-icon" width="25" height="25" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${BOOK_PATHS}${digits}
  </svg>`;

/** A digit centered on one page of the book: left page cx 7.2, right cx 16.8. */
const ZERO = (cx: number) =>
  `\n    <ellipse cx="${cx}" cy="10.3" rx="1.3" ry="2.3" stroke="currentColor" stroke-width="1.1"/>`;

const ONE = (cx: number) =>
  `\n    <path d="M${cx} 8V12.6M${cx - 1} 8.9L${cx} 8M${cx - 1.3} 12.6H${cx + 1.3}" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;

const TWO = (cx: number) =>
  `\n    <path d="M${cx - 1.35} 9.1A1.4 1.4 0 1 1 ${cx + 1.1} 10.4L${cx - 1.35} 12.6H${cx + 1.35}" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;

const LEFT_PAGE = 7.2;
const RIGHT_PAGE = 16.8;

/** One glyph per spread mode, indexed by it. */
export const SPREAD_ICONS: Record<SpreadMode, string> = {
  0: spreadIcon(""),
  1: spreadIcon(ONE(LEFT_PAGE) + TWO(RIGHT_PAGE)),
  2: spreadIcon(ZERO(LEFT_PAGE) + ONE(RIGHT_PAGE)),
};

/** Tooltip body for each spread mode, shown by tool_button_tooltip.ts. */
export const SPREAD_TIPS: Record<SpreadMode, string> = {
  0: "Single page — click to cycle: even → odd → single",
  1: "Even spread (1-2, 3-4...) — click to cycle: odd → single → even",
  2: "Odd spread (1, 2-3, 4-5...) — click to cycle: single → even → odd",
};

/** The fit glyph is one arrow-between-rules drawn on each axis. */
const FIT_HORIZONTAL_PATHS = `
    <path d="M104 200V600" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M697 200V600" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M240.731 317.269L158 400" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M158.487 401.539L241.219 484.271" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M555.487 484L638.219 401.269" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M637.731 399.729L555 316.998" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M197 400H620" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>`;

const FIT_VERTICAL_PATHS = `
    <path d="M600 104L200 104" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M600 697L200 697" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M482.731 240.731L400 158" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M398.461 158.487L315.729 241.219" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M316 555.487L398.731 638.219" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M400.271 637.731L483.002 555" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
    <path d="M400 197L400 620" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>`;

/** Sized 20 and 18 as the `<img>` icons were: the vertical glyph reads taller. */
const fitIcon = (size: number, paths: string) => `
  <svg class="tool-icon" width="${size}" height="${size}" viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg">${paths}
  </svg>`;

export const FIT_HORIZONTAL_ICON = fitIcon(20, FIT_HORIZONTAL_PATHS);
export const FIT_VERTICAL_ICON = fitIcon(18, FIT_VERTICAL_PATHS);
