/**
 * The PDFium wasm module, and the one typed surface Hover calls it through.
 *
 * `@embedpdf/pdfium` ships the Emscripten build and wraps every export in
 * `cwrap`, converting strings and booleans on the way. Hover calls the raw
 * exports instead (`_FPDF_*`), with the C signatures as they are: pointers and
 * `FPDF_BOOL`s are numbers, strings are heap pointers the caller allocates.
 * `PdfiumBindings` lists every function Hover calls, so this file is also the
 * inventory of what Hover needs from PDFium.
 *
 * The module is loaded once per page and shared (`initPdfium`). This is the
 * only file that imports `@embedpdf/pdfium`, which Hover uses only for its
 * Emscripten build of PDFium.
 */

import { init } from "@embedpdf/pdfium";

/**
 * Raw PDFium exports, by their C names. Every `FPDF_BOOL` comes back as 0 or 1,
 * not as a boolean, and every pointer, handle and out-parameter is a number.
 */
export interface PdfiumFunctions {
  // fpdfview.h: library, documents, pages
  FPDF_InitLibraryWithConfig(config: number): void;
  FPDF_LoadMemDocument(dataPtr: number, size: number, password: number): number;
  FPDF_CloseDocument(doc: number): void;
  FPDF_GetLastError(): number;
  FPDF_GetPageCount(doc: number): number;
  /** `size` is an `FS_SIZEF`: two f32, width then height. */
  FPDF_GetPageSizeByIndexF(doc: number, index: number, size: number): number;
  /**
   * `writer` is an `FPDF_FILEWRITE`: `{ int version; WriteBlock* }`, where
   * `WriteBlock(pThis, data, size)` returns nonzero on success.
   */
  FPDF_SaveAsCopy(doc: number, writer: number, flags: number): number;
  /** `tag` is a NUL-terminated byte string; the value comes back UTF-16LE. */
  FPDF_GetMetaText(doc: number, tag: number, buffer: number, bufLen: number): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): void;
  FPDF_GetPageWidthF(page: number): number;
  FPDF_GetPageHeightF(page: number): number;
  FPDFPage_GetRotation(page: number): number;
  /** Out-params are four f32. False when the page has no such box. */
  FPDFPage_GetCropBox(
    page: number,
    left: number,
    bottom: number,
    right: number,
    top: number,
  ): number;
  FPDFPage_GetMediaBox(
    page: number,
    left: number,
    bottom: number,
    right: number,
    top: number,
  ): number;
  FPDF_PageToDevice(
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    pageX: number,
    pageY: number,
    deviceX: number,
    deviceY: number,
  ): number;

  /**
   * `matrix` is an `FS_MATRIX` (six f32: a b c d e f) applied after the
   * page's own top-left-origin display matrix; `clip` an `FS_RECTF` (four
   * f32: left top right bottom) in device pixels.
   */
  FPDF_RenderPageBitmapWithMatrix(
    bitmap: number,
    page: number,
    matrix: number,
    clip: number,
    flags: number,
  ): void;

  // fpdfview.h: bitmaps
  /** Wraps `firstScan` (caller-owned) rather than allocating. */
  FPDFBitmap_CreateEx(
    width: number,
    height: number,
    format: number,
    firstScan: number,
    stride: number,
  ): number;
  FPDFBitmap_Destroy(bitmap: number): void;
  FPDFBitmap_FillRect(
    bitmap: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number,
  ): number;
  FPDFBitmap_GetBuffer(bitmap: number): number;
  FPDFBitmap_GetWidth(bitmap: number): number;
  FPDFBitmap_GetHeight(bitmap: number): number;
  FPDFBitmap_GetStride(bitmap: number): number;
  FPDFBitmap_GetFormat(bitmap: number): number;

  // fpdf_text.h
  FPDFText_LoadPage(page: number): number;
  FPDFText_ClosePage(textPage: number): void;
  FPDFText_CountChars(textPage: number): number;
  FPDFText_GetUnicode(textPage: number, index: number): number;
  FPDFText_GetText(
    textPage: number,
    startIndex: number,
    count: number,
    result: number,
  ): number;
  FPDFText_GetCharBox(
    textPage: number,
    index: number,
    left: number,
    right: number,
    bottom: number,
    top: number,
  ): number;
  FPDFText_GetLooseCharBox(textPage: number, index: number, rect: number): number;
  FPDFText_CountRects(textPage: number, startIndex: number, count: number): number;
  FPDFText_GetRect(
    textPage: number,
    rectIndex: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): number;
  FPDFText_GetFontSize(textPage: number, index: number): number;
  FPDFText_GetFontInfo(
    textPage: number,
    index: number,
    buffer: number,
    bufLen: number,
    flags: number,
  ): number;
  FPDFText_GetTextObject(textPage: number, index: number): number;
  /** `findWhat` is NUL-terminated UTF-16LE; `flags` PDFium's `FPDF_MATCH*`. */
  FPDFText_FindStart(
    textPage: number,
    findWhat: number,
    flags: number,
    startIndex: number,
  ): number;
  FPDFText_FindNext(search: number): number;
  FPDFText_GetSchResultIndex(search: number): number;
  FPDFText_GetSchCount(search: number): number;
  FPDFText_FindClose(search: number): void;

  // fpdf_edit.h: page objects
  FPDFPage_CountObjects(page: number): number;
  FPDFPage_GetObject(page: number, index: number): number;
  FPDFFormObj_CountObjects(formObject: number): number;
  FPDFFormObj_GetObject(formObject: number, index: number): number;
  FPDFPageObj_GetType(pageObject: number): number;
  FPDFPageObj_GetBounds(
    pageObject: number,
    left: number,
    bottom: number,
    right: number,
    top: number,
  ): number;
  FPDFTextObj_GetTextRenderMode(textObject: number): number;
  /** Colour out-params are four unsigned ints, 0–255. */
  FPDFPageObj_GetFillColor(
    pageObject: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): number;
  FPDFPageObj_GetStrokeColor(
    pageObject: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): number;
  FPDFPageObj_GetStrokeWidth(pageObject: number, width: number): number;
  /** `fillMode` is an int (0 = no fill); `stroke` an FPDF_BOOL. */
  FPDFPath_GetDrawMode(path: number, fillMode: number, stroke: number): number;
  FPDFImageObj_GetBitmap(imageObject: number): number;
  FPDFImageObj_GetImagePixelSize(
    imageObject: number,
    width: number,
    height: number,
  ): number;

  // fpdf_doc.h: outline, destinations, actions
  FPDFBookmark_GetFirstChild(doc: number, bookmark: number): number;
  FPDFBookmark_GetNextSibling(doc: number, bookmark: number): number;
  FPDFBookmark_GetTitle(bookmark: number, buffer: number, bufLen: number): number;
  FPDFBookmark_GetAction(bookmark: number): number;
  FPDFBookmark_GetDest(doc: number, bookmark: number): number;
  FPDFAction_GetType(action: number): number;
  FPDFAction_GetDest(doc: number, action: number): number;
  FPDFAction_GetURIPath(
    doc: number,
    action: number,
    buffer: number,
    bufLen: number,
  ): number;
  FPDFAction_GetFilePath(action: number, buffer: number, bufLen: number): number;
  FPDFDest_GetDestPageIndex(doc: number, dest: number): number;
  /** `numParams` is an unsigned long; `params` is room for four f32. */
  FPDFDest_GetView(dest: number, numParams: number, params: number): number;
  /** The `has*` out-params are `FPDF_BOOL` (i32); the values are f32. */
  FPDFDest_GetLocationInPage(
    dest: number,
    hasX: number,
    hasY: number,
    hasZoom: number,
    x: number,
    y: number,
    zoom: number,
  ): number;

  // fpdf_annot.h
  FPDFPage_GetAnnotCount(page: number): number;
  FPDFPage_GetAnnot(page: number, index: number): number;
  FPDFPage_CloseAnnot(annot: number): void;
  FPDFAnnot_GetRect(annot: number, rect: number): number;
  FPDFAnnot_GetSubtype(annot: number): number;
  FPDFAnnot_GetLink(annot: number): number;
  /** `key` is a NUL-terminated byte string; the value comes back UTF-16LE. */
  FPDFAnnot_GetStringValue(
    annot: number,
    key: number,
    buffer: number,
    bufLen: number,
  ): number;
  /** `value` is an f32 out-param. */
  FPDFAnnot_GetNumberValue(annot: number, key: number, value: number): number;
  /**
   * Fails for any annotation with a normal appearance stream, which is most
   * of them: PDFium treats the stream's colours as the real ones.
   */
  FPDFAnnot_GetColor(
    annot: number,
    type: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): number;
  FPDFAnnot_CountAttachmentPoints(annot: number): number;
  /** `quad` is an `FS_QUADPOINTSF`: eight f32, x1 y1 … x4 y4. */
  FPDFAnnot_GetAttachmentPoints(annot: number, index: number, quad: number): number;
  FPDFAnnot_GetInkListCount(annot: number): number;
  /** `buffer` holds `length` `FS_POINTF`s; returns the point count. */
  FPDFAnnot_GetInkListPath(
    annot: number,
    pathIndex: number,
    buffer: number,
    length: number,
  ): number;
  /** The objects of the annotation's normal appearance stream. */
  FPDFAnnot_GetObjectCount(annot: number): number;
  FPDFAnnot_GetObject(annot: number, index: number): number;
  FPDFPage_CreateAnnot(page: number, subtype: number): number;
  FPDFPage_RemoveAnnot(page: number, index: number): number;
  /** `rect` is an `FS_RECTF`: four f32, left top right bottom. */
  FPDFAnnot_SetRect(annot: number, rect: number): number;
  FPDFAnnot_AppendAttachmentPoints(annot: number, quad: number): number;
  FPDFAnnot_SetAttachmentPoints(annot: number, index: number, quad: number): number;
  /** `points` holds `count` `FS_POINTF`s; returns the stroke's index, or -1. */
  FPDFAnnot_AddInkStroke(annot: number, points: number, count: number): number;
  FPDFAnnot_RemoveInkList(annot: number): number;
  /**
   * Sets `/C`, and `/CA` from `a / 255`. Fails while the annotation has an
   * appearance stream, so call it before `FPDFAnnot_SetAP`.
   */
  FPDFAnnot_SetColor(
    annot: number,
    type: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): number;
  FPDFAnnot_SetFlags(annot: number, flags: number): number;
  /** Writes `/Border [h v width]`. */
  FPDFAnnot_SetBorder(
    annot: number,
    horizontalRadius: number,
    verticalRadius: number,
    width: number,
  ): number;
  /** `key` is a byte string; `value` NUL-terminated UTF-16LE. */
  FPDFAnnot_SetStringValue(annot: number, key: number, value: number): number;
  /**
   * Replace the appearance stream for `mode` with content `value` (UTF-16LE),
   * its `/BBox` the annotation's `/Rect`. When `/CA` < 1 the stream gets an
   * ExtGState `/GS` (Normal blend, that opacity) for the content to use. A
   * null `value` removes the stream.
   */
  FPDFAnnot_SetAP(annot: number, mode: number, value: number): number;
  FPDFLink_GetDest(doc: number, link: number): number;
  FPDFLink_GetAction(link: number): number;
}

