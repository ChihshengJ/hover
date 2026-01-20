import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocumentModel } from "./doc.js";
import { SplitWindowManager } from "./window_manager.js";
import { FileMenu } from "./controls/file_menu.js";

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

/**
 * Load PDF from either local upload (sessionStorage) or URL
 */
async function loadPdf() {
  try {
    const pdfmodel = new PDFDocumentModel();
    const wm = new SplitWindowManager(el.wd, pdfmodel);

    // Check for locally uploaded PDF first
    if (PDFDocumentModel.hasLocalPdf()) {
      const localPdf = PDFDocumentModel.getLocalPdf();
      if (localPdf) {
        await pdfmodel.load(localPdf.data);
        await wm.initialize();

        const fileMenu = new FileMenu(wm);

        // Set title from filename
        const fileName = localPdf.name.replace(/\.pdf$/i, "");
        document.title = fileName + " - Hover PDF";

        // Clear sessionStorage after successful load
        PDFDocumentModel.clearLocalPdf();
        return;
      }
    }

    // Fall back to URL-based loading
    const url = getPdfUrl();
    const pdfDoc = await pdfmodel.load(url);

    await wm.initialize();

    const fileMenu = new FileMenu(wm);

    const metadata = await pdfDoc.getMetadata();
    if (metadata.info.Title) {
      document.title = metadata.info.Title + " - Hover PDF";
    }
  } catch (error) {
    console.error("Error loading PDF:", error);
    // Clear any stored local PDF on error to prevent reload loops
    PDFDocumentModel.clearLocalPdf();
    el.wd.innerHTML = `
      <div style="color: red; text-align: center; padding: 50px;">
        <h2>Failed to load PDF</h2>
        <p>${error.message}</p>
      </div>
    `;
  }
}

loadPdf();
