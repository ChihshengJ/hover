/** Save a Copy › This Computer: download the PDF, with or without annotations. */

import { createCopyOptions, downloadFile } from "./copy_options.js";

import type { ShareContext, ShareTab } from "./share_modal.js";

export function createLocalTab(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");

  const options = createCopyOptions(ctx);
  el.appendChild(options.el);

  const footer = document.createElement("div");
  footer.className = "share-footer";
  footer.innerHTML = `<button class="share-btn share-btn-primary share-download">Download</button>`;
  el.appendChild(footer);

  const button = footer.querySelector(".share-download") as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const file = await options.file();
    button.disabled = false;
    if (!file) return;
    downloadFile(file);
    ctx.close();
  });

  return {
    el,
    onShow: () => {
      options.sync();
      // Enter saves, so ⌘S then Enter is the whole round trip.
      button.focus();
    },
  };
}
