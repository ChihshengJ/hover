import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./style.css";
import { PDFViewer } from "./viewer.js";

import { ViewerControls } from "./controls/viewer_controls.js";
import { FloatingToolbar } from "./controls/floating_toolbar.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const url = "https://arxiv.org/pdf/2501.19393";

//Elements
const el = {
  viewer: document.getElementById("viewer-container"),
  pageNum: document.getElementById("page-num"),
  pageCount: document.getElementById("page-count"),
  prevBtn: document.getElementById("prev"),
  nextBtn: document.getElementById("next"),
  zoomInBtn: document.getElementById("zoom-in"),
  zoomOutBtn: document.getElementById("zoom-out"),
};

pdfjsLib.getDocument(url).promise.then(async (pdfDoc) => {
  const allNamedDests = await pdfDoc.getDestinations();
  const viewer = new PDFViewer(el.viewer);
  await viewer.loadDocument(pdfDoc, allNamedDests);
  el.pageCount.textContent = pdfDoc.numPages;
  const controls = new ViewerControls(viewer, el);
  const floatingToolbar = new FloatingToolbar(viewer, el.viewer);
  floatingToolbar.updatePageNumber();
});
