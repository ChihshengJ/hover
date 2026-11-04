/**
 * Save a Copy › Zotero: save the PDF, with or without annotations, into a
 * chosen library or collection of the Zotero desktop app.
 *
 * The panel is one of three bodies, by state: the form (where to, which copy),
 * a notice when Zotero can't be reached, and the confirmation once saved. The
 * connection itself is a quiet line in the footer beside the button.
 */

import {
  getZoteroTargets,
  hasZoteroAccess,
  requestZoteroAccess,
  saveToZotero,
} from "../../../platform/zotero.js";
import { createCopyOptions } from "./copy_options.js";

import type { ZoteroTargets } from "../../../platform/zotero.js";
import type { ShareContext, ShareTab } from "./share_modal.js";

type State =
  | { kind: "looking" }
  | { kind: "ready" }
  | { kind: "saving"; note: string }
  | { kind: "saved"; target: string; title: string | null }
  /** Zotero can't be reached; the notice says why and offers the way out. */
  | {
      kind: "blocked";
      title: string;
      body: string;
      action: { label: string; run: () => void };
    };

const CHECK_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="5 12 10 17 19 7"/>
  </svg>`;

export function createZoteroTab(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");
  el.innerHTML = `
    <div class="share-zotero-form">
      <div class="share-group">
        <div class="share-group-row">
          <span class="share-group-label">Location</span>
          <select class="settings-select share-group-select" aria-label="Library or collection"></select>
        </div>
      </div>
    </div>

    <div class="share-notice" hidden>
      <span class="share-notice-title"></span>
      <span class="share-notice-body"></span>
      <button class="share-btn share-notice-action"></button>
    </div>

    <div class="share-zotero-result" hidden>
      <span class="share-zotero-result-icon">${CHECK_ICON}</span>
      <div class="share-zotero-result-text">
        <span class="share-zotero-result-target"></span>
        <span class="share-zotero-result-title"></span>
      </div>
    </div>

    <div class="share-footer">
      <span class="share-hint share-zotero-status">
        <span class="share-light" data-light="pending"></span>
        <span class="share-zotero-status-text"></span>
      </span>
      <button class="share-btn share-btn-primary share-zotero-save" disabled>Save to Zotero</button>
    </div>
  `;

  const $ = <T extends HTMLElement>(selector: string) =>
    el.querySelector(selector) as T;
  const form = $<HTMLDivElement>(".share-zotero-form");
  const select = $<HTMLSelectElement>(".share-group-select");
  const notice = $<HTMLDivElement>(".share-notice");
  const noticeAction = $<HTMLButtonElement>(".share-notice-action");
  const result = $<HTMLDivElement>(".share-zotero-result");
  const light = $<HTMLSpanElement>(".share-light");
  const statusText = $<HTMLSpanElement>(".share-zotero-status-text");
  const saveBtn = $<HTMLButtonElement>(".share-zotero-save");

  const options = createCopyOptions(ctx);
  form.appendChild(options.el);

  let targets: ZoteroTargets | null = null;
  /** The user's pick, kept across refreshes; Zotero's own selection until then. */
  let chosenId: string | null = null;
  let state: State = { kind: "looking" };

  const render = (next: State) => {
    state = next;
    ctx.relayout(() => {
      const { kind } = next;
      form.hidden = kind === "blocked" || kind === "saved";
      notice.hidden = kind !== "blocked";
      result.hidden = kind !== "saved";

      select.disabled = kind !== "ready";
      // Coming back to the tab, the last list stays up while it's rechecked.
      if (kind === "looking" && !targets) {
        select.replaceChildren(new Option("Looking for Zotero…"));
      }

      if (kind === "blocked") {
        $(".share-notice-title").textContent = next.title;
        $(".share-notice-body").textContent = next.body;
        noticeAction.textContent = next.action.label;
      }

      if (kind === "saved") {
        $(".share-zotero-result-target").textContent =
          `Saved to ${next.target}`;
        $(".share-zotero-result-title").textContent =
          next.title ??
          "Zotero couldn't identify the paper, so it's filed as a PDF";
        result.classList.toggle("unrecognized", !next.title);
      }

      light.dataset.light =
        kind === "looking" ? "pending" : kind === "blocked" ? "off" : "on";
      statusText.textContent =
        kind === "looking"
          ? "Looking for Zotero…"
          : kind === "blocked"
            ? "Not connected"
            : kind === "saving"
              ? next.note
              : "Connected to Zotero";

      saveBtn.textContent =
        kind === "saving"
          ? "Saving…"
          : kind === "saved"
            ? "Done"
            : "Save to Zotero";
      saveBtn.disabled = kind !== "ready" && kind !== "saved";
    });
  };

  const fillTargets = (next: ZoteroTargets) => {
    const keep = chosenId ?? next.selectedId;
    select.replaceChildren(
      // A native <select> can't indent, so nesting is drawn with spaces.
      ...next.targets.map(
        (target) =>
          new Option(" ".repeat(target.level) + target.name, target.id),
      ),
    );
    select.value = next.targets.some((t) => t.id === keep)
      ? keep
      : next.selectedId;
    targets = next;
  };

  const refresh = async () => {
    if (state.kind === "saving" || state.kind === "saved") return;
    render({ kind: "looking" });

    if (!(await hasZoteroAccess())) {
      render({
        kind: "blocked",
        title: "Connect to Zotero",
        body: "Hover needs your permission to reach the Zotero app on this computer.",
        action: { label: "Allow", run: allow },
      });
      return;
    }

    const found = await getZoteroTargets();
    if (!found || found.targets.length === 0) {
      render({
        kind: "blocked",
        title: "Zotero isn't running",
        body: "Open the Zotero desktop app, then try again.",
        action: { label: "Try Again", run: refresh },
      });
      return;
    }

    fillTargets(found);
    render({ kind: "ready" });
  };

  const allow = async () => {
    // Asked straight from the click: the prompt only shows during a gesture.
    if (await requestZoteroAccess()) {
      refresh();
    } else {
      render({
        kind: "blocked",
        title: "Permission not granted",
        body: "Without it, Hover can't talk to Zotero.",
        action: { label: "Allow", run: allow },
      });
    }
  };

  const save = async () => {
    if (!targets || state.kind !== "ready") return;
    const targetId = select.value;
    const targetName =
      targets.targets.find((t) => t.id === targetId)?.name ?? "Zotero";

    render({ kind: "saving", note: "Exporting your copy…" });
    const file = await options.file();
    if (!file) {
      render({ kind: "ready" });
      return;
    }
    try {
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
          render({ kind: "saving", note: "Zotero is identifying the paper…" }),
      );
      render({ kind: "saved", target: targetName, title });
    } catch (error) {
      console.error("Zotero save failed:", error);
      render({
        kind: "blocked",
        title: "Zotero couldn't save the PDF",
        body: "Check that Zotero is still open, then try again.",
        action: { label: "Try Again", run: refresh },
      });
    }
  };

  select.addEventListener("change", () => (chosenId = select.value));
  noticeAction.addEventListener("click", () => {
    if (state.kind === "blocked") state.action.run();
  });
  saveBtn.addEventListener("click", () => {
    if (state.kind === "saved") ctx.close();
    else save();
  });

  return {
    el,
    onShow: () => {
      options.sync();
      refresh();
    },
  };
}
