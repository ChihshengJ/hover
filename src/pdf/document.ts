/**
 * One open PDF, read through Hover's own PDFium bindings.
 *
 * Owns the document pointer and the heap copy of the file PDFium reads from,
 * and answers every document-level question the app asks: page geometry,
 * metadata, the outline. Text and path extraction for its pages go through
 * the `PdfiumTextExtractor` it holds.
 */

import { PdfiumTextExtractor } from "./text_extractor.js";
import { readBookmarks } from "./destinations.js";
import type { PageTextResult, PagePathsResult } from "./text_extractor.js";
import type { PdfiumBindings } from "./pdfium_module.js";
import type { PdfiumFFI } from "./pdfium_ffi.js";

/** PDFium's `FPDF_ERR_*`, by what they mean to a caller. */
const OPEN_ERRORS: Record<number, PdfOpenErrorKind> = {
  1: "unknown",
  2: "file",
  3: "format",
  4: "password",
  5: "security",
  6: "page",
};

export type PdfOpenErrorKind =
  | "unknown"
  | "file"
  | "format"
  | "password"
  | "security"
  | "page";

/** Why PDFium refused a file. `code` is its `FPDF_GetLastError()`. */
export class PdfOpenError extends Error {
  readonly code: number;
  readonly kind: PdfOpenErrorKind;

  constructor(code: number, detail = "") {
    const kind = OPEN_ERRORS[code] ?? "unknown";
    super(`Failed to open PDF: ${kind} (error code ${code})${detail}`);
    this.name = "PdfOpenError";
    this.code = code;
    this.kind = kind;
  }
}

/**
 * How many loaded pages a document keeps. Loading parses the page's content
 * (1–4 ms on the fixture papers), and the viewer renders the same few pages
 * again on every zoom. The engine kept 10 too.
 */
const LOADED_PAGE_LIMIT = 10;

/** `FPDF_NO_INCREMENTAL`: write the whole file, not an update appended to it. */
const SAVE_FULL_REWRITE = 2;

/** The Info keys `PdfMetadata` carries beyond the standard ones. */
const CUSTOM_META_KEYS = ["DOI", "License", "arXivID", "PTEX.Fullbanner"] as const;

/**
 * A PDF date (`D:YYYYMMDDHHmmSS…`), read as UTC with any offset ignored.
 * Ported from `@embedpdf/models`' `pdfDateToDate` as it is, offset handling
 * included, so dates read the same as before.
 */
export function pdfDateToDate(raw: string | null): Date | null {
  if (!raw?.startsWith("D:") || raw.length < 16) return null;
  const field = (from: number, to: number) => +raw.slice(from, to);
  return new Date(
    Date.UTC(
      field(2, 6),
      field(6, 8) - 1,
      field(8, 10),
      field(10, 12),
      field(12, 14),
      field(14, 16),
    ),
  );
}

export class PdfiumDocument {
  #pdfium: PdfiumBindings;
  #extractor: PdfiumTextExtractor;
  #docPtr: number;
  #filePtr: number;
  #fileLength: number;
  #pages: PdfPage[];
  #rotations = new Map<number, number>();
  /** Loaded page pointers by index, least recently used first. */
  #loaded = new Map<number, number>();

  private constructor(
    pdfium: PdfiumBindings,
    extractor: PdfiumTextExtractor,
    docPtr: number,
    filePtr: number,
    fileLength: number,
    pages: PdfPage[],
  ) {
    this.#pdfium = pdfium;
    this.#extractor = extractor;
    this.#docPtr = docPtr;
    this.#filePtr = filePtr;
    this.#fileLength = fileLength;
    this.#pages = pages;
  }

