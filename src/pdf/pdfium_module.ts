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
 * Until the engine is removed (`docs/plan_own_pdf_engine.md` phase 6), the same
 * instance is also handed to `@embedpdf/engines` in its wrapped form
 * (`engineModule`). This is the only file that imports `@embedpdf/pdfium`.
 */

import { init } from "@embedpdf/pdfium";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

/** The cwrap'd module `@embedpdf/engines` takes. Gone with the engine. */
export type EngineModule = WrappedPdfiumModule;

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
  /** `tag` is a NUL-terminated byte string; the value comes back UTF-16LE. */
  FPDF_GetMetaText(doc: number, tag: number, buffer: number, bufLen: number): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): void;
  FPDF_GetPageWidthF(page: number): number;
  FPDF_GetPageHeightF(page: number): number;
  FPDFPage_GetRotation(page: number): number;
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
  FPDF_RenderPageBitmap(
    bitmap: number,
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    flags: number,
  ): void;

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
  FPDFBitmap_Create(width: number, height: number, alpha: number): number;
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
  FPDF_LoadPage: true,
  FPDF_ClosePage: true,
  FPDF_GetPageWidthF: true,
  FPDF_GetPageHeightF: true,
  FPDFPage_GetRotation: true,
  FPDF_PageToDevice: true,
  FPDF_RenderPageBitmap: true,
  FPDF_RenderPageBitmapWithMatrix: true,
  FPDFBitmap_Create: true,
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
  FPDFPage_CountObjects: true,
  FPDFPage_GetObject: true,
  FPDFFormObj_CountObjects: true,
  FPDFFormObj_GetObject: true,
  FPDFPageObj_GetType: true,
  FPDFPageObj_GetBounds: true,
  FPDFTextObj_GetTextRenderMode: true,
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

export interface LoadedPdfium {
  bindings: PdfiumBindings;
  /** The same instance, wrapped for `@embedpdf/engines`. */
  engineModule: EngineModule;
}

/** Instantiate the wasm and initialise the PDFium library in it. */
export async function loadPdfiumModule(
  wasmBinary: ArrayBuffer | Uint8Array,
): Promise<LoadedPdfium> {
  // The declared type wants an ArrayBuffer; Emscripten takes any BufferSource.
  const engineModule = await init({ wasmBinary: wasmBinary as ArrayBuffer });
  const bindings = bind(engineModule.pdfium as unknown as EmscriptenModule);
  initLibrary(bindings);
  return { bindings, engineModule };
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
