import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import "./style.css";
import {
  createCanvasPlaceholders,
  setupLazyRender,
  rerenderAll,
} from "./viewer.js"

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

let pdfDoc = null;
let pageCanvases = [];
let scale = 1;
let lastDevicePixelRatio = window.devicePixelRatio;

const renderTasks = new Map();

let allNamedDests = {};

pdfjsLib.getDocument(url).promise.then(async (pdf) => {
  pdfDoc = pdf;
  allNamedDests = await pdfDoc.getDestinations();
  el.pageCount.textContent = pdf.numPages;
  pageCanvases = createCanvasPlaceholders(pdf.numPages, el.viewer);
  setupLazyRender(el.viewer, pageCanvases, pdfDoc, scale, allNamedDests, renderTasks);
});

function getCurrentPageNum() {
  return parseInt(el.pageNum.textContent);
}

function scrollToRelative(delta) {
  const current = getCurrentPageNum();
  const target = pageCanvases.find(
    (c) => parseInt(c.dataset.pageNumber) === current + delta,
  );
  if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
}

function zoom(delta) {
  scale = Math.min(Math.max(scale + delta, 0.5), 3);
  rerenderAll(renderTasks, pdfDoc, scale, allNamedDests, pageCanvases, el.viewer);
}

window.addEventListener("resize", () => {
  if (window.devicePixelRatio !== lastDevicePixelRatio) {
    lastDevicePixelRatio = window.devicePixelRatio;
    console.log(`DPR resized, now${lastDevicePixelRatio}`);
    rerenderAll(renderTasks, pdfDoc, scale, allNamedDests, pageCanvases, el.viewer);
  }
});

// controls
el.viewer.addEventListener("scroll", () => {
  let currentPage = 1;
  for (const canvas of pageCanvases) {
    const rect = canvas.getBoundingClientRect();
    if (rect.top < window.innerHeight / 2 && rect.bottom > 0) {
      currentPage = parseInt(canvas.dataset.pageNumber);
    }
  }
  document.getElementById("page-num").textContent = currentPage;
});

el.zoomInBtn.addEventListener("click", () => zoom(0.25));
el.zoomOutBtn.addEventListener("click", () => zoom(-0.25));
el.nextBtn.addEventListener("click", () => scrollToRelative(1));
el.prevBtn.addEventListener("click", () => scrollToRelative(-1));

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
  }

  else if (["ArrowDown", "j"].includes(e.key))
    scrollToRelative(1);
  else if (["ArrowUp", "k"].includes(e.key))
    scrollToRelative(-1);
  else if (e.key === "ArrowRight" || e.key === "l")
    document.scrollLeft -= step;
  else if (e.key === "ArrowLeft" || e.key === "h")
    document.scrollleft += step;
});

let tempScale = scale;
const gesture = new GestureDetector(document.getElementById("viewer-container"));
gesture.getEventTarget().addEventListener("pinchupdate", (e) => {
  const ratio = e.detail.startScaleRatio;
  tempScale = Math.max(0.5, Math.min(3, scale * ratio));
});

gesture.getEventTarget().addEventListener("pinchend", () => {
  scale = tempScale;
  rerenderAll(renderTasks, pdfDoc, scale, allNamedDests, pageCanvases, el.viewer);

});