  /**
   * Open `bytes`. PDFium reads from its own heap copy for as long as the
   * document is open; that copy is freed on failure or in `close()`.
   *
   * @throws PdfOpenError
   */
  static open(
    pdfium: PdfiumBindings,
    bytes: Uint8Array,
    password: string | null = null,
  ): PdfiumDocument {
    const extractor = new PdfiumTextExtractor(pdfium);
    const ffi = extractor.reader.ffi;
    let filePtr = 0;
    let docPtr = 0;
    try {
      filePtr = ffi.allocBytes(bytes);
      // A null pointer, not an empty string, means "no password".
      docPtr = ffi.withCString(password || null, (passwordPtr) =>
        pdfium.FPDF_LoadMemDocument(filePtr, bytes.length, passwordPtr),
      );
      if (!docPtr) throw new PdfOpenError(pdfium.FPDF_GetLastError());

      const pages = PdfiumDocument.#readPages(ffi, docPtr);
      return new PdfiumDocument(
        pdfium,
        extractor,
        docPtr,
        filePtr,
        bytes.length,
        pages,
      );
    } catch (error) {
      if (docPtr) pdfium.FPDF_CloseDocument(docPtr);
      ffi.free(filePtr);
      extractor.dispose();
      throw error;
    }
  }

  /** Every page's size, without loading (and so parsing) any page. */
  static #readPages(ffi: PdfiumFFI, docPtr: number): PdfPage[] {
    const pdfium = ffi.pdfium;
    const count = pdfium.FPDF_GetPageCount(docPtr);
    const pages: PdfPage[] = [];
    for (let index = 0; index < count; index++) {
      const size = ffi.readF32Out(2, (sizePtr) =>
        pdfium.FPDF_GetPageSizeByIndexF(docPtr, index, sizePtr),
      );
      if (!size) {
        throw new PdfOpenError(
          pdfium.FPDF_GetLastError(),
          `: no size for page ${index}`,
        );
      }
      pages.push({ index, size: { width: size[0], height: size[1] } });
    }
    return pages;
  }

  get pdfium(): PdfiumBindings {
    return this.#pdfium;
  }

  get ffi(): PdfiumFFI {
    return this.#extractor.reader.ffi;
  }

  get docPtr(): number {
    return this.#docPtr;
  }

  get extractor(): PdfiumTextExtractor {
    return this.#extractor;
  }

  get pageCount(): number {
    return this.#pages.length;
  }

  /** @param index 0-based */
  page(index: number): PdfPage | null {
    return this.#pages[index] ?? null;
  }

  get pages(): readonly PdfPage[] {
    return this.#pages;
  }

  /**
   * The page's `/Rotate`, in quarter turns clockwise (0–3).
   *
   * Not part of `PdfPage`, and read on demand: standard PDFium only reports
   * it for a loaded page, and loading parses the page's content, 1–4 ms a
   * page. Page sizes already have it applied.
   *
   * @param index 0-based
   */
  pageRotation(index: number): number {
    let rotation = this.#rotations.get(index);
    if (rotation === undefined) {
      rotation =
        this.withLoadedPage(index, (pagePtr) =>
          this.#pdfium.FPDFPage_GetRotation(pagePtr),
        ) ?? 0;
      this.#rotations.set(index, rotation);
    }
    return rotation;
  }

  /**
   * Run `fn` with the page loaded, from the document's cache of recently used
   * pages. The pointer is only good inside `fn`: the next page loaded may
   * evict it.
   *
   * Text extraction doesn't use this. It loads and closes its own page, with
   * a text page on top.
   *
   * @param index 0-based
   * @returns null when the page can't be loaded
   */
  withLoadedPage<T>(index: number, fn: (pagePtr: number) => T): T | null {
    let pagePtr = this.#loaded.get(index);
    if (pagePtr) {
      this.#loaded.delete(index);
    } else {
      if (!this.#docPtr || index < 0 || index >= this.#pages.length) return null;
      pagePtr = this.#pdfium.FPDF_LoadPage(this.#docPtr, index);
      if (!pagePtr) return null;
      for (const [oldest, oldPtr] of this.#loaded) {
        if (this.#loaded.size < LOADED_PAGE_LIMIT) break;
        this.#pdfium.FPDF_ClosePage(oldPtr);
        this.#loaded.delete(oldest);
      }
    }
    this.#loaded.set(index, pagePtr);
    return fn(pagePtr);
  }

  /** An Info dictionary entry; null when it is absent or empty. */
  #metaText(key: string): string | null {
    const ffi = this.ffi;
    return ffi.withCString(key, (tag) => {
      // The length includes the two-byte terminator, so 2 means empty.
      const length = this.#pdfium.FPDF_GetMetaText(this.#docPtr, tag, 0, 0);
      if (length <= 2) return null;
      return ffi.withBuffer(length, (buffer) => {
        this.#pdfium.FPDF_GetMetaText(this.#docPtr, tag, buffer, length);
        return ffi.utf16(buffer);
      });
    });
  }

  metadata(): PdfMetadata {
    const custom: PdfMetadata["custom"] = {};
    for (const key of CUSTOM_META_KEYS) {
      const value = this.#metaText(key);
      if (value !== null) custom[key] = value;
    }
    return {
      title: this.#metaText("Title"),
      author: this.#metaText("Author"),
      subject: this.#metaText("Subject"),
      keywords: this.#metaText("Keywords"),
      producer: this.#metaText("Producer"),
      creator: this.#metaText("Creator"),
      creationDate: pdfDateToDate(this.#metaText("CreationDate")),
      modificationDate: pdfDateToDate(this.#metaText("ModDate")),
      custom,
    };
  }

  /** The document outline, empty when it has none. */
  bookmarks(): PdfBookmark[] {
    return readBookmarks(this.ffi, this.#docPtr);
  }

  /**
   * The document as it is now, edits included, written out as a whole new
   * file (`FPDF_SaveAsCopy`, not incremental).
   */
  save(): Uint8Array<ArrayBuffer> {
    const pdfium = this.#pdfium;
    const ffi = this.ffi;
    const chunks: Uint8Array[] = [];
    // `WriteBlock(pThis, data, size)`: copy each block out of the heap as it
    // comes, since PDFium reuses the buffer.
    const writeBlock = pdfium.addFunction((_self, data, size) => {
      chunks.push(pdfium.HEAPU8.slice(data, data + size));
      return 1;
    }, "iiii");
    try {
      const ok = ffi.withBuffer(8, (writer) => {
        pdfium.HEAP32[writer >> 2] = 1; // version
        pdfium.HEAP32[(writer >> 2) + 1] = writeBlock;
        return pdfium.FPDF_SaveAsCopy(this.#docPtr, writer, SAVE_FULL_REWRITE);
      });
      if (!ok) throw new Error("PDFium could not save the document");
    } finally {
      pdfium.removeFunction(writeBlock);
    }

    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  /**
   * A copy of the file this document was opened from. PDFium only ever reads
   * the buffer it loads from, so these are the original bytes for as long as
   * the document is open.
   */
  fileBytes(): Uint8Array {
    if (!this.#filePtr) throw new Error("Document is closed");
    return this.ffi.bytes(this.#filePtr, this.#fileLength).slice();
  }

  /** @param pageIndex 0-based */
  extractPageText(pageIndex: number): PageTextResult {
    return this.#extractor.extractPageText(this.#docPtr, pageIndex);
  }

  /** @param pageIndex 0-based */
  extractPagePaths(pageIndex: number): PagePathsResult {
    return this.#extractor.extractPagePaths(this.#docPtr, pageIndex);
  }

  /** Visible-text boxes for a 0-based page. */
  extractTextBoxes(pageIndex: number): Float32Array {
    return this.#extractor.extractTextBoxes(this.#docPtr, pageIndex);
  }

  /** Close the document and free its file buffer. Safe to call twice. */
  close() {
    for (const pagePtr of this.#loaded.values()) {
      this.#pdfium.FPDF_ClosePage(pagePtr);
    }
    this.#loaded.clear();
    if (this.#docPtr) {
      this.#pdfium.FPDF_CloseDocument(this.#docPtr);
      this.#docPtr = 0;
    }
    if (this.#filePtr) {
      this.ffi.free(this.#filePtr);
      this.#filePtr = 0;
    }
    this.#extractor.dispose();
  }
}
