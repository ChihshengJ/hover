import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocumentModel } from "./doc.js";
import { SplitWindowManager } from "./window_manager.js";

import "../styles/viewer.css";
import "../styles/text_layer.css";
import "../styles/floating_toolbar.css";
import "../styles/citation_popup.css";
import "../styles/navigation_tree.css";
import "../styles/nightmode.css";
import "../styles/annotations.css";
import "../styles/progress_bar.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const el = {
  wd: document.getElementById("window-container"),
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
    const pdfmodel = new PDFDocumentModel();
    const wm = new SplitWindowManager(el.wd, pdfmodel);
    const pdfDoc = await pdfmodel.load(url);

    wm.initialize();

    const metadata = await pdfDoc.getMetadata();
    if (metadata.info.Title) {
      document.title = metadata.info.Title + " - Hover PDF";
    }
  } catch (error) {
    console.error("Error loading PDF:", error);
    el.wd.innerHTML = `
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