/** The Emscripten runtime Hover uses alongside the exports. */
export interface PdfiumRuntime {
  /**
   * Heap views. Read them through the bindings each time rather than keeping
   * one: growing wasm memory replaces every view.
   */
  readonly HEAPU8: Uint8Array;
  readonly HEAP32: Int32Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPF32: Float32Array;
  readonly HEAPF64: Float64Array;
  malloc(size: number): number;
  free(ptr: number): void;
  /** Put a JS function in the wasm table; `signature` as Emscripten spells it. */
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  removeFunction(index: number): void;
}

export type PdfiumBindings = PdfiumFunctions & PdfiumRuntime;

/**
 * Every name in `PdfiumFunctions`. A `Record` rather than an array so the
 * compiler rejects a function added to the interface but not bound here.
 */
const FUNCTION_NAMES: Record<keyof PdfiumFunctions, true> = {
  FPDF_InitLibraryWithConfig: true,
  FPDF_LoadMemDocument: true,
  FPDF_CloseDocument: true,
  FPDF_GetLastError: true,
  FPDF_GetPageCount: true,
  FPDF_GetPageSizeByIndexF: true,
  FPDF_GetMetaText: true,
  FPDF_SaveAsCopy: true,
  FPDF_LoadPage: true,
  FPDF_ClosePage: true,
  FPDF_GetPageWidthF: true,
  FPDF_GetPageHeightF: true,
  FPDFPage_GetRotation: true,
  FPDFPage_GetCropBox: true,
  FPDFPage_GetMediaBox: true,
  FPDF_PageToDevice: true,
  FPDF_RenderPageBitmapWithMatrix: true,
  FPDFBitmap_CreateEx: true,
  FPDFBitmap_Destroy: true,
  FPDFBitmap_FillRect: true,
  FPDFBitmap_GetBuffer: true,
  FPDFBitmap_GetWidth: true,
  FPDFBitmap_GetHeight: true,
  FPDFBitmap_GetStride: true,
  FPDFBitmap_GetFormat: true,
  FPDFText_LoadPage: true,
  FPDFText_ClosePage: true,
  FPDFText_CountChars: true,
  FPDFText_GetUnicode: true,
  FPDFText_GetText: true,
  FPDFText_GetCharBox: true,
  FPDFText_GetLooseCharBox: true,
  FPDFText_CountRects: true,
  FPDFText_GetRect: true,
  FPDFText_GetFontSize: true,
  FPDFText_GetFontInfo: true,
  FPDFText_GetTextObject: true,
  FPDFText_FindStart: true,
  FPDFText_FindNext: true,
  FPDFText_GetSchResultIndex: true,
  FPDFText_GetSchCount: true,
  FPDFText_FindClose: true,
  FPDFPage_CountObjects: true,
  FPDFPage_GetObject: true,
  FPDFFormObj_CountObjects: true,
  FPDFFormObj_GetObject: true,
  FPDFPageObj_GetType: true,
  FPDFPageObj_GetBounds: true,
  FPDFTextObj_GetTextRenderMode: true,
  FPDFPageObj_GetFillColor: true,
  FPDFPageObj_GetStrokeColor: true,
  FPDFPageObj_GetStrokeWidth: true,
  FPDFPath_GetDrawMode: true,
  FPDFImageObj_GetBitmap: true,
  FPDFImageObj_GetImagePixelSize: true,
  FPDFBookmark_GetFirstChild: true,
  FPDFBookmark_GetNextSibling: true,
  FPDFBookmark_GetTitle: true,
  FPDFBookmark_GetAction: true,
  FPDFBookmark_GetDest: true,
  FPDFAction_GetType: true,
  FPDFAction_GetDest: true,
  FPDFAction_GetURIPath: true,
  FPDFAction_GetFilePath: true,
  FPDFDest_GetDestPageIndex: true,
  FPDFDest_GetView: true,
  FPDFDest_GetLocationInPage: true,
  FPDFPage_GetAnnotCount: true,
  FPDFPage_GetAnnot: true,
  FPDFPage_CloseAnnot: true,
  FPDFAnnot_GetRect: true,
  FPDFAnnot_GetSubtype: true,
  FPDFAnnot_GetLink: true,
  FPDFAnnot_GetStringValue: true,
  FPDFAnnot_GetNumberValue: true,
  FPDFAnnot_GetColor: true,
  FPDFAnnot_CountAttachmentPoints: true,
  FPDFAnnot_GetAttachmentPoints: true,
  FPDFAnnot_GetInkListCount: true,
  FPDFAnnot_GetInkListPath: true,
  FPDFAnnot_GetObjectCount: true,
  FPDFAnnot_GetObject: true,
  FPDFPage_CreateAnnot: true,
  FPDFPage_RemoveAnnot: true,
  FPDFAnnot_SetRect: true,
  FPDFAnnot_AppendAttachmentPoints: true,
  FPDFAnnot_SetAttachmentPoints: true,
  FPDFAnnot_AddInkStroke: true,
  FPDFAnnot_RemoveInkList: true,
  FPDFAnnot_SetColor: true,
  FPDFAnnot_SetFlags: true,
  FPDFAnnot_SetBorder: true,
  FPDFAnnot_SetStringValue: true,
  FPDFAnnot_SetAP: true,
  FPDFLink_GetDest: true,
  FPDFLink_GetAction: true,
};

