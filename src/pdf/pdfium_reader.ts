/**
 * Faithful reader for a PDFium page: PDFium calls in, plain JS data out.
 *
 * No layout interpretation happens here — that lives in layout_heuristics.js.
 * The split confines a PDFium upgrade to this file and keeps grouping changes
 * from touching decoding.
 */

import { PAGEOBJ, PdfiumFFI } from "./pdfium_ffi.js";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type {
  CharBox,
  CharRecord,
} from "../analysis/layout_heuristics.js";

/** A page-object bounding box in PDF coordinates (bottom-left origin). */
export interface ObjectBounds {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export class PdfiumPageReader {
  #pdfium: WrappedPdfiumModule;
  #ffi: PdfiumFFI;

  /**
   * @param ffi share one when several readers use a module
   */
  constructor(
    pdfiumModule: WrappedPdfiumModule,
    ffi: PdfiumFFI = new PdfiumFFI(pdfiumModule),
  ) {
    this.#pdfium = pdfiumModule;
    this.#ffi = ffi;
  }

  get ffi(): PdfiumFFI {
    return this.#ffi;
  }

  /** Release WASM scratch memory held by this reader. */
  dispose() {
    this.#ffi.dispose();
  }

  // ==========================================================================
  // Page lifecycle
  // ==========================================================================

  /** @param pageIndex 0-based */
  withPage<T>(
    docPtr: number,
    pageIndex: number,
    fn: (ctx: {
      pagePtr: number;
      pageWidth: number;
      pageHeight: number;
    }) => T,
  ): T | null {
    return this.#ffi.withPage(docPtr, pageIndex, fn);
  }

  /** @param pageIndex 0-based */
  withTextPage<T>(
    docPtr: number,
    pageIndex: number,
    fn: (ctx: {
      pagePtr: number;
      textPagePtr: number;
      pageWidth: number;
      pageHeight: number;
      charCount: number;
    }) => T,
  ): T | null {
    return this.#ffi.withTextPage(docPtr, pageIndex, fn);
  }

  // ==========================================================================
  // Text
  // ==========================================================================

