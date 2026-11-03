/**
 * The "Include annotations" choice that every exported copy offers, and the
 * preview of the file it will produce. The choice lives on the context, so
 * every panel showing one of these agrees.
 *
 * The two parts are handed back separately: the toggle is a row for the
 * panel's settings group, the card sits below that group.
 */

import { createFileCard, formatBytes } from "./annotated_pages.js";
import { Config } from "../../settings/config.js";

import type { ShareContext } from "./share_modal.js";

export interface CopyOptions {
  /** A `.share-group-row`, hidden when there are no annotations to leave out. */
  row: HTMLElement;
  /** The file on its sheet of paper, annotated pages included. */
  card: HTMLElement;
  /** False when the document has no annotations, so there's nothing to choose. */
  hasChoice: boolean;
  /** Pick up the shared choice and preview it; call from the tab's onShow. */
  sync(): void;
  /** The file the choice describes, or null when it couldn't be exported. */
  file(): Promise<File | null>;
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

/**
 * A settings group holding just the annotations toggle, then the card: the
 * whole body of a panel whose only option is that one.
 */
export function copyOptionsBody(options: CopyOptions): HTMLElement[] {
  const group = document.createElement("div");
  group.className = "share-group";
  group.hidden = !options.hasChoice;
  group.appendChild(options.row);
  return [group, options.card];
}

export function createCopyOptions(ctx: ShareContext): CopyOptions {
  const row = document.createElement("label");
  row.className = "share-group-row";
  row.innerHTML = `
    <span class="share-group-label">Include annotations</span>
    <span class="settings-toggle-switch">
      <input type="checkbox" class="share-annotations-toggle">
      <span class="settings-toggle-slider"></span>
      <span class="settings-toggle-knob"></span>
    </span>
  `;
  const toggle = row.querySelector(
    ".share-annotations-toggle",
  ) as HTMLInputElement;

  const card = document.createElement("div");
  card.className = "share-compose share-file-card";
  const fileCard = createFileCard(ctx.doc, ctx.fileName);
  card.appendChild(fileCard.el);

  const hasChoice = ctx.doc.hasAnnotations();
  row.hidden = !hasChoice;
  // With nothing to leave out, the copy is the document as it stands.
  const annotated = () => !hasChoice || ctx.includeAnnotations;

  /** Bumped per render, so a slow export can't overwrite a newer choice's size. */
  let request = 0;

  const render = () => {
    toggle.checked = annotated();
    // The pages appearing and disappearing is the description of the choice.
    fileCard.showPages(annotated());

    const mine = ++request;
    fileCard.setSize("Preparing…");
    ctx.getFile(annotated()).then(
      (file) => mine === request && fileCard.setSize(formatBytes(file.size)),
      () => mine === request && fileCard.setSize(""),
    );
  };

  toggle.addEventListener("change", () => {
    ctx.includeAnnotations = toggle.checked;
    Config.set("export_include_annotations", toggle.checked);
    ctx.relayout(render);
  });

  return {
    row,
    card,
    hasChoice,
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
