/**
 * PDFium Engine Initialization
 *
 * Initializes the @embedpdf/engines PDFium WASM module.
 * This module is loaded once and shared across the application.
 */

import { init, DEFAULT_PDFIUM_WASM_URL } from "@embedpdf/pdfium";
import { PdfiumNative, PdfEngine } from "@embedpdf/engines/pdfium";
import { browserImageDataToBlobConverter } from "@embedpdf/engines/converters";

/** @type {PdfEngine|null} */
let engineInstance = null;

/** @type {PdfiumNative|null} */
let nativeInstance = null;

let pdfiumModule = null;

/** @type {Promise<void>|null} */
let initPromise = null;

/**
 * Initialize the PDFium engine
 * @param {(progress: {percent: number, phase: string}) => void} [onProgress]
 * @returns {Promise<{engine: PdfEngine, native: PdfiumNative}>}
 */
export async function initPdfiumEngine(onProgress) {
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
      let wasmUrl = DEFAULT_PDFIUM_WASM_URL;
      if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        try {
          wasmUrl = chrome.runtime.getURL("pdfium.wasm");
        } catch (e) {
          // Fall back to default URL
        }
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

      // Initialize the extended PDFium functionality
      pdfiumModule.PDFiumExt_Init();

      onProgress?.({ percent: 70, phase: "creating-engine" });
      // Create native executor (auto-initializes PDFium)
      nativeInstance = new PdfiumNative(pdfiumModule);

      // Create orchestrator with image converter
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
 * Get the initialized engine instances
 * @returns {{engine: PdfEngine|null, native: PdfiumNative|null}}
 */
export function getEngineInstances() {
  if (!engineInstance || !nativeInstance || !pdfiumModule) {
    return null;
  }

  return {
    engine: engineInstance,
    native: nativeInstance,
    pdfiumModule: pdfiumModule,
  };
}

/**
 * Check if the engine is initialized
 * @returns {boolean}
 */
export function isEngineInitialized() {
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