  /**
   * Decode a UTF-16 character range from an open text page.
   *
   * FPDFText_GetText writes at most `count` UTF-16 units plus a NUL, so the
   * buffer is sized count + 1 and UTF16ToString has a terminator to stop at.
   *
   * Deliberately not upstream's approach: @embedpdf/engines decodes via
   * FPDFText_GetBoundedText with buflen equal to the text length, which writes
   * no terminator, so UTF16ToString reads past the buffer. Don't "simplify"
   * this back.
   *
   */
  readText(
    textPagePtr: number,
    startIndex: number,
    count: number,
  ): string {
    if (count <= 0) return "";
    const pdfium = this.#pdfium;

    return this.#ffi.withBuffer((count + 1) * 2, (bufPtr) => {
      const written = pdfium.FPDFText_GetText(
        textPagePtr,
        startIndex,
        count,
        bufPtr,
      );
      return written > 0 ? this.#ffi.utf16(bufPtr) : "";
    });
  }

  /**
   * Bounding box of one character, in PDF coordinates (bottom-left origin).
   *
   */
  readCharBox(textPagePtr: number, charIndex: number): CharBox | null {
    const pdfium = this.#pdfium;

    const box = this.#ffi.readF64Out(4, (l, r, b, t) =>
      pdfium.FPDFText_GetCharBox(textPagePtr, charIndex, l, r, b, t),
    );
    if (!box) return null;

    const [left, right, bottom, top] = box;
    return {
      left,
      right,
      bottom,
      top,
      width: right - left,
      height: top - bottom,
    };
  }

  /**
   * Read every character on a text page as {charCode, box} records.
   *
   */
  readChars(textPagePtr: number, charCount: number): CharRecord[] {
    const pdfium = this.#pdfium;
    if (charCount <= 0) return [];

    const chars: CharRecord[] = new Array(charCount);
    for (let i = 0; i < charCount; i++) {
      chars[i] = {
        charCode: pdfium.FPDFText_GetUnicode(textPagePtr, i),
        box: this.readCharBox(textPagePtr, i),
      };
    }
    return chars;
  }

  /**
   * Bounding rectangles for a character range, converted to a top-left origin.
   *
   * @param pageHeight for the Y flip
   */
  readTextRects(
    textPagePtr: number,
    startCharIndex: number,
    charCount: number,
    pageHeight: number,
  ): Rect[] {
    const pdfium = this.#pdfium;
    const rects: Rect[] = [];

    const rectCount = pdfium.FPDFText_CountRects(
      textPagePtr,
      startCharIndex,
      charCount,
    );
    if (rectCount <= 0) return rects;

    for (let i = 0; i < rectCount; i++) {
      const box = this.#ffi.readF64Out(4, (l, t, r, b) =>
        pdfium.FPDFText_GetRect(textPagePtr, i, l, t, r, b),
      );
      if (!box) continue;

      const [left, top, right, bottom] = box;
      rects.push({
        x: left,
        y: pageHeight - top,
        width: right - left,
        height: top - bottom,
      });
    }
    return rects;
  }

  /**
   * Boxes around the visible text on a page, as fractions of the page as
   * displayed (after /Rotate and the crop box, top-left origin), packed
   * [left, top, right, bottom, ...]. Consecutive characters of one text
   * object share a box. Loose boxes span the font's ascent to descent, so
   * accents and descenders are inside.
   *
   * Invisible text (render mode 3, and 7, which only clips) is left out:
   * scanned PDFs lay an OCR layer of it over the page image.
   */
  readVisibleTextBoxes(
    pagePtr: number,
    textPagePtr: number,
    charCount: number,
  ): Float32Array {
    const pdfium = this.#pdfium;
    const ffi = this.#ffi;

    // Page space to displayed-page fractions. FPDF_PageToDevice only reports
    // whole device pixels, so sample it on a large virtual device and fit
    // the affine map once.
    const N = 1 << 20;
    const [ox, oy, ax, ay, bx, by] = ffi.frame(() => {
      const [dx, dy] = ffi.slots(2, 4);
      const at = (x: number, y: number) => {
        pdfium.FPDF_PageToDevice(pagePtr, 0, 0, N, N, 0, x, y, dx, dy);
        return [ffi.i32(dx) / N, ffi.i32(dy) / N];
      };
      const o = at(0, 0);
      const ex = at(1000, 0);
      const ey = at(0, 1000);
      return [
        o[0],
        o[1],
        (ex[0] - o[0]) / 1000,
        (ex[1] - o[1]) / 1000,
        (ey[0] - o[0]) / 1000,
        (ey[1] - o[1]) / 1000,
      ];
    });

    const boxes: number[] = [];
    // The open run, in page space (y up).
    let runObj = 0;
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    const flush = () => {
      if (!runObj) return;
      const xs = [left, right];
      const ys = [bottom, top];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const x of xs) {
        for (const y of ys) {
          const u = ox + ax * x + bx * y;
          const v = oy + ay * x + by * y;
          minX = Math.min(minX, u);
          maxX = Math.max(maxX, u);
          minY = Math.min(minY, v);
          maxY = Math.max(maxY, v);
        }
      }
      boxes.push(minX, minY, maxX, maxY);
    };

    const visible = new Map<number, boolean>();
    ffi.frame(() => {
      // FS_RECTF: left, top, right, bottom as f32, contiguous.
      const [rect] = ffi.slots(4, 4);
      for (let i = 0; i < charCount; i++) {
        // Null for the spaces and line breaks PDFium generates itself.
        const obj = pdfium.FPDFText_GetTextObject(textPagePtr, i);
        if (!obj) continue;
        let shown = visible.get(obj);
        if (shown === undefined) {
          const mode = pdfium.FPDFTextObj_GetTextRenderMode(obj);
          shown = mode !== 3 && mode !== 7;
          visible.set(obj, shown);
        }
        if (!shown) continue;
        if (!pdfium.FPDFText_GetLooseCharBox(textPagePtr, i, rect)) continue;

        const l = ffi.f32(rect);
        const t = ffi.f32(rect + 4);
        const r = ffi.f32(rect + 8);
        const b = ffi.f32(rect + 12);
        if (obj === runObj) {
          left = Math.min(left, l);
          top = Math.max(top, t);
          right = Math.max(right, r);
          bottom = Math.min(bottom, b);
        } else {
          flush();
          runObj = obj;
          left = l;
          top = t;
          right = r;
          bottom = b;
        }
      }
    });
    flush();

    return new Float32Array(boxes);
  }

  /**
   * Font size and family for the character at `charIndex`.
   *
   */
  readFontInfo(
    textPagePtr: number,
    charIndex: number,
  ): { size: number; family: string | null } {
    const pdfium = this.#pdfium;
    const size = pdfium.FPDFText_GetFontSize(textPagePtr, charIndex);

    // Length query: null buffer, zero size, no flags pointer.
    const nameLength = pdfium.FPDFText_GetFontInfo(
      textPagePtr,
      charIndex,
      0,
      0,
      0,
    );
    if (nameLength <= 0) return { size, family: null };

    const bytesCount = nameLength + 1;
    return this.#ffi.withBuffer(bytesCount, (namePtr) =>
      this.#ffi.frame(() => {
        const [flagsPtr] = this.#ffi.slots(1, 4);
        pdfium.FPDFText_GetFontInfo(
          textPagePtr,
          charIndex,
          namePtr,
          bytesCount,
          flagsPtr,
        );
        // Font name is UTF-8 encoded.
        return { size, family: this.#ffi.utf8(namePtr) || null };
      }),
    );
  }

  // ==========================================================================
  // Page objects
  // ==========================================================================

  /**
   * Bounding box of a page object via FPDFPageObj_GetBounds.
   *
   */
  readObjectBounds(objPtr: number): ObjectBounds | null {
    const pdfium = this.#pdfium;

    const bounds = this.#ffi.readF32Out(4, (l, b, r, t) =>
      pdfium.FPDFPageObj_GetBounds(objPtr, l, b, r, t),
    );
    if (!bounds) return null;

    const [left, bottom, right, top] = bounds;
    return { left, bottom, right, top };
  }

  /**
   * Collect the bounds of every PATH object on a page, descending into form
   * objects. Unfiltered and in document order; deciding which ones read as
   * rules is a layout question.
   *
   * @param containerPtr Page or form object pointer
   * @param isForm Whether containerPtr is a form object
   */
  readPathBounds(containerPtr: number, isForm = false): ObjectBounds[] {
    const pdfium = this.#pdfium;
    const bounds: ObjectBounds[] = [];

    const count = isForm
      ? pdfium.FPDFFormObj_CountObjects(containerPtr)
      : pdfium.FPDFPage_CountObjects(containerPtr);

    for (let i = 0; i < count; i++) {
      const objPtr = isForm
        ? pdfium.FPDFFormObj_GetObject(containerPtr, i)
        : pdfium.FPDFPage_GetObject(containerPtr, i);
      if (!objPtr) continue;

      const type = pdfium.FPDFPageObj_GetType(objPtr);

      if (type === PAGEOBJ.FORM) {
        const nested = this.readPathBounds(objPtr, true);
        for (let j = 0; j < nested.length; j++) bounds.push(nested[j]);
        continue;
      }
      if (type !== PAGEOBJ.PATH) continue;

      const box = this.readObjectBounds(objPtr);
      if (box) bounds.push(box);
    }
    return bounds;
  }
}
