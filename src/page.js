import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { CitationPopup } from "./controls/link_viewer.js";

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

  async render() {
    this.cancel();

    const page = await this.#ensurePageLoaded();
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: this.scale });

    const transform =
      outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

    if (!this.textContent) {
      [this.textContent, this.annotations] = await Promise.all([
        page.getTextContent(),
        page.getAnnotations({ intent: "display" }),
      ]);
    }

    const renderContext = {
      canvasContext: this.canvas.getContext("2d", { alpha: false }),
      transform: transform,
      viewport: viewport,
    };

    this.renderTask = page.render(renderContext);

    try {
      await this.renderTask.promise;
      this.#renderAnnotations(page, viewport);

      this.textLayer.style.setProperty("--total-scale-factor", `${this.scale}`);
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

    const MAX_RENDER_SCALE = 3.0;
    const renderScale = Math.min(scale, MAX_RENDER_SCALE);

    const renderViewport = page.getViewport({
      scale: renderScale * outputScale,
    });
    const viewport = page.getViewport({ scale: renderScale });

    this.canvas.width = renderViewport.width;
    this.canvas.height = renderViewport.height;

    Object.assign(this.wrapper.style, {
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      transformOrigin: "top left",
      transform: `scale(${scale / renderScale})`,
    });

    Object.assign(this.canvas.style, {
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      transformOrigin: "top left",
      transform: "",
    });

    const layerStyles = {
      left: "0px",
      top: "0px",
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      transformOrigin: "top left",
      transform: "",
    };

    Object.assign(this.annotationLayer.style, layerStyles);
    Object.assign(this.textLayer.style, layerStyles);

    this.scale = renderScale;
  }

  async renderIfNeed() {
    if (this.canvas.dataset.rendered === "true") return;
    await this.render();
  }

  async #findCiteText(left, pageIndex, top) {
    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: this.scale, dontFlip: true });
    const texts = await page.getTextContent();
    const canvas = document.querySelector(
      `[data-page-number="${pageIndex + 1}"]`,
    );
    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    const transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];

    // convert target pdf coordinates to viewport coordinates at current scale
    const [targetX, targetY] = viewport.convertToViewportPoint(
      left + 20,
      top + 2,
    );
    const targetLeft = targetX;
    const targetTop = canvas.offsetTop + Math.max(0, viewport.height - targetY);

    let closestSpan = null;
    let minDistance = 50;
    let startIndex = 0;

    try {
      for (let i = 0; i < texts.items.length; i++) {
        const geom = texts.items[i];
        const tx = pdfjsLib.Util.transform(transform, geom.transform);
        let angle = Math.atan2(tx[1], tx[0]);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const fontAscent = fontHeight * 0.8;
        let l, t;
        if (angle === 0) {
          l = tx[4];
          t = tx[5] - fontAscent;
        } else {
          l = tx[4] + fontAscent * Math.sin(angle);
          t = tx[5] - fontAscent * Math.cos(angle);
        }

        // converting text span pdf coordinates to viewport coordinates
        const [x, y] = viewport.convertToViewportPoint(l, t);
        const spanLeft = x;
        const spanTop = canvas.offsetTop + Math.max(0, y);

        const isClose =
          Math.abs(spanLeft - targetLeft) <= minDistance &&
          Math.abs(spanTop - targetTop) <= minDistance;

        if (isClose) {
          closestSpan = {
            text: geom.str,
            left: spanLeft,
            top: spanTop,
            width: geom.width,
            height: geom.height,
            hasEOL: geom.hasEOL,
          };
          startIndex = i;
          minDistance = Math.max(
            Math.abs(spanLeft - targetLeft),
            Math.abs(spanTop - targetTop),
          );
        }
      }

      if (closestSpan) {
        let reference = [];
        for (let i = startIndex; i < texts.items.length; i++) {
          const span = texts.items[i];
          reference.push(span.str);
          if (span.str === ".") {
            break;
          }
        }
        return reference.join("");
      }
      return null;
    } catch (err) {
      console.error("Failed to find closest span", err);
      return null;
    }
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
      this.wrapper.style.position = "relative";
      this.wrapper.appendChild(layer);
    }
    layer.innerHTML = "";
    return layer;
  }

  #renderAnnotations(page, viewport) {
    this.annotationLayer.innerHTML = "";
    if (!this.citationPopup) {
      this.citationPopup = new CitationPopup();
    }

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
      anchor.setAttribute("data-dest", "");

      if (a.url) {
        anchor.href = a.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (a.dest) {
        anchor.href = "javascript:void(0)";
        let hoverTimer = null;

        anchor.addEventListener("mouseenter", async (e) => {
          if (hoverTimer) clearTimeout(hoverTimer);
          hoverTimer = setTimeout(async () => {
            const result = await this.#resolveDestToPosition(a.dest);
            if (!result) return;
            anchor.dataset.dest = `${result.left},${result.pageIndex},${result.top}`;

            await this.citationPopup.show(
              anchor,
              this.#findCiteText.bind(this),
              result.left,
              result.pageIndex,
              result.top,
            );
          }, 200);
        });

        anchor.addEventListener("mouseleave", (e) => {
          if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
          }

          this.citationPopup.scheduleClose();
        });

        anchor.addEventListener("click", async (e) => {
          e.preventDefault();
          const [left, page, top] = anchor.dataset.dest
            .split(",")
            .map((item) => parseFloat(item));
          const pageIndex = Math.floor(page);
          const targetCanvas = document.querySelector(
            `[data-page-number="${pageIndex + 1}"]`,
          );
          await scrollToPoint(
            this.wrapper.parentElement.parentElement,
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
