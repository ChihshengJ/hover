/**
 * The exported copy every Save, Print and Email panel offers: the file drawn
 * as a stack of paper, with the "Include annotations" switch beneath it. The
 * choice lives on the context, so every panel showing one of these agrees.
 */

import { formatBytes } from "./annotated_pages.js";
import { createFilePile } from "./file_pile.js";
import { createBeadSwitch } from "../../components/bead_switch.js";
import { Config } from "../../settings/config.js";

import type { ShareContext } from "./share_modal.js";

export interface CopyOptions {
  /** The file as a stack of paper, the annotations switch beneath it. */
  el: HTMLElement;
  /** Pick up the shared choice and preview it; call from the tab's onShow. */
  sync(): void;
  /** The file the choice describes, or null when it couldn't be exported. */
  file(): Promise<File | null>;
}

export interface CopyOptionsSetup {
  /**
   * Told the file for the current choice once it's exported, and null while
   * it's being prepared or, with `failed`, when it couldn't be.
   */
  onFile?(file: File | null, failed: boolean): void;
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

export function createCopyOptions(
  ctx: ShareContext,
  { onFile }: CopyOptionsSetup = {},
): CopyOptions {
  const pile = createFilePile(ctx.doc, ctx.fileName);

  // The whole row is a <label>, so its text flips the switch too.
  const row = document.createElement("label");
  row.className = "share-pile-option";
  row.innerHTML = `<span>Include annotations</span>`;
  const { el: switchEl, input: toggle } = createBeadSwitch();
  row.appendChild(switchEl);
  pile.addRow(row);

  const hasChoice = ctx.doc.hasAnnotations();
  row.hidden = !hasChoice;
  // With nothing to leave out, the copy is the document as it stands.
  const annotated = () => !hasChoice || ctx.includeAnnotations;

  /** Bumped per render, so a slow export can't overwrite a newer choice's size. */
  let request = 0;

  const render = () => {
    toggle.checked = annotated();
    // The stack splitting into its annotated pages describes the choice.
    pile.showPages(annotated());

    const mine = ++request;
    pile.setSize("Preparing…");
    onFile?.(null, false);
    ctx.getFile(annotated()).then(
      (file) => {
        if (mine !== request) return;
        pile.setSize(formatBytes(file.size));
        onFile?.(file, false);
      },
      (error) => {
        if (mine !== request) return;
        console.error("Error exporting PDF:", error);
        pile.setSize("");
        onFile?.(null, true);
      },
    );
  };

  toggle.addEventListener("change", () => {
    ctx.includeAnnotations = toggle.checked;
    Config.set("export_include_annotations", toggle.checked);
    ctx.relayout(render);
  });

  return {
    el: pile.el,
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
