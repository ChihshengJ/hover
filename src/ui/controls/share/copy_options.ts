/**
 * The "Include annotations" choice that every exported copy offers, over a
 * preview of the file it will produce. The choice lives on the context, so
 * every panel showing one of these agrees.
 */

import { createFileCard, formatBytes } from "./annotated_pages.js";
import { Config } from "../../settings/config.js";

import type { ShareContext } from "./share_modal.js";

export interface CopyOptions {
  el: HTMLElement;
  /** Pick up the shared choice and preview it; call from the tab's onShow. */
  sync(): void;
  /** The file the choice describes, or null when it couldn't be exported. */
  file(): Promise<File | null>;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Hand a file to the browser's downloads. */
export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createCopyOptions(ctx: ShareContext): CopyOptions {
  const el = document.createElement("div");
  el.className = "share-copy-options";
  el.innerHTML = `
    <div class="settings-toggle-row share-annotations-row">
      <div class="settings-toggle-info">
        <span class="settings-toggle-label">Include annotations</span>
        <span class="settings-toggle-description"></span>
      </div>
      <label class="settings-toggle-switch">
        <input type="checkbox" class="share-annotations-toggle">
        <span class="settings-toggle-slider"></span>
        <span class="settings-toggle-knob"></span>
      </label>
    </div>
    <div class="share-compose share-file-card"></div>
  `;

  const row = el.querySelector(".share-annotations-row") as HTMLDivElement;
  const toggle = el.querySelector(
    ".share-annotations-toggle",
  ) as HTMLInputElement;
  const note = el.querySelector(
    ".settings-toggle-description",
  ) as HTMLSpanElement;
  const card = createFileCard(ctx.doc, ctx.fileName);
  el.querySelector(".share-file-card")!.appendChild(card.el);

  const annotations = ctx.doc.getAllAnnotations();
  const pageCount = new Set(
    annotations.flatMap((a) => a.pageRanges.map((r) => r.pageNumber)),
  ).size;
  // With nothing to leave out, the copy is the document as it stands.
  const annotated = () => annotations.length === 0 || ctx.includeAnnotations;

  /** Bumped per render, so a slow export can't overwrite a newer choice's size. */
  let request = 0;

  const render = () => {
    // Nothing to leave out, so nothing to choose: just the file.
    row.hidden = annotations.length === 0;
    toggle.checked = annotated();
    note.textContent = annotated()
      ? `${plural(annotations.length, "annotation")} on ${plural(pageCount, "page")}`
      : "The original file, as it was opened";
    card.showPages(annotated());

    const mine = ++request;
    card.setSize("Preparing…");
    ctx.getFile(annotated()).then(
      (file) => mine === request && card.setSize(formatBytes(file.size)),
      () => mine === request && card.setSize(""),
    );
  };

  toggle.addEventListener("change", () => {
    ctx.includeAnnotations = toggle.checked;
    Config.set("export_include_annotations", toggle.checked);
    ctx.relayout(render);
  });

  return {
    el,
    sync: render,
    file: async () => {
      try {
        return await ctx.getFile(annotated());
      } catch (error) {
        console.error("Error exporting PDF:", error);
        ctx.showToast("Couldn't export the PDF");
        return null;
      }
    },
  };
}
