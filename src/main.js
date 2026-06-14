import { PDFDocumentModel } from "./doc.js";
import { SplitWindowManager } from "./window_manager.js";
import { FileMenu } from "./controls/file_menu.js";
import { EmptyState } from "./controls/empty_state.js";
import { LoadingOverlay } from "./controls/loading_overlay.js";
import { OnboardingWalkthrough } from "./settings/onboarding.js";
import { Config } from "./settings/config.js";
import { TrailStore } from "./trail/trail_store.js";
import { TrailLinker } from "./trail/trail_linker.js";
import { TrailOverlay } from "./trail/trail_overlay.js";

import "../styles/index.css";

const el = {
  wd: document.getElementById("window-container"),
  pageNum: document.getElementById("current-page"),
};

// ============================================
// Pending PDF Storage (IndexedDB)
// ============================================

const PENDING_DB_NAME = "hover-pending-pdf";
const PENDING_DB_STORE = "data";

/**
 * @returns {Promise<{ data: ArrayBuffer, name: string, url: string|null } | null>}
 */
async function consumePendingPdf() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB_NAME, 1);
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore(PENDING_DB_STORE);
    req.onerror = (e) => reject(e.target.error);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(PENDING_DB_STORE, "readwrite");
      const store = tx.objectStore(PENDING_DB_STORE);
      const getReq = store.get("pending");
      store.delete("pending");
      tx.oncomplete = () => {
        db.close();
        resolve(getReq.result || null);
      };
      tx.onerror = (err) => {
        db.close();
        reject(err.target.error);
      };
    };
  });
}

// ============================================
// Utilities
// ============================================

function isExtensionContext() {
  return (
    typeof chrome !== "undefined" &&
    chrome.runtime?.id &&
    ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(
      window.location.protocol,
    )
  );
}

function getDevUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("file") || urlParams.get("url");
}

function getStatusMessage(phase) {
  const messages = {
    "loading-wasm": "Loading PDF engine...",
    "downloading-wasm": "Downloading PDF engine...",
    "parsing-wasm": "PDF engine warming up...",
    "initializing-pdfium": "Initializing PDFium...",
    "creating-engine": "Creating engine...",
    ready: "Engine ready",
    "initializing engine": "Initializing PDF engine...",
    "setting up text extraction engine": "Setting up text extraction...",
    downloading: "Downloading document...",
    parsing: "Parsing PDF...",
    processing: "Processing document...",
    caching: "Caching pages...",
    "loading bookmarks": "Loading bookmarks...",
    "loading annotations": "Loading annotations...",
    "building outline": "Building outline...",
    "initializing search": "Initializing search...",
    "indexing text": "Indexing text...",
    "indexing references": "Indexing references...",
    complete: "Complete",
  };
  return messages[phase] || "Loading...";
}