/** The Emscripten module object, as far as this file reads it. */
type EmscriptenModule = Record<string, unknown> & PdfiumRuntime & {
  _malloc(size: number): number;
  _free(ptr: number): void;
};

function bind(em: EmscriptenModule): PdfiumBindings {
  const bindings: Record<string, unknown> = {
    malloc: em._malloc,
    free: em._free,
    addFunction: em.addFunction,
    removeFunction: em.removeFunction,
  };
  for (const name of Object.keys(FUNCTION_NAMES)) {
    const fn = em[`_${name}`];
    if (typeof fn !== "function") {
      throw new Error(`[PDFium] wasm build has no export ${name}`);
    }
    bindings[name] = fn;
  }
  for (const heap of ["HEAPU8", "HEAP32", "HEAPU32", "HEAPF32", "HEAPF64"]) {
    Object.defineProperty(bindings, heap, { get: () => em[heap] });
  }
  return bindings as unknown as PdfiumBindings;
}

/**
 * `FPDF_InitLibraryWithConfig` with a version-3 `FPDF_LIBRARY_CONFIG`:
 *
 *   int version; const char** m_pUserFontPaths; void* m_pIsolate;
 *   unsigned int m_v8EmbedderSlot; void* m_pPlatform;
 *
 * five 4-byte fields on wasm32, all zero but the version. No user font paths,
 * no V8. This replaces `@embedpdf/pdfium`'s `PDFiumExt_Init`; renders of every
 * fixture are byte-identical either way.
 */
