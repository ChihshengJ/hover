import { PDFDocumentModel } from "./doc.js";
import { SplitWindowManager } from "./window_manager.js";
import { FileMenu } from "./controls/file_menu.js";
import { LoadingOverlay } from "./controls/loading_overlay.js";
import { OnboardingWalkthrough } from "./settings/onboarding.js";

import "../styles/_variables.css";
import "../styles/viewer.css";
import "../styles/text_layer.css";
import "../styles/floating_toolbar.css";
import "../styles/citation_popup.css";
import "../styles/navigation_tree.css";
import "../styles/nightmode.css";
import "../styles/annotations.css";
import "../styles/progress_bar.css";
import "../styles/file_menu.css";
import "../styles/search.css";
import "../styles/loading_overlay.css";
import "../styles/onboarding.css";

const el = {
  wd: document.getElementById("window-container"),
  pageNum: document.getElementById("current-page"),
};

/**
 * Check if we're running in extension context vs dev server
 */
function isExtensionContext() {
  return (
    typeof chrome !== "undefined" &&
    chrome.runtime?.id &&
    window.location.protocol === "chrome-extension:"
  );
}

/**
 * Get URL parameter for dev mode
 */
function getDevUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("file") || urlParams.get("url");
}

/**
 * Get human-readable status message for loading phase
 */
function getStatusMessage(phase) {
  const messages = {
    "loading-wasm": "Loading PDF engine...",
    "downloading-wasm": "Downloading PDF engine...",
    "parsing-wasm": "Parsing PDF engine...",
    "initializing-pdfium": "Initializing PDFium...",
    "creating-engine": "Creating engine...",
    ready: "Engine ready",
    "initializing engine": "Initializing PDF engine...",
    downloading: "Downloading document...",
    parsing: "Parsing PDF...",
    processing: "Processing document...",
    caching: "Caching pages...",
    "loading bookmarks": "Loading bookmarks...",
    "loading annotations": "Loading annotations...",
    "building outline": "Building outline...",
    "initializing search": "Initializing search...",
    "indexing references": "Indexing references...",
    complete: "Complete",
  };
  return messages[phase] || "Loading...";
}

/**
 * Fetch PDF from URL (for dev mode only)
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

/**
 * Get intercepted PDF from background script
 */
async function getInterceptedPdf() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("source") !== "intercepted") {
    return null;
  }

  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_PENDING_PDF" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[Main] Error getting pending PDF:",
          chrome.runtime.lastError,
        );
        resolve(null);
        return;
      }

      if (response?.success && response?.data?.data) {
        try {
          const binary = atob(response.data.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          resolve({
            data: bytes.buffer,
            name: response.data.name || "document.pdf",
            url: response.data.url || null,
          });
        } catch (error) {
          console.error("[Main] Error parsing intercepted PDF:", error);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Get local PDF from background script (for popup-initiated loads)
 */
async function getLocalPdfFromBackground() {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LOCAL_PDF" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      if (response?.success && response?.data?.data) {
        try {
          const binary = atob(response.data.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          resolve({
            data: bytes.buffer,
            name: response.data.name || "document.pdf",
          });
        } catch (error) {
          console.error(
            "[Main] Error parsing local PDF from background:",
            error,
          );
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Load PDF - handles both extension and dev contexts
 */
async function loadPdf(isFirstLaunch = false) {
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

    // For first launch, load the default onboarding paper
    if (isFirstLaunch) {
      loadingOverlay.setProgress(0.1, "Fetching tutorial document...");
      const url = OnboardingWalkthrough.getDefaultPaperUrl();
      const defaultPdfData = await fetchPdfFromUrl(url, onProgress);

      await pdfmodel.load(defaultPdfData, onProgress);
      loadingOverlay.setProgress(0.95, "Initializing viewer...");

      const wm = new SplitWindowManager(el.wd, pdfmodel);
      await wm.initialize();
      const fileMenu = new FileMenu(wm);

      document.title = "Welcome to Hover - Tutorial";
      await loadingOverlay.hide();

      setTimeout(async () => {
        const onboarding = new OnboardingWalkthrough(wm, fileMenu);
        await onboarding.start();
      }, 500);

      return;
    }

    let pdfSource = null;
    let pdfName = "document.pdf";

    if (inExtension) {
      // 1. Check for intercepted PDF (from content script)
      const interceptedPdf = await getInterceptedPdf();
      if (interceptedPdf) {
        pdfSource = interceptedPdf.data;
        pdfName = interceptedPdf.name;
        console.log("[Main] Loading intercepted PDF:", pdfName);
      }

      // 2. Check for local PDF from sessionStorage
      if (!pdfSource && PDFDocumentModel.hasLocalPdf()) {
        const localPdf = PDFDocumentModel.getLocalPdf();
        if (localPdf) {
          pdfSource = localPdf.data;
          pdfName = localPdf.name;
          console.log("[Main] Loading local PDF from sessionStorage:", pdfName);
        }
      }

      // 3. Check for local PDF from background (popup uploads)
      if (!pdfSource) {
        const backgroundPdf = await getLocalPdfFromBackground();
        if (backgroundPdf) {
          pdfSource = backgroundPdf.data;
          pdfName = backgroundPdf.name;
          console.log("[Main] Loading PDF from background:", pdfName);
        }
      }
    }

    else {
      const devUrl = getDevUrl();
      if (devUrl) {
        console.log("[Main] DEV MODE - Loading from URL:", devUrl);
        loadingOverlay.setIndeterminate("Downloading document...");
        pdfSource = await fetchPdfFromUrl(devUrl, onProgress);
        pdfName = devUrl.split("/").pop()?.split("?")[0] || "document.pdf";
      }

      if (!pdfSource && PDFDocumentModel.hasLocalPdf()) {
        const localPdf = PDFDocumentModel.getLocalPdf();
        if (localPdf) {
          pdfSource = localPdf.data;
          pdfName = localPdf.name;
          console.log(
            "[Main] DEV MODE - Loading from sessionStorage:",
            pdfName,
          );
        }
      }
    }

    if (!pdfSource && !inExtension) {
      console.log("[Main] DEV MODE - No URL specified, loading default paper");
      const defaultUrl = "https://arxiv.org/pdf/2501.19393";
      pdfSource = await fetchPdfFromUrl(defaultUrl, onProgress);
      pdfName = "default.pdf";
    }

    if (!pdfSource) {
      throw new Error(
        "No PDF document to display. Please open a PDF file or navigate to a PDF URL.",
      );
    }

    loadingOverlay.setProgress(0.1, "Loading document...");
    await pdfmodel.load(pdfSource, onProgress);
    loadingOverlay.setProgress(0.95, "Initializing viewer...");

    const wm = new SplitWindowManager(el.wd, pdfmodel);
    await wm.initialize();
    const fileMenu = new FileMenu(wm);

    const detectedTitle = await pdfmodel.getDocumentTitle();
    const fileName = pdfName.replace(/\.pdf$/i, "");
    document.title = (detectedTitle || fileName) + " - Hover PDF";

    PDFDocumentModel.clearLocalPdf();

    await loadingOverlay.hide();
  } catch (error) {
    console.error("[Main] Error loading PDF:", error);
    PDFDocumentModel.clearLocalPdf();
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
  const isFirstLaunch = await OnboardingWalkthrough.isFirstLaunch();

  if (isFirstLaunch) {
    PDFDocumentModel.clearLocalPdf();
  }

  await loadPdf(isFirstLaunch);
}

main();
