/**
 * PDFium Engine Initialization
 *
 * Loads the PDFium wasm once (`pdfium_module.ts`) and builds the
 * `@embedpdf/engines` engine over it. Shared across the application.
 */

import { PdfiumNative, PdfEngine } from "@embedpdf/engines/pdfium";
import { browserImageDataToBlobConverter } from "@embedpdf/engines/converters";
import { fetchPdfiumWasm, loadPdfiumModule } from "./pdfium_module.js";
import type { PdfiumBindings } from "./pdfium_module.js";

export interface EngineInstances {
  engine: PdfEngine;
  native: PdfiumNative;
  /** Hover's own calls into the same wasm instance the engine uses. */
  bindings: PdfiumBindings;
}

let instances: EngineInstances | null = null;
let initPromise: Promise<EngineInstances> | null = null;
let primedWasm: ArrayBuffer | Uint8Array | null = null;

/**
 * Hand `initPdfiumEngine()` the wasm bytes up front, so it skips resolving and
 * fetching them. For bun tests, which have the package's copy on disk and no
 * extension URL to fetch from; the app never calls it.
 */
export function primePdfiumWasm(bytes: ArrayBuffer | Uint8Array) {
  primedWasm = bytes;
}

/**
 * Initialize the PDFium engine.
 */
export async function initPdfiumEngine(
  onProgress?: (progress: { percent: number; phase: string }) => void,
): Promise<EngineInstances> {
  if (instances) return instances;

  initPromise ??= (async () => {
    try {
      const wasmBinary = primedWasm ?? (await fetchPdfiumWasm(onProgress));

      onProgress?.({ percent: 50, phase: "initializing-pdfium" });
      const { bindings, engineModule } = await loadPdfiumModule(wasmBinary);

      onProgress?.({ percent: 70, phase: "creating-engine" });
      // The engine runs `PDFiumExt_Init()` in its constructor. The library is
      // already initialised by then, and PDFium ignores a second init.
      const native = new PdfiumNative(engineModule);
      const engine = new PdfEngine(native, {
        imageConverter: browserImageDataToBlobConverter,
      });

      onProgress?.({ percent: 100, phase: "ready" });
      console.log("[PDFium] Engine initialized successfully");

      instances = { engine, native, bindings };
      return instances;
    } catch (error) {
      console.error("[PDFium] Failed to initialize engine:", error);
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Get the initialized engine instances, or null before initPdfiumEngine()
 * has resolved.
 */
export function getEngineInstances(): EngineInstances | null {
  return instances;
}

/** Check if the engine is initialized. */
export function isEngineInitialized(): boolean {
  return instances !== null;
}

/**
 * Reset the engine (for testing or reinitialization)
 */
export function resetEngine() {
  instances = null;
  initPromise = null;
}