/**
 * @param {string} url
 * @param {(p: {loaded: number, total: number, percent: number, phase: string}) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchPdfFromUrl(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : -1;

  if (total > 0 && response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      loaded += value.length;

      if (onProgress) {
        const percent = Math.round((loaded / total) * 100);
        onProgress({ loaded, total, percent, phase: "downloading" });
      }
    }

    const combined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined.buffer;
  } else {
    return await response.arrayBuffer();
  }
}

function adoptContentScriptOverlay() {
  const existing = document.getElementById("hover-loading-overlay");
  if (!existing) return false;
  existing.remove();
  const styles = document.querySelectorAll("style");
  for (const s of styles) {
    if (s.textContent?.includes("hover-loading-overlay")) {
      s.remove();
    }
  }
  return true;
}

// ============================================
// Main Loading
// ============================================

async function loadPdf(isFirstLaunch = false) {
  adoptContentScriptOverlay();

  const loadingOverlay = new LoadingOverlay();
  loadingOverlay.show();

  try {
    const pdfmodel = new PDFDocumentModel();
    const inExtension = isExtensionContext();

    const onProgress = ({ loaded, total, percent, phase }) => {
      if (total === -1) {
        loadingOverlay.setIndeterminate(getStatusMessage(phase));
      } else {
        loadingOverlay.setProgress(percent / 100, getStatusMessage(phase));
      }
    };

    const urlParams = new URLSearchParams(window.location.search);
    const intendedUrl = inExtension ? urlParams.get("url") : getDevUrl();

    // Onboarding (first launch with a URL-based open, otherwise onboarding will not initiate)
    if (isFirstLaunch && intendedUrl) {
      OnboardingWalkthrough.saveIntendedUrl(intendedUrl);

      loadingOverlay.setProgress(0.1, "Fetching tutorial document...");
      const defaultPdfData = await fetchPdfFromUrl(
        OnboardingWalkthrough.getDefaultPaperUrl(),
        onProgress,
      );

      await pdfmodel.load(defaultPdfData, onProgress);
      loadingOverlay.setProgress(0.95, "Initializing viewer...");

      const wm = new SplitWindowManager(el.wd, pdfmodel);
      await wm.initialize();
      const fileMenu = new FileMenu(wm);

      document.title = "Welcome to Hover - Tutorial";
      await loadingOverlay.hide();

      await pdfmodel.buildIndex();
      wm.toolbar?.navigationTree?.reinitialize();
      wm.progressBar?.buildSectionMarks();

      setTimeout(async () => {
        const onboarding = new OnboardingWalkthrough(wm, fileMenu);
        await onboarding.start();
      }, 500);

      return;
    }

    if (isFirstLaunch) {
      await OnboardingWalkthrough.markCompleted();
    }

    // Resolve PDF source
    let pdfSource = null;
    let pdfName = "document.pdf";
    let originalUrl = null;

    if (inExtension) {
      // Chrome/Safari park bytes via the content-script capture before the
      // viewer opens, so drain that first.
      let pending = await consumePendingPdf();

      // Firefox: the webRequest redirect lands with ?url= and nothing parked.
      // Ask the background to fetch the URL into the pending store, then drain
      // it the same way — one viewer code path across browsers, and bytes
      // always reach the low-level (UTF-8-safe) parser via the buffer.
      if (!pending && intendedUrl) {
        loadingOverlay.setIndeterminate("Downloading document...");
        const onPdfProgress = (msg) => {
          if (msg?.type === "PDF_PROGRESS") {
            loadingOverlay.setProgress(
              msg.percent / 100,
              "Downloading document...",
            );
          }
        };
        chrome.runtime.onMessage.addListener(onPdfProgress);
        try {
          await chrome.runtime.sendMessage({
            type: "FETCH_URL_TO_PENDING",
            url: intendedUrl,
          });
          pending = await consumePendingPdf();
        } catch (e) {
          console.warn("[Main] Background URL park failed:", e);
        } finally {
          chrome.runtime.onMessage.removeListener(onPdfProgress);
        }
      }

      if (pending) {
        pdfSource = pending.data;
        pdfName = pending.name;
        originalUrl = pending.url || null;
        console.log("[Main] Loading PDF from IDB:", pdfName);
      } else if (intendedUrl) {
        // Fallback: background park didn't yield bytes (messaging hiccup or an
        // event-page restart) — fetch directly so we still render something.
        console.log("[Main] Falling back to viewer-side fetch:", intendedUrl);
        loadingOverlay.setIndeterminate("Downloading document...");
        pdfSource = await fetchPdfFromUrl(intendedUrl, onProgress);
        pdfName =
          intendedUrl.split("/").pop()?.split("?")[0] || "document.pdf";
        originalUrl = intendedUrl;
      }
    } else {
      const devUrl = getDevUrl();
      if (devUrl) {
        console.log("[Main] DEV MODE - Loading from URL:", devUrl);
        loadingOverlay.setIndeterminate("Downloading document...");
        pdfSource = await fetchPdfFromUrl(devUrl, onProgress);
        pdfName = devUrl.split("/").pop()?.split("?")[0] || "document.pdf";
        originalUrl = devUrl;
      }

      if (!pdfSource) {
        const pending = await consumePendingPdf();
        if (pending) {
          pdfSource = pending.data;
          pdfName = pending.name;
          originalUrl = pending.url || null;
          console.log("[Main] DEV MODE - Loading from IDB:", pdfName);
        }
      }
    }

    if (!pdfSource && !inExtension) {
      console.log("[Main] DEV MODE - No URL specified, loading default paper");
      const defaultUrl = "https://arxiv.org/pdf/2501.19393";
      pdfSource = await fetchPdfFromUrl(defaultUrl, onProgress);
      pdfName = "default.pdf";
      originalUrl = defaultUrl;
    }

    if (!pdfSource) {
      // No document to render. In the extension this is the normal landing
      // when the user opens the viewer with nothing queued (e.g. the popup's
      // "Open Local PDF"); show the empty state so they can pick a file from
      // this persistent tab (the popup can't host the picker on Firefox).
      if (inExtension) {
        loadingOverlay.destroy();
        new EmptyState(el.wd);
        return;
      }
      throw new Error(
        "No PDF document to display. Please open a PDF file or navigate to a PDF URL.",
      );
    }

    // Load and initialize
    loadingOverlay.setProgress(0.1, "Loading document...");
    await pdfmodel.load(pdfSource, onProgress);
    loadingOverlay.setProgress(0.95, "Initializing viewer...");

    // Initializing components
    const wm = new SplitWindowManager(el.wd, pdfmodel);
    await wm.initialize();
    const fileMenu = new FileMenu(wm); // Initializing settings

    const fileName = pdfName.replace(/\.pdf$/i, "");
    document.title = fileName;

    await loadingOverlay.hide();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    // Start parsing and update components
    await pdfmodel.buildIndex();
    wm.toolbar?.navigationTree?.reinitialize();
    wm.progressBar?.buildSectionMarks();

    const detectedTitle = await pdfmodel.getDocumentTitle();
    if (detectedTitle) {
      document.title = detectedTitle;
    }

    // Trail system initialization
    try {
      const trailStore = new TrailStore();
      await trailStore.initialize();
      const trailLinker = new TrailLinker(pdfmodel, trailStore, originalUrl);
      trailLinker.initialize();
      const matchResult = await trailLinker.matchOnOpen(detectedTitle);
      const trailOverlay = new TrailOverlay(
        trailStore,
        detectedTitle,
        originalUrl,
      );
      trailOverlay.initialize();
    } catch (err) {
      console.warn("[Trail] Failed to initialize:", err);
    }
  } catch (error) {
    console.error("[Main] Error loading PDF:", error);
    loadingOverlay.destroy();
    el.wd.innerHTML = `
      <div style="color: red; text-align: center; padding: 50px;">
        <h2>Failed to load PDF</h2>
        <p>${error.message}</p>
        <p style="font-size: 12px; color: #666; margin-top: 20px;">
          ${isExtensionContext()
        ? "Try uploading a PDF file directly using the extension popup."
        : "DEV MODE: Pass a URL with ?file=https://... or upload a file."
      }
        </p>
      </div>
    `;
  }
}

async function main() {
  console.log(`
                                  
 _____                 _         
|  |  |___ _ _ ___ ___|_|___ ___ 
|     | . | | | -_|  _| |   | . |
|__|__|___|\\_/|___|_| |_|_|_|_  |
                            |___|
                                 
                                 
 ___ ___ ___ ___ ___ ___ ___     
|___|___|___|___|___|___|___|    
                                 
  `);
  try {
    await Config.load();
  } catch (err) {
    console.warn("[Main] Config.load failed — continuing with defaults:", err);
  }
  applyInitialNightMode();
  const isFirstLaunch = await OnboardingWalkthrough.isFirstLaunch();
  await loadPdf(isFirstLaunch);
}

/**
 * Decide whether to launch in night mode, based on the user's startup
 * preference. Applied before any UI is constructed so there's no flash.
 */
function applyInitialNightMode() {
  const mode = Config.get("night_mode_startup");
  let isNight = false;
  if (mode === "night") isNight = true;
  else if (mode === "persist") isNight = !!Config.get("night_mode_last");
  document.body.classList.toggle("night-mode", isNight);
}

main();