function initLibrary(pdfium: PdfiumBindings) {
  const CONFIG_BYTES = 20;
  const config = pdfium.malloc(CONFIG_BYTES);
  if (!config) throw new Error("[PDFium] malloc for library config failed");
  try {
    pdfium.HEAPU8.fill(0, config, config + CONFIG_BYTES);
    pdfium.HEAP32[config >> 2] = 3;
    pdfium.FPDF_InitLibraryWithConfig(config);
  } finally {
    pdfium.free(config);
  }
}

/**
 * Instantiate the wasm and initialise the PDFium library in it. A fresh
 * instance every call; the app goes through `initPdfium()` instead.
 */
export async function loadPdfiumModule(
  wasmBinary: ArrayBuffer | Uint8Array,
): Promise<PdfiumBindings> {
  // The declared type wants an ArrayBuffer; Emscripten takes any BufferSource.
  // `init` also cwraps every export, which Hover doesn't use; `.pdfium` is
  // the Emscripten module underneath.
  const wrapped = await init({ wasmBinary: wasmBinary as ArrayBuffer });
  const bindings = bind(wrapped.pdfium as unknown as EmscriptenModule);
  initLibrary(bindings);
  return bindings;
}

let primedWasm: ArrayBuffer | Uint8Array | null = null;
let loading: Promise<PdfiumBindings> | null = null;

