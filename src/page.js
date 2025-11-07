import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export class PageView {
  constructor(pdfDoc, pageNumber, wrapper, allNamedDests) {
    this.pdfDoc = pdfDoc;
    this.pageNumber = pageNumber;
    this.allNamedDests = allNamedDests;
    this.wrapper = wrapper;

    this.canvas = wrapper.querySelector("canvas");
    this.annotationLayer = this.#initLayer("annotation");
    this.textLayer = this.#initLayer("text");

    this.page = null;
    this.textContent = null;
    this.annotations = null;
    this.renderTask = null;
    this.scale = 1;
  }

  async #ensurePageLoaded() {
    if (!this.page) this.page = await this.pdfDoc.getPage(this.pageNumber);
    return this.page;
  }

  async render(scale) {
    this.cancel();
    this.scale = scale;

    const page = await this.#ensurePageLoaded();
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });

    const transform =
      outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

    if (!this.textContent) {
      [this.textContent, this.annotations] = await Promise.all([
        page.getTextContent(),
        page.getAnnotations({ intent: "display" }),
      ]);
    }

    const renderContext = {
      canvasContext: this.canvas.getContext("2d"),
      transform: transform,
      viewport: viewport,
    };

    this.renderTask = page.render(renderContext);

    try {
      await this.renderTask.promise;
      this.#renderAnnotations(page, viewport);

      this.textLayer.style.setProperty("--total-scale-factor", `${scale}`);
      const textLayerInstance = new pdfjsLib.TextLayer({
        textContentSource: this.textContent,
        container: this.textLayer,
        viewport: viewport,
      });
      await textLayerInstance.render();
      this.textLayer.style.width = `${viewport.width}px`;
      this.textLayer.style.height = `${viewport.height}px`;

      this.canvas.dataset.rendered = "true";
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.error("Render error:", err);
      }
    } finally {
      this.renderTask = null;
    }
  }

  cancel() {
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
  }

  async resize(scale) {
    this.scale = scale;

    const page = await this.#ensurePageLoaded();
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });
    const highResViewport = page.getViewport({
      scale: scale * outputScale,
    });
    this.canvas.width = highResViewport.width;
    this.canvas.height = highResViewport.height;
    this.canvas.style.width = `${viewport.width}px`;
    this.canvas.style.height = `${viewport.height}px`;

    this.annotationLayer.style.width = `${viewport.width}px`;
    this.annotationLayer.style.height = `${viewport.height}px`;
  }

  async renderIfNeed() {
    if (this.canvas.dataset.rendered === "true") return;
    await this.render(this.scale);
  }

  #initLayer(layerType) {
    this.wrapper.style.position = "relative";
    let layer = this.wrapper.querySelector(`.${layerType}Layer`);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = `${layerType}Layer`;
      layer.style.position = "absolute";
      layer.style.top = "0";
      layer.style.left = "0";
      layer.style.right = "0";
      layer.style.bottom = "0";
      // layer.style.pointerEvents = "none";
      this.wrapper.style.position = "relative";
      this.wrapper.appendChild(layer);
    }
    layer.innerHTML = "";
    return layer;
  }

  #renderAnnotations(page, viewport) {
    this.annotationLayer.innerHTML = "";
    for (const a of this.annotations) {
      if (a.subtype != "Link") continue;

      const rect = pdfjsLib.Util.normalizeRect(a.rect);
      const viewportForRects = page.getViewport({
        scale: this.scale,
        dontFlip: true,
      });
      const [x1, y1, x2, y2] =
        viewportForRects.convertToViewportRectangle(rect);
      const left = Math.min(x1, x2);
      const bottom = Math.min(y1, y2);
      const width = Math.abs(x1 - x2);
      const height = Math.abs(y1 - y2);
      const top = viewport.height - bottom - height;

      const anchor = document.createElement("a");
      anchor.style.position = "absolute";
      anchor.style.left = `${left}px`;
      anchor.style.top = `${top}px`;
      anchor.style.width = `${width}px`;
      anchor.style.height = `${height}px`;
      anchor.style.pointerEvents = "auto";
      anchor.style.backgroundColor = "transparent";
      anchor.setAttribute("aria-label", "PDF link");

      if (a.url) {
        anchor.href = a.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (a.dest) {
        anchor.href = "javascript:void(0)";
        anchor.addEventListener("click", async (e) => {
          e.preventDefault();
          const result = await this.#resolveDestToPosition(a.dest);
          if (!result) return;

          const { pageIndex, left, top } = result;
          const targetCanvas = document.querySelector(
            `[data-page-number="${pageIndex + 1}"]`,
          );
          await scrollToPoint(
            this.wrapper.parentElement,
            targetCanvas,
            this.pdfDoc,
            this.scale,
            pageIndex,
            left,
            top,
          );
        });
      } else {
        continue;
      }
      this.annotationLayer.appendChild(anchor);
    }
  }

  async #resolveDestToPosition(dest) {
    const explicitDest = this.allNamedDests[dest];
    if (Array.isArray(explicitDest)) {
      const [ref, kind, left, top, zoom] = explicitDest;
      const pageIndex = await this.pdfDoc.getPageIndex(ref);

      return { pageIndex, left: left ?? 0, top: top ?? 0, zoom };
    }
    return null;
  }
}

async function scrollToPoint(
  viewerEl,
  canvas,
  pdfDoc,
  scale,
  pageIndex,
  left,
  top,
) {
  if (!canvas) return;

  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const [, y] = viewport.convertToViewportPoint(left, top);
  const wrapper = canvas.parentElement;

  //have to manually set the offset to 35 somehow otherwise there's a scaled offset
  const targetTop = wrapper.offsetTop + Math.max(0, y - 35);
  viewerEl.scrollTo({ top: targetTop, behavior: "instant" });
}
