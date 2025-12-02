import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./style.css";
import { PDFViewer } from "./viewer.js";
import { ViewerControls } from "./controls/viewer_controls.js";
import { FloatingToolbar } from "./controls/floating_toolbar.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const el = {
  wd: document.getElementById("window-container"),
  viewer: document.getElementById("viewer-container"),
  pageNum: document.getElementById("current-page"),
};

function getPdfUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlParam = urlParams.get("file");
  if (urlParam) {
    return urlParam;
  }

  if (window.location.hash) {
    const hashUrl = window.location.hash.substring(1);
    if (hashUrl) return hashUrl;
  }

  // Development fallback
  return "https://arxiv.org/pdf/2501.19393";
}

async function loadPdf(url) {
  try {
    const pdfDoc = await pdfjsLib.getDocument(url).promise;
    const allNamedDests = await pdfDoc.getDestinations();

    const viewer = new PDFViewer(el.viewer);
    await viewer.loadDocument(pdfDoc, allNamedDests);
    // el.pageCount.textContent = pdfDoc.numPages;

    const controls = new ViewerControls(viewer, el);
    const floatingToolbar = new FloatingToolbar(viewer, el.viewer);
    floatingToolbar.updatePageNumber();

    const metadata = await pdfDoc.getMetadata();
    if (metadata.info.Title) {
      document.title = metadata.info.Title + " - Hover PDF";
    }
  } catch (error) {
    console.error("Error loading PDF:", error);
    el.viewer.innerHTML = `
      <div style="color: red; text-align: center; padding: 50px;">
        <h2>Failed to load PDF</h2>
        <p>${error.message}</p>
      </div>
    `;
  }
}

const overlay = document.createElement("div");
overlay.id = "night-mode-overlay";
document.body.appendChild(overlay);

const pdfUrl = getPdfUrl();
loadPdf(pdfUrl);