/**
 * Hand `initPdfium()` the wasm bytes up front, so it skips resolving and
 * fetching them. For bun tests, which have the package's copy on disk and no
 * extension URL to fetch from; the app never calls it.
 */
export function primePdfiumWasm(bytes: ArrayBuffer | Uint8Array) {
  primedWasm = bytes;
}

/** The app's PDFium: fetched and loaded on first call, shared after. */
export function initPdfium(
  onProgress?: (progress: { percent: number; phase: string }) => void,
): Promise<PdfiumBindings> {
  loading ??= (async () => {
    try {
      const wasmBinary = primedWasm ?? (await fetchPdfiumWasm(onProgress));
      onProgress?.({ percent: 50, phase: "initializing-pdfium" });
      const bindings = await loadPdfiumModule(wasmBinary);
      onProgress?.({ percent: 100, phase: "ready" });
      return bindings;
    } catch (error) {
      console.error("[PDFium] Failed to initialize:", error);
      loading = null;
      throw error;
    }
  })();
  return loading;
}

/** Resolve the wasm URL, bundled copy first, and download it. */
export async function fetchPdfiumWasm(
  onProgress?: (progress: { percent: number; phase: string }) => void,
): Promise<ArrayBuffer> {
  onProgress?.({ percent: 5, phase: "loading-wasm" });
  let wasmUrl: string | undefined;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    try {
      wasmUrl = chrome.runtime.getURL("pdfium.wasm");
    } catch {
      // Not a packaged extension context — fall through to the CDN URL.
    }
  }
  if (!wasmUrl) {
    if (__LOCAL_WASM_ONLY__) {
      throw new Error(
        "[PDFium] Local pdfium.wasm not resolvable; STORE_BUILD requires the bundled asset",
      );
    }
    const { DEFAULT_PDFIUM_WASM_URL } = await import("@embedpdf/pdfium");
    wasmUrl = DEFAULT_PDFIUM_WASM_URL;
  }

  onProgress?.({ percent: 10, phase: "downloading-wasm" });
  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch WASM: ${response.status}`);
  }

  onProgress?.({ percent: 30, phase: "parsing-wasm" });
  return await response.arrayBuffer();
}
