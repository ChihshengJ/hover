import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./style.css";
import {
  PDFViewer,
  // createCanvasPlaceholders,
  // setupLazyRender,
  // rerenderAll,
} from "./viewer.js";

import { GestureDetector } from "./helpers.js";

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
  el.zoomInBtn.onclick = () => viewer.zoom(+0.2);
  el.zoomOutBtn.onclick = () => viewer.zoom(-0.2);
  el.nextBtn.onclick = () => viewer.scrollToRelative(1);
  el.prevBtn.onclick = () => viewer.scrollToRelative(-1);
});

//keyboard shotcuts
document.addEventListener("keydown", (e) => {
  const isZoomKey =
    (e.metaKey || e.ctrlKey) &&
    (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0");
  const step = 100;

  if (isZoomKey) {
    e.preventDefault();
    if (e.metaKey && (e.key === "=" || e.key === "+")) zoom(0.25);
    else if (e.metaKey && (e.key === "-" || e.key === "_")) zoom(-0.25);
  } else if (["ArrowDown", "j"].includes(e.key)) scrollToRelative(1);
  else if (["ArrowUp", "k"].includes(e.key)) scrollToRelative(-1);
  else if (e.key === "ArrowRight" || e.key === "l") document.scrollLeft -= step;
  else if (e.key === "ArrowLeft" || e.key === "h") document.scrollleft += step;
});
