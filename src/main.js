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

function getIntendedPdfUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlParam = urlParams.get("file");
  if (urlParam) {
    return urlParam;
  }

  if (window.location.hash) {
    const hashUrl = window.location.hash.substring(1);
    if (hashUrl) return hashUrl;
  }

  return "https://arxiv.org/pdf/2501.19393";
}

function getPdfUrl(forceDefault = false) {
  if (forceDefault) {
    return OnboardingWalkthrough.getDefaultPaperUrl();
  }

  return getIntendedPdfUrl() || OnboardingWalkthrough.getDefaultPaperUrl();
}

/**
 * Get human-readable status message for loading phase
 * @param {string} phase
 * @returns {string}
 */
function getStatusMessage(phase) {
  const messages = {
    // Engine initialization phases
    "loading-wasm": "Loading PDF engine...",
    "downloading-wasm": "Downloading PDF engine...",
    "parsing-wasm": "Parsing PDF engine...",
    "initializing-pdfium": "Initializing PDFium...",
    "creating-engine": "Creating engine...",
    ready: "Engine ready",
    "initializing engine": "Initializing PDF engine...",

    // Document loading phases
    downloading: "Downloading document...",
    downloaded: "Document downloaded",
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
 * Check for local PDF from background script (for popup-initiated loads)
 * @returns {Promise<{data: ArrayBuffer, name: string} | null>}
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
          console.error("Error parsing local PDF from background:", error);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Load PDF from either local upload (sessionStorage), background script, or URL
 * @param {boolean} isFirstLaunch - Whether this is the first launch
 */
async function loadPdf(isFirstLaunch = false) {
  const loadingOverlay = new LoadingOverlay();
  loadingOverlay.show();

  try {
    const pdfmodel = new PDFDocumentModel();

    // Progress callback for loading updates
    const onProgress = ({ loaded, total, percent, phase }) => {
      if (total === -1) {
        loadingOverlay.setIndeterminate(getStatusMessage(phase));
      } else {
        loadingOverlay.setProgress(percent / 100, getStatusMessage(phase));
      }
    };

    if (isFirstLaunch) {
      // For first launch, always load the default paper
      const url = OnboardingWalkthrough.getDefaultPaperUrl();
      await pdfmodel.load(url, onProgress);
      loadingOverlay.setProgress(0.95, "Initializing viewer...");

      const wm = new SplitWindowManager(el.wd, pdfmodel);
      await wm.initialize();
      const fileMenu = new FileMenu(wm);

      document.title = "Welcome to Hover - Tutorial";
      await loadingOverlay.hide();

      // Start onboarding after a short delay
      setTimeout(async () => {
        const onboarding = new OnboardingWalkthrough(wm, fileMenu);
        await onboarding.start();
      }, 500);

      return;
    }

    // Check for locally uploaded PDF first (from sessionStorage)
    if (PDFDocumentModel.hasLocalPdf()) {
      const localPdf = PDFDocumentModel.getLocalPdf();
      if (localPdf) {
        loadingOverlay.setProgress(0.1, "Loading local file...");
        await pdfmodel.load(localPdf.data, onProgress);
        loadingOverlay.setProgress(0.9, "Initializing viewer...");

        const wm = new SplitWindowManager(el.wd, pdfmodel);
        await wm.initialize();
        const fileMenu = new FileMenu(wm);

        const detectedTitle = await pdfmodel.getDocumentTitle();
        const fileName = localPdf.name.replace(/\.pdf$/i, "");
        document.title = (detectedTitle || fileName) + " - Hover PDF";

        PDFDocumentModel.clearLocalPdf();
        await loadingOverlay.hide();
        return;
      }
    }

    // Check for local PDF from background script (from popup uploads)
    const backgroundPdf = await getLocalPdfFromBackground();
    if (backgroundPdf) {
      loadingOverlay.setProgress(0.1, "Loading local file...");
      await pdfmodel.load(backgroundPdf.data, onProgress);
      loadingOverlay.setProgress(0.9, "Initializing viewer...");

      const wm = new SplitWindowManager(el.wd, pdfmodel);
      await wm.initialize();
      const fileMenu = new FileMenu(wm);

      const detectedTitle = await pdfmodel.getDocumentTitle();
      const fileName = backgroundPdf.name.replace(/\.pdf$/i, "");
      document.title = (detectedTitle || fileName) + " - Hover PDF";

      await loadingOverlay.hide();
      return;
    }

    // Fall back to URL-based loading
    const url = getPdfUrl();
    await pdfmodel.load(url, onProgress);
    loadingOverlay.setProgress(0.95, "Initializing viewer...");

    const wm = new SplitWindowManager(el.wd, pdfmodel);
    await wm.initialize();
    const fileMenu = new FileMenu(wm);

    const documentTitle = await pdfmodel.getDocumentTitle();
    if (documentTitle) {
      document.title = documentTitle + " - Hover PDF";
    }

    await loadingOverlay.hide();
  } catch (error) {
    console.error("Error loading PDF:", error);
    PDFDocumentModel.clearLocalPdf();
    loadingOverlay.destroy();
    el.wd.innerHTML = `
      <div style="color: red; text-align: center; padding: 50px;">
        <h2>Failed to load PDF</h2>
        <p>${error.message}</p>
        <p style="font-size: 12px; color: #666; margin-top: 20px;">
          If this is a CORS error, try using the extension popup to upload the file directly.
        </p>
      </div>
    `;
  }
}

function loadWallPaper() {
  const wallPaperPath = "assets/wallpapers/Texture_Carpet.jpg";
  document.body.style.background = `url(${wallPaperPath})`;
  document.body.style.backgroundSize = "cover";
}

async function main() {
  const isFirstLaunch = await OnboardingWalkthrough.isFirstLaunch();

  if (isFirstLaunch) {
    const intendedUrl = getIntendedPdfUrl();
    if (intendedUrl) {
      OnboardingWalkthrough.saveIntendedUrl(intendedUrl);
    }
    PDFDocumentModel.clearLocalPdf();
  }

  // loadWallPaper();
  await loadPdf(isFirstLaunch);
}

main();
