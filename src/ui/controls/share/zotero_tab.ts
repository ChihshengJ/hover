/**
 * Share › Zotero: save the annotated PDF into a chosen library or collection
 * of the Zotero desktop app.
 */

import {
  getZoteroTargets,
  hasZoteroAccess,
  requestZoteroAccess,
  saveToZotero,
} from "../../../platform/zotero.js";

import type { ZoteroTargets } from "../../../platform/zotero.js";
import type { ShareContext, ShareTab } from "./share_modal.js";

type Light = "off" | "pending" | "on";

export function createZoteroTab(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");
  el.innerHTML = `
    <div class="settings-toggle-row share-zotero-status">
      <span class="share-light" data-light="off"></span>
      <div class="settings-toggle-info">
        <span class="settings-toggle-label"></span>
        <span class="settings-toggle-description"></span>
      </div>
      <button class="share-btn share-zotero-retry" hidden></button>
    </div>

    <div class="settings-select-row share-zotero-target" hidden>
      <span class="settings-toggle-label">Save to</span>
      <select class="settings-select" aria-label="Library or collection"></select>
    </div>

    <div class="share-zotero-result" hidden>
      <span class="share-label">Saved to <span class="share-zotero-result-target"></span></span>
      <span class="share-zotero-result-title"></span>
    </div>

    <div class="share-footer">
      <button class="share-btn share-btn-primary share-zotero-save" disabled>Save to Zotero</button>
    </div>
  `;

  const $ = <T extends HTMLElement>(selector: string) =>
    el.querySelector(selector) as T;
  const light = $<HTMLSpanElement>(".share-light");
  const statusLabel = $<HTMLSpanElement>(
    ".share-zotero-status .settings-toggle-label",
  );
  const statusNote = $<HTMLSpanElement>(
    ".share-zotero-status .settings-toggle-description",
  );
  const actionBtn = $<HTMLButtonElement>(".share-zotero-retry");
  const targetRow = $<HTMLDivElement>(".share-zotero-target");
  const select = $<HTMLSelectElement>(".settings-select");
  const result = $<HTMLDivElement>(".share-zotero-result");
  const saveBtn = $<HTMLButtonElement>(".share-zotero-save");

  let targets: ZoteroTargets | null = null;
  let busy = false;
  let saved = false;
  /** What the action button does in the current state. */
  let action: (() => void) | null = null;

  const setStatus = (
    state: Light,
    label: string,
    note: string,
    button?: { label: string; run: () => void },
  ) => {
    ctx.relayout(() => {
      light.dataset.light = state;
      statusLabel.textContent = label;
      statusNote.textContent = note;
      actionBtn.hidden = !button;
      actionBtn.textContent = button?.label ?? "";
      action = button?.run ?? null;
      targetRow.hidden = !targets || saved;
      saveBtn.disabled = !targets || busy || saved;
    });
  };

  const fillTargets = (next: ZoteroTargets) => {
    const keep = select.value || next.selectedId;
    select.replaceChildren(
      ...next.targets.map((target) => {
        const option = document.createElement("option");
        option.value = target.id;
        // A native <select> can't indent, so nesting is drawn with spaces.
        option.textContent = " ".repeat(target.level) + target.name;
        return option;
      }),
    );
    select.value = next.targets.some((t) => t.id === keep)
      ? keep
      : next.selectedId;
    targets = next;
  };

  const refresh = async () => {
    if (busy || saved) return;
    targets = null;
    setStatus("pending", "Looking for Zotero…", "");

    if (!(await hasZoteroAccess())) {
      setStatus(
        "pending",
        "Connect to Zotero",
        "Hover needs your permission to reach the Zotero app on this computer",
        { label: "Allow", run: allow },
      );
      return;
    }

    const found = await getZoteroTargets();
    if (!found || found.targets.length === 0) {
      setStatus(
        "off",
        "Zotero isn't running",
        "Open the Zotero desktop app, then try again",
        { label: "Retry", run: refresh },
      );
      return;
    }

    fillTargets(found);
    setStatus("on", "Connected to Zotero", "");
  };

  const allow = async () => {
    // Asked straight from the click: the prompt only shows during a gesture.
    if (await requestZoteroAccess()) {
      refresh();
    } else {
      setStatus(
        "off",
        "Permission not granted",
        "Without it, Hover can't talk to Zotero",
        { label: "Allow", run: allow },
      );
    }
  };

  const save = async () => {
    if (!targets || busy) return;
    const targetId = select.value;
    const targetName =
      targets.targets.find((t) => t.id === targetId)?.name ?? "Zotero";

    busy = true;
    setStatus("on", "Saving to Zotero…", "Exporting your annotated copy");
    try {
      const file = await ctx.getAnnotatedFile();
      const title = await saveToZotero(
        file,
        {
          url:
            ctx.link ||
            ctx.originalUrl ||
            `file:///${encodeURIComponent(ctx.fileName)}`,
          title: ctx.title,
          targetId,
        },
        () =>
          setStatus(
            "on",
            "Saving to Zotero…",
            "Zotero is identifying the paper",
          ),
      );

      saved = true;
      busy = false;
      ctx.relayout(() => {
        $(".share-zotero-result-target").textContent = targetName;
        $(".share-zotero-result-title").textContent =
          title ?? "Zotero couldn't identify the paper, so it's filed as a PDF";
        result.classList.toggle("unrecognized", !title);
        result.hidden = false;
      });
      saveBtn.textContent = "Saved";
      setStatus("on", "Connected to Zotero", "");
    } catch (error) {
      console.error("Zotero save failed:", error);
      busy = false;
      setStatus(
        "off",
        "Zotero couldn't save the PDF",
        "Check that Zotero is still open, then try again",
        { label: "Retry", run: refresh },
      );
    }
  };

  actionBtn.addEventListener("click", () => action?.());
  saveBtn.addEventListener("click", save);

  return { el, onShow: refresh };
}
