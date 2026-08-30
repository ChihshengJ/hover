/**
 * Layout heuristics for turning a page's character stream into text runs.
 *
 * Nothing here touches PDFium or WASM: the input is a plain array of character
 * records, so this module can be exercised against a recorded page without a
 * WASM instance.
 */

export interface CharBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
  width: number;
  height: number;
}

export interface CharRecord {
  /** Unicode code point. */
  charCode: number;
  /** null when PDFium reports no box. */
  box: CharBox | null;
}

export interface TextRun {
  /** Index of the run's first character. */
  startIndex: number;
  /** Index of the run's last character, trailing included. */
  endIndex: number;
  /** Visible text plus any trailing whitespace/control chars. */
  content: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A run under construction, before `finish()` turns it into a `TextRun`. */
interface PartialRun {
  startIndex: number;
  endIndex: number;
  chars: string[];
  trailingChars: string[];
  left: number;
  top: number;
  right: number;
  bottom: number;
  maxHeight: number;
  lastVisibleCharCode: number;
}

/**
 * Tunables for grouping characters into runs.
 *
 * @readonly
 */
export const RUN_HEURISTICS = Object.freeze({
  /** Y tolerance for "same line", as a multiple of the run's height. */
  LINE_TOLERANCE_FACTOR: 1.2,
  /** Horizontal gap that starts a new run, as a multiple of the run's height. */
  WORD_GAP_FACTOR: 2,
  /** Characters shorter than this do not raise a run's height. */
  MIN_HEIGHT_FOR_RUN_HEIGHT: 5,
  /** Character boxes larger than these are treated as junk and skipped. */
  MAX_CHAR_WIDTH: 200,
  MAX_CHAR_HEIGHT: 100,
  /** Runs taller than this are dropped. */
  MAX_RUN_HEIGHT: 100,
});

/**
 * Tunables for deciding which path objects read as horizontal/vertical rules.
 *
 * @readonly
 */
export const RULE_HEURISTICS = Object.freeze({
  MAX_THICKNESS: 3,
  MIN_LENGTH: 20,
});

/**
 * Unicode space separators, which PDFium emits alongside plain U+0020 since
 * 2.6.1 — it now reports the document's real NBSP/EN/EM/THIN spaces instead of
 * normalising them. They must count as whitespace: treated as visible glyphs
 * they pull a run's right edge out to the following word.
 */
export const isUnicodeSpace = (code: number): boolean =>
  code === 0x20 || // SPACE
  code === 0xa0 || // NO-BREAK SPACE
  code === 0x1680 || // OGHAM SPACE MARK
  (code >= 0x2000 && code <= 0x200a) || // EN QUAD … HAIR SPACE
  code === 0x202f || // NARROW NO-BREAK SPACE
  code === 0x205f || // MEDIUM MATHEMATICAL SPACE
  code === 0x3000; // IDEOGRAPHIC SPACE

export const isCJK = (code: number): boolean =>
  (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
  (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
  (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
  (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
  (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
  (code >= 0x3040 && code <= 0x309f) || // Hiragana
  (code >= 0x30a0 && code <= 0x30ff) || // Katakana
  (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
  (code >= 0xac00 && code <= 0xd7af); // Hangul Syllables

const isNewlineCode = (code: number) => code === 10 || code === 13;
const isDigitCode = (code: number) => code >= 48 && code <= 57;

/** Letters, plus everything above ASCII, which is alphabetic for our purposes. */
const isAlphaCode = (code: number) =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;

/** Sentence punctuation that can neighbour a superscript digit: , . ; : */
const isPunctCode = (code: number) =>
  code === 44 || code === 46 || code === 59 || code === 58;

/**
 * Does a bounding box read as a rule (a horizontal or vertical hairline)?
 *
 * Used to pick out header/footer separators from among a page's path objects.
 * The test is on bounds rather than segment structure because rules are drawn
 * both as two-segment strokes and as very thin filled rectangles.
 */
export function isRuleLikeBounds(
  width: number,
  height: number,
  tunables: typeof RULE_HEURISTICS = RULE_HEURISTICS,
): boolean {
  const { MAX_THICKNESS, MIN_LENGTH } = tunables;
  return (
    (height < MAX_THICKNESS && width > MIN_LENGTH) ||
    (width < MAX_THICKNESS && height > MIN_LENGTH)
  );
}

/**
 * Group a page's characters into text runs.
 *
 * Runs approximate words: they break at whitespace, line changes, wide
 * horizontal gaps, and script/character-class boundaries. Whitespace and
 * control characters never extend a run's box; they are appended to the
 * preceding run's content so the text still reconstructs by concatenation.
 *
 * @param chars Page characters in PDFium's reading order
 */
export function groupCharsIntoRuns(
  chars: CharRecord[],
  tunables: typeof RUN_HEURISTICS = RUN_HEURISTICS,
): TextRun[] {
  const runs: TextRun[] = [];
  if (!chars || chars.length === 0) return runs;

  const {
    LINE_TOLERANCE_FACTOR,
    WORD_GAP_FACTOR,
    MIN_HEIGHT_FOR_RUN_HEIGHT,
    MAX_CHAR_WIDTH,
    MAX_CHAR_HEIGHT,
    MAX_RUN_HEIGHT,
  } = tunables;

  let current: PartialRun | null = null;

  const startRun = (
    index: number,
    charCode: number,
    box: CharBox,
  ): PartialRun => ({
    startIndex: index,
    endIndex: index,
    chars: [String.fromCodePoint(charCode)],
    trailingChars: [],
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    maxHeight: box.height,
    lastVisibleCharCode: charCode,
  });

  const finish = () => {
    const run = current;
    current = null;
    if (!run) return;

    const visibleContent = run.chars.join("");
    if (!visibleContent || /^\s*$/.test(visibleContent)) return;

    const width = run.right - run.left;
    const height = run.maxHeight;
    if (width <= 0 || height <= 0) return;
    if (height > MAX_RUN_HEIGHT) return;

    runs.push({
      startIndex: run.startIndex,
      endIndex: run.endIndex,
      content: visibleContent + run.trailingChars.join(""),
      left: run.left,
      top: run.top,
      width,
      height,
    });
  };

  for (let i = 0; i < chars.length; i++) {
    const { charCode, box } = chars[i];
    const isNewline = isNewlineCode(charCode);
    const isControlChar = charCode < 32 && !isNewline;

    // Characters with no visual representation never extend a run's box.
    if (!box || isUnicodeSpace(charCode) || isNewline || isControlChar) {
      if (current) {
        current.trailingChars.push(String.fromCodePoint(charCode));
        current.endIndex = i;
        // A newline closes the run once it has been recorded.
        if (isNewline) finish();
      }
      // Leading whitespace is dropped; page text still carries it.
      continue;
    }

    // Zero-area boxes are not renderable — letting one into a run drags the
    // run's box to wherever it sits. PDFium reports them for markers like
    // U+00AD, which is what we want gone.
    //
    // TODO: the character is dropped from the run's content too, so a glyph
    // PDFium happens to report with a collapsed box (a combining mark, say)
    // would go missing from the slice text. Nothing has hit that yet; the fix
    // is to append these to trailingChars like whitespace and drop only the
    // known markers (TEXT_MARKERS in inline_extractor.js).
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.height > MAX_CHAR_HEIGHT || box.width > MAX_CHAR_WIDTH) continue;

    if (!current) {
      current = startRun(i, charCode, box);
      continue;
    }

    const hasTrailingWhitespace = current.trailingChars.length > 0;

    const sameLine =
      Math.abs(box.bottom - current.bottom) <
      current.maxHeight * LINE_TOLERANCE_FACTOR;
    const isAdjacent =
      box.left - current.right < current.maxHeight * WORD_GAP_FACTOR;

    const lastCode = current.lastVisibleCharCode;
    const isDigit = isDigitCode(charCode);
    const digitAlphaBoundary =
      (isDigit && isAlphaCode(lastCode)) ||
      (isAlphaCode(charCode) && isDigitCode(lastCode));

    // Break runs between punctuation and digits to prevent body-text
    // punctuation (with full-size height) from being grouped with superscript
    // numbers, which would inflate avgHeight and prevent superscript detection
    // downstream.
    const punctuationDigitBoundary =
      (isDigit && isPunctCode(lastCode)) ||
      (isDigitCode(lastCode) && isPunctCode(charCode));

    // CJK characters have no word separators — break at every character
    // boundary to keep runs small (prevents width-based filtering from dropping
    // entire lines, and enables per-character text selection).
    const cjkBoundary = isCJK(charCode) || isCJK(lastCode);

    if (
      hasTrailingWhitespace ||
      !sameLine ||
      !isAdjacent ||
      digitAlphaBoundary ||
      punctuationDigitBoundary ||
      cjkBoundary
    ) {
      finish();
      current = startRun(i, charCode, box);
      continue;
    }

    current.endIndex = i;
    current.chars.push(String.fromCodePoint(charCode));
    current.right = Math.max(current.right, box.right);
    current.bottom = Math.min(current.bottom, box.bottom);
    current.top = Math.max(current.top, box.top);
    if (box.height > MIN_HEIGHT_FOR_RUN_HEIGHT) {
      current.maxHeight = Math.max(current.maxHeight, box.height);
    }
    current.lastVisibleCharCode = charCode;
  }

  finish();
  return runs;
}
