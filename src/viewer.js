import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export function createCanvasPlaceholders(numPages, viewerEl) {
  const canvases = [];
  for (let i = 1; i <= numPages; i++) {
    const wrapper = document.createElement("div");
    wrapper.className = "page-wrapper";
    wrapper.style.margin = "10px 0";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";

    const label = document.createElement("div");
    label.textContent = `Page ${i}`;
    label.style.color = "#888";
    label.style.fontSize = "0.8rem";

    const canvas = document.createElement("canvas");
    canvas.dataset.pageNumber = i;

    wrapper.appendChild(canvas);
    wrapper.appendChild(label);
    viewerEl.appendChild(wrapper);

    canvases.push(canvas);
  }
  return canvases;
}

function ensureAnnotationLayer(wrapper) {
  wrapper.style.position = "relative";
  let layer = wrapper.querySelector(".annotationLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "annotationLayer";
    layer.style.position = "absolute";
    layer.style.top = "0";
    layer.style.left = "0";
    layer.style.right = "0";
    layer.style.bottom = "0";
    layer.style.pointerEvents = "none";
    wrapper.style.position = "relative";
    wrapper.appendChild(layer);
  }
  layer.innerHTML = "";
  return layer;
}

function ensureTextLayer(wrapper) {
  let layer = wrapper.querySelector(".textLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "textLayer";
    layer.style.position = "absolute";
    // layer.style.top = "0";
    // layer.style.left = "0";
    layer.style.right = "0";
    layer.style.bottom = "0";
    wrapper.style.position = "relative";
    wrapper.appendChild(layer);
  }
  layer.innerHTML = "";
  return layer;
}

async function resolveDestToPosition(pdfDoc, dest, allNamedDests) {
  const explicitDest = allNamedDests[dest];
  if (Array.isArray(explicitDest)) {
    const [ref, kind, left, top, zoom] = explicitDest;
    const pageIndex = await pdfDoc.getPageIndex(ref);

    return { pageIndex, left: left ?? 0, top: top ?? 0, zoom };
  }
  return null;
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
  viewerEl.scrollTo({ top: targetTop, behavior: "smooth" });
}

function renderPage(
  canvas,
  renderTasks,
  pdfDoc,
  scale,
  allNamedDests,
  pageCanvases,
  viewerEl,
) {
  const prevTask = renderTasks.get(canvas);
  if (prevTask) {
    prevTask.cancel();
  }

  const num = parseInt(canvas.dataset.pageNumber);
  pdfDoc.getPage(num).then((page) => {
    const viewport = page.getViewport({ scale });
    const outputScale = window.devicePixelRatio || 1;
    const highResViewport = page.getViewport({ scale: scale * outputScale });
    const context = canvas.getContext("2d");
    canvas.width = highResViewport.width;
    canvas.height = highResViewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const transform =
      outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

    const renderContext = {
      canvasContext: context,
      transform: transform,
      viewport: viewport,
    };
    const task = page.render(renderContext);

    renderTasks.set(canvas, task);

    task.promise
      .then(async () => {
        const viewportForRects = page.getViewport({ scale, dontFlip: true });
        const wrapper = canvas.parentElement;
        const annotationLayer = ensureAnnotationLayer(wrapper);
        annotationLayer.style.width = `${viewport.width}px`;
        annotationLayer.style.height = `${viewport.height}px`;
        const annotations = await page.getAnnotations({ intent: "display" });

        const textContent = await page.getTextContent();
        const textLayer = ensureTextLayer(wrapper);
        textLayer.style.setProperty("--total-scale-factor", `${scale}`);
        const textLayerInstance = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport: viewport,
        });
        await textLayerInstance.render();
        textLayer.style.width = `${viewport.width}px`;
        textLayer.style.height = `${viewport.height}px`;

        //customed annotation handling
        for (const a of annotations) {
          if (a.subtype != "Link") continue;

          const rect = pdfjsLib.Util.normalizeRect(a.rect);
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
              try {
                const result = await resolveDestToPosition(
                  pdfDoc,
                  a.dest,
                  allNamedDests,
                );
                if (!result) return;

                const { pageIndex, left, top } = result;
                const targetCanvas = pageCanvases[pageIndex];
                await scrollToPoint(
                  viewerEl,
                  targetCanvas,
                  pdfDoc,
                  scale,
                  pageIndex,
                  left,
                  top,
                );
              } catch (err) {
                console.error("Failed to navigate to destination:", err);
              }
            });
          } else {
            continue;
          }
          annotationLayer.appendChild(anchor);
        }
      })
      .catch((err) => {
        if (err?.name !== "RenderingCancelledException") {
          console.error("Render error:", err);
        }
      })
      .finally(() => {
        renderTasks.delete(canvas);
        canvas.dataset.rendered = "true";
      });
  });
}

export function setupLazyRender(
  viewerEl,
  pageCanvases,
  pdfDoc,
  scale,
  allNamedDests,
  renderTasks,
) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const canvas = entry.target;
          if (!canvas.dataset.rendered) {
            renderPage(
              canvas,
              renderTasks,
              pdfDoc,
              scale,
              allNamedDests,
              pageCanvases,
              viewerEl,
            );
            canvas.dataset.rendered = "true";
          }
        }
      });
    },
    {
      root: viewerEl,
      rootMargin: "500px 0px",
      threshold: 0.1,
    },
  );
  pageCanvases.forEach((canvas) => observer.observe(canvas));
}

export function rerenderAll(
  renderTasks,
  pdfDoc,
  scale,
  allNamedDests,
  pageCanvases,
  viewerEl,
) {
  pageCanvases.forEach((canvas) => {
    delete canvas.dataset.rendered;
    renderPage(
      canvas,
      renderTasks,
      pdfDoc,
      scale,
      allNamedDests,
      pageCanvases,
      viewerEl,
    );
  });
}
