/**
 * PDFium Engine Initialization
 *
 * Initializes the @embedpdf/engines PDFium WASM module.
 * This module is loaded once and shared across the application.
 */

import { init } from "@embedpdf/pdfium";
import { PdfiumNative, PdfEngine } from "@embedpdf/engines/pdfium";
import { browserImageDataToBlobConverter } from "@embedpdf/engines/converters";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

export interface EngineInstances {
  engine: PdfEngine;
  native: PdfiumNative;
  pdfiumModule: WrappedPdfiumModule;
}

let engineInstance: PdfEngine | null = null;
let nativeInstance: PdfiumNative | null = null;
let pdfiumModule: WrappedPdfiumModule | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the PDFium engine.
 */
export async function initPdfiumEngine(
  onProgress?: (progress: { percent: number; phase: string }) => void,
): Promise<EngineInstances> {
  if (engineInstance && nativeInstance && pdfiumModule) {
    return {
      engine: engineInstance,
      native: nativeInstance,
      pdfiumModule: pdfiumModule,
    };
  }

  if (initPromise) {
    await initPromise;
    return {
      engine: engineInstance,
      native: nativeInstance,
      pdfiumModule: pdfiumModule,
    };
  }

  initPromise = (async () => {
    try {
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
      const wasmBinary = await response.arrayBuffer();

      onProgress?.({ percent: 50, phase: "initializing-pdfium" });

      pdfiumModule = await init({ wasmBinary });
      pdfiumModule.PDFiumExt_Init();

      onProgress?.({ percent: 70, phase: "creating-engine" });
      nativeInstance = new PdfiumNative(pdfiumModule);
      engineInstance = new PdfEngine(nativeInstance, {
        imageConverter: browserImageDataToBlobConverter,
      });

      onProgress?.({ percent: 100, phase: "ready" });

      console.log("[PDFium] Engine initialized successfully");
    } catch (error) {
      console.error("[PDFium] Failed to initialize engine:", error);
      initPromise = null;
      throw error;
    }
  })();

  await initPromise;
  return {
    engine: engineInstance,
    native: nativeInstance,
    pdfiumModule: pdfiumModule,
  };
}

/**
 * Get the initialized engine instances, or null before initPdfiumEngine()
 * has resolved.
 */
export function getEngineInstances(): EngineInstances | null {
  if (!engineInstance || !nativeInstance || !pdfiumModule) {
    return null;
  }

  return {
    engine: engineInstance,
    native: nativeInstance,
    pdfiumModule: pdfiumModule,
  };
}

/** Check if the engine is initialized. */
export function isEngineInitialized(): boolean {
  return (
    engineInstance !== null && nativeInstance !== null && pdfiumModule !== null
  );
}

/**
 * Reset the engine (for testing or reinitialization)
 */
export function resetEngine() {
  engineInstance = null;
  nativeInstance = null;
  pdfiumModule = null;
  initPromise = null;
}
