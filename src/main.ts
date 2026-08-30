import { PDFDocumentModel } from "./model/doc.js";
import { SplitWindowManager } from "./viewer/window_manager.js";
import { FileMenu } from "./ui/controls/file_menu.js";
import { EmptyState } from "./ui/controls/empty_state.js";
import { LoadingOverlay } from "./ui/controls/loading_overlay.js";
import { OnboardingWalkthrough } from "./ui/settings/onboarding.js";
import { Config } from "./ui/settings/config.js";
import { TrailStore } from "./ui/trail/trail_store.js";
import { TrailLinker } from "./ui/trail/trail_linker.js";
import { TrailOverlay } from "./ui/trail/trail_overlay.js";
import {
  fetchPdfFromUrl,
  getIntendedUrl,
  isExtensionContext,
  resolvePdfSource,
} from "./platform/ingest.js";

import type { LoadProgress } from "./platform/ingest.js";

import "../styles/index.css";

const el = {
  wd: document.getElementById("window-container"),
  pageNum: document.getElementById("current-page"),
};

/**
 * Loading phases, as the user reads them. Keys are the `phase` strings the
 * model and the ingest layer report.
 */
const STATUS_MESSAGES = {
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

function getStatusMessage(phase: string): string {
  return STATUS_MESSAGES[phase as keyof typeof STATUS_MESSAGES] || "Loading...";
}

/**
 * The content script paints its own overlay over the original PDF tab so the
 * hand-off doesn't flash white. Remove it — and the style tag it injected —
 * once we have our own.
 */
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

/**
 * Build the viewer around a loaded model: window manager, file menu, title.
 */
async function constructViewer(
  pdfmodel: PDFDocumentModel,
  pdfName: string,
): Promise<{ wm: SplitWindowManager; fileMenu: FileMenu }> {
  const wm = new SplitWindowManager(el.wd, pdfmodel);
  await wm.initialize();
  const fileMenu = new FileMenu(wm);
  document.title = pdfName.replace(/\.pdf$/i, "");
  return { wm, fileMenu };
}

/**
 * The trail system layers on top of an already-rendered document, so every
 * failure in here is a warning rather than a load error.
 */
async function initializeTrail(
  pdfmodel: PDFDocumentModel,
  detectedTitle: string | null,
  originalUrl: string | null,
) {
  try {
    const trailStore = new TrailStore();
    await trailStore.initialize();
    const trailLinker = new TrailLinker(pdfmodel, trailStore, originalUrl);
    trailLinker.initialize();
    await trailLinker.matchOnOpen(detectedTitle);
    new TrailOverlay(trailStore, detectedTitle, originalUrl).initialize();
  } catch (err) {
    console.warn("[Trail] Failed to initialize:", err);
  }
}

/**
 * First launch with a URL-based open: park the URL the user actually wanted,
 * then show the tutorial paper and walk them through it. Onboarding does not
 * start otherwise — there would be nothing to return to afterwards.
 */
async function runOnboarding(
  loadingOverlay: LoadingOverlay,
  onProgress: (p: {
    loaded: number;
    total: number;
    percent: number;
    phase: string;
  }) => void,
  intendedUrl: string,
) {
  OnboardingWalkthrough.saveIntendedUrl(intendedUrl);

  loadingOverlay.setProgress(0.1, "Fetching tutorial document...");
  const tutorialData = await fetchPdfFromUrl(
    OnboardingWalkthrough.getDefaultPaperUrl(),
    onProgress,
  );

  const pdfmodel = new PDFDocumentModel();
  await pdfmodel.load(tutorialData, onProgress);
  loadingOverlay.setProgress(0.95, "Initializing viewer...");

  const { wm, fileMenu } = await constructViewer(pdfmodel, "Tutorial");
  document.title = "Welcome to Hover - Tutorial";
  await loadingOverlay.hide();

  await pdfmodel.buildIndex();

  setTimeout(async () => {
    const onboarding = new OnboardingWalkthrough(wm, fileMenu);
    await onboarding.start();
  }, 500);
}

async function loadPdf(isFirstLaunch = false) {
  adoptContentScriptOverlay();

  const loadingOverlay = new LoadingOverlay();
  loadingOverlay.show();

  const onProgress = ({ total, percent, phase }: LoadProgress) => {
    if (total === -1) {
      loadingOverlay.setIndeterminate(getStatusMessage(phase));
    } else {
      loadingOverlay.setProgress(percent / 100, getStatusMessage(phase));
    }
  };

  const onStatus = (message: string, fraction?: number) => {
    if (fraction === undefined) loadingOverlay.setIndeterminate(message);
    else loadingOverlay.setProgress(fraction, message);
  };

  try {
    const intendedUrl = getIntendedUrl();

    if (isFirstLaunch && intendedUrl) {
      await runOnboarding(loadingOverlay, onProgress, intendedUrl);
      return;
    }
    if (isFirstLaunch) {
      await OnboardingWalkthrough.markCompleted();
    }

    const source = await resolvePdfSource({ onStatus, onProgress });

    if (!source) {
      // Nothing to render. In the extension this is the normal landing when the
      // viewer is opened with nothing queued (e.g. the popup's "Open Local
      // PDF"); show the empty state so the user can pick a file from this
      // persistent tab — the popup can't host the picker on Firefox.
      loadingOverlay.destroy();
      new EmptyState(el.wd);
      return;
    }

    loadingOverlay.setProgress(0.1, "Loading document...");
    const pdfmodel = new PDFDocumentModel();
    await pdfmodel.load(source.data, onProgress);
    loadingOverlay.setProgress(0.95, "Initializing viewer...");

    await constructViewer(pdfmodel, source.name);

    await loadingOverlay.hide();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    // Indexing runs after the first paint. The UI subtrees that depend on its
    // results subscribe to `index-ready` themselves.
    await pdfmodel.buildIndex();

    const detectedTitle = await pdfmodel.getDocumentTitle();
    if (detectedTitle) {
      document.title = detectedTitle;
    }

    await initializeTrail(pdfmodel, detectedTitle, source.url);
  } catch (error) {
    console.error("[Main] Error loading PDF:", error);
    loadingOverlay.destroy();
    el.wd.innerHTML = `
      <div style="color: red; text-align: center; padding: 50px;">
        <h2>Failed to load PDF</h2>
        <p>${error instanceof Error ? error.message : String(error)}</p>
        <p style="font-size: 12px; color: #666; margin-top: 20px;">
          ${
            isExtensionContext()
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
