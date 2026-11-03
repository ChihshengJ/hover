/** Print: the annotations choice, then the browser's print dialog. */

import { createCopyOptions } from "./copy_options.js";

import type { ShareContext, ShareTab } from "./share_modal.js";

/** Print a PDF through a hidden frame, so the browser's PDF viewer lays it out. */
export function printFile(file: File) {
  const url = URL.createObjectURL(file);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "none";
  iframe.src = url;

  iframe.onload = () => {
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();

      setTimeout(() => {
        iframe.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    }, 100);
  };
  document.body.appendChild(iframe);
}

export function createPrintPanel(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");

  const options = createCopyOptions(ctx);
  el.appendChild(options.el);

  const footer = document.createElement("div");
  footer.className = "share-footer";
  footer.innerHTML = `<button class="share-btn share-btn-primary share-print">Print</button>`;
  el.appendChild(footer);

  const button = footer.querySelector(".share-print") as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const file = await options.file();
    button.disabled = false;
    if (!file) return;
    ctx.close();
    printFile(file);
  });

  return {
    el,
    onShow: () => {
      options.sync();
      button.focus();
    },
  };
}
