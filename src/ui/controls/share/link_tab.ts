/** Share › Link: the original PDF's address, editable and copyable. */

import type { ShareContext, ShareTab } from "./share_modal.js";

const COPY_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>`;

const CHECK_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="5 12 10 17 19 7"/>
  </svg>`;

export function createLinkTab(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");
  el.innerHTML = `
    <span class="share-label">Link to the original PDF</span>
    <div class="share-link-field">
      <input class="share-link-input" type="url" spellcheck="false" aria-label="Link">
      <button class="share-link-copy">${COPY_ICON}<span>Copy</span></button>
    </div>
    <p class="share-note">Anyone with the link opens the paper itself, not your annotations.</p>
  `;

  const input = el.querySelector(".share-link-input") as HTMLInputElement;
  const copyBtn = el.querySelector(".share-link-copy") as HTMLButtonElement;
  const note = el.querySelector(".share-note") as HTMLParagraphElement;

  input.value = ctx.link;
  if (!ctx.originalUrl) {
    input.placeholder = "No web link";
    note.textContent =
      "This PDF was opened from your computer, so there's no link to share. Email it as a file instead.";
  }

  const syncCopy = () => (copyBtn.disabled = !input.value.trim());
  syncCopy();

  let resetTimer = 0;
  const copy = async () => {
    const link = input.value.trim();
    if (!link) return;
    clearTimeout(resetTimer);
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
      copyBtn.classList.add("copied");
    } catch (error) {
      console.error("Failed to copy link:", error);
      copyBtn.innerHTML = `${COPY_ICON}<span>Failed</span>`;
    }
    resetTimer = window.setTimeout(() => {
      copyBtn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
      copyBtn.classList.remove("copied");
    }, 1500);
  };

  input.addEventListener("input", () => {
    ctx.link = input.value.trim();
    syncCopy();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") copy();
  });
  copyBtn.addEventListener("click", copy);

  return {
    el,
    onShow: () => {
      if (!input.value) return;
      input.focus();
      input.select();
    },
  };
}
