import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs";
import * as pdfjsViewer from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf_viewer.mjs";

import "./style.css";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.mjs";

const url = "https://arxiv.org/pdf/2501.19393"

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
let scale = 1.5;

const renderTasks = new Map();

let allNamedDests = {};

pdfjsLib.getDocument(url).promise.then(async (pdf) => {
  pdfDoc = pdf;
  allNamedDests = await pdfDoc.getDestinations();
  el.pageCount.textContent = pdf.numPages;
  createCanvasPlaceholders(pdf.numPages);
  setupLazyRender();
});

// lazy render
function createCanvasPlaceholders(numPages) {
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
    el.viewer.appendChild(wrapper);

    pageCanvases.push(canvas);
  }
}

function setupLazyRender() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const canvas = entry.target;
          const pageNum = parseInt(canvas.dataset.pageNumber);
          if (!canvas.dataset.rendered) {
            renderPage(pageNum, canvas);
            canvas.dataset.rendered = "true";
          }
        }
      });
    },
    {
      root: el.viewer,
      rootMargin: "500px 0px",
      threshold: 0.1,
    },
  );

  pageCanvases.forEach((canvas) => observer.observe(canvas));
}

async function resolveDestToPosition(pdfDoc, dest, allNamedDests) {
  const explicitDest = allNamedDests[dest];
  if (Array.isArray(explicitDest)) {

    const [ref, kind, left, top, zoom] = explicitDest;
    const pageIndex = await pdfDoc.getPageIndex(ref);
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const [, y] = viewport.convertToViewportPoint(left || 0, top || 0);

    return { pageIndex, yOffset: y, zoom};
  }
  return null;
}

function ensureannotationLayer(wrapper) {
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

function renderPage(num, canvas) {
  const prevTask = renderTasks.get(canvas);
  if (prevTask) {
    prevTask.cancel();
  }

  pdfDoc.getPage(num).then((page) => {
    const viewport = page.getViewport({ scale });
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const context = canvas.getContext("2d");

    const renderContext = { canvasContext: context, viewport };
    const task = page.render(renderContext);

    renderTasks.set(canvas, task);

    task.promise
      .then(async () => {
        const wrapper = canvas.parentElement;
        const layer = ensureannotationLayer(wrapper);
        layer.style.width = `${viewport.width}px`;
        layer.style.height = `${viewport.height}px`;
        const annotations = await page.getAnnotations({ intent: "display" });

        const viewportForLayer = viewport.clone({ dontFlip: true });
        
        for (const a of annotations) {
          if (a.subtype != "Link") continue;

          const rect = pdfjsLib.Util.normalizeRect(a.rect);
          const [x1, y1, x2, y2] = viewportForLayer.convertToViewportRectangle(rect);
          const left = Math.min(x1, x2);
          const bottom = Math.min(y1, y2);
          const width = Math.abs(x1-x2);
          const height = Math.abs(y1-y2);
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
                const result = await resolveDestToPosition(pdfDoc, a.dest, allNamedDests);
                console.log(result);
                if (!result) return;
                
                const { pageIndex, yOffset } = result;
                const targetCanvas = pageCanvases[pageIndex];
                if (!targetCanvas) return;

                const wrapper = targetCanvas.parentElement;
                wrapper.scrollIntoView({ behavior: "instant", block: "start"});

                const offsetWithinPage = (yOffset - 20) * scale;
                const containerTop = el.viewer.scrollTop;
                const targetTop = wrapper.offsetTop + offsetWithinPage;
                console.log(`offsetwithinpage: ${offsetWithinPage}\containerTop: ${containerTop}\targetTop: ${targetTop}`);
                el.viewer.scrollTo({ top: targetTop, behavior: "smooth"});

                targetCanvas.style.boxShadow = "0 0 20px 5px rgba(0,150,255,0.4)";
                setTimeout(() => (targetCanvas.style.boxShadow = ""), 800);
              } catch (err) {
                console.error("Failed to navigate to destination:", err)
              }
            });
          } else {
            continue;
          }
          layer.appendChild(anchor);
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

function getCurrentPageNum() {
  return parseInt(el.pageNum.textContent);
}

function rerenderAll() {
  pageCanvases.forEach((canvas) => {
    delete canvas.dataset.rendered;
    renderPage(parseInt(canvas.dataset.pageNumber), canvas);
  });
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
  rerenderAll();
}

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
  if (e.ctrlKey && (e.key === "=" || e.key === "+")) zoom(0.25);
  else if (e.ctrlKey && (e.key === "-" || e.key === "_")) zoom(-0.25);
  else if (["ArrowRight", "ArrowDown", "j", "h"].includes(e.key))
    scrollToRelative(1);
  else if (["ArrowLeft", "ArrowUp", "k", "l"].includes(e.key))
    scrollToRelative(-1);
});
