import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

import {PDFViewer} from "./viewer.js";

export class PDFWindow {
  constructor(windowEl) {
    this.windowEl = windowEl;
    this.viewers = new Map();
    this.scale = 1;
    this.activeViewer = null;
  }
}

