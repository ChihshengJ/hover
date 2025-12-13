import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export class PDFDocumentModel {
  constructor() {
    this.pdfDoc = null;
    this.allNamedDests = null;
    this.pageDimensions = [];
    this.highlights = new Map();
    this.subscribers = new Set();
  }

  async load(url) {
    this.pdfDoc = await pdfjsLib.getDocument(url).promise;
    this.allNamedDests = await this.pdfDoc.getDestinations();
    await this.#cachePageDimensions();
    return this.pdfDoc;
  }

  async #cachePageDimensions() {
    const numPages = this.pdfDoc.numPages;
    this.pageDimensions = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      this.pageDimensions.push({
        width: viewport.width,
        height: viewport.height,
      });
    }
  }

  get numPages() {
    return this.pdfDoc?.numPages || 0;
  }

  subscribe(pane) {
    this.subscribers.add(pane);
  }

  unsubscribe(pane) {
    this.subscribers.delete(pane);
  }

  addHighlight(pageNum, highlight) {
    if (!this.highlights.has(pageNum)) {
      this.highlights.set(pageNum, []);
    }
    this.highlights.get(pageNum).push({
      id: crypto.randomUUID(),
      ...highlight,
      timestamp: Date.now(),
    });
    this.#notify("highlight-added", { pageNum, highlight });
  }

  #notify(event, data) {
    for (const subscriber of this.subscribers) {
      subscriber.onDocumentChaneg?.(event, data);
    }
  }
}
