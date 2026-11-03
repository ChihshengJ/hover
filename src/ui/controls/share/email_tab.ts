/**
 * Share › Email: an editable draft, sent with the link or, toggled on, with
 * the annotated PDF attached and previewed page by page.
 */

import {
  annotatedPages,
  createFileCard,
  formatBytes,
} from "./annotated_pages.js";
import { downloadFile } from "./copy_options.js";

import { Config } from "../../settings/config.js";

import type { ShareContext, ShareTab } from "./share_modal.js";

/** Most providers cap attachments at 20–25 MB. */
const LARGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Hand a draft to the system's mail client. */
function openMail(subject: string, body: string) {
  // RFC 6068 wants CRLF line breaks inside a mailto body.
  const params = [
    `subject=${encodeURIComponent(subject)}`,
    `body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`,
  ];
  window.location.href = `mailto:?${params.join("&")}`;
}

export function createEmailTab(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");
  el.innerHTML = `
    <div class="settings-toggle-row share-attach-row">
      <div class="settings-toggle-info">
        <span class="settings-toggle-label">Attach annotated PDF</span>
        <span class="settings-toggle-description"></span>
      </div>
      <label class="settings-toggle-switch">
        <input type="checkbox" class="share-attach-toggle">
        <span class="settings-toggle-slider"></span>
        <span class="settings-toggle-knob"></span>
      </label>
    </div>

    <div class="share-compose">
      <textarea class="share-compose-body" rows="4" placeholder="Message" aria-label="Message"></textarea>
    </div>

    <div class="share-footer">
      <span class="share-hint"></span>
      <button class="share-btn share-btn-primary share-send">Open in Mail</button>
    </div>
  `;

  const $ = <T extends HTMLElement>(selector: string) =>
    el.querySelector(selector) as T;
  const toggle = $<HTMLInputElement>(".share-attach-toggle");
  const toggleRow = $<HTMLDivElement>(".share-attach-row");
  const toggleNote = $<HTMLSpanElement>(".settings-toggle-description");
  const body = $<HTMLTextAreaElement>(".share-compose-body");
  const card = createFileCard(ctx.doc, ctx.fileName);
  const attachment = card.el;
  attachment.hidden = true;
  $(".share-compose").appendChild(attachment);
  const hint = $<HTMLSpanElement>(".share-hint");
  const sendBtn = $<HTMLButtonElement>(".share-send");

  const hasLink = () => !!ctx.link;
  // Without a link there's only the file to send.
  const attaching = () => toggle.checked || !hasLink();

  // A body the user hasn't touched keeps following the link and the toggle.
  let bodyEdited = false;
  const defaultBody = () => {
    const paragraphs: string[] = [];
    const opening = Config.get("share_email_opening").trim();
    if (opening) paragraphs.push(opening);
    paragraphs.push(hasLink() ? `${ctx.title}\n${ctx.link}` : ctx.title);
    if (attaching()) {
      paragraphs.push(
        annotatedPages(ctx.doc).length > 0
          ? "I've attached my annotated copy."
          : "I've attached a copy.",
      );
    }
    return paragraphs.join("\n\n");
  };

  /** Grow the sheet with its text, like paper rather than a scroll box. */
  const fitBody = () => {
    body.style.height = "auto";
    body.style.height = `${body.scrollHeight}px`;
  };

  let readyFile: File | null = null;

  const renderHint = () => {
    if (!attaching()) {
      hint.textContent = "";
      sendBtn.disabled = false;
      return;
    }
    sendBtn.disabled = !readyFile;
    hint.textContent =
      readyFile && readyFile.size > LARGE_ATTACHMENT_BYTES
        ? "Large for email. Many providers cap attachments at 25 MB"
        : "";
  };

  const prepareFile = async () => {
    if (readyFile) return;
    card.setSize("Preparing…");
    try {
      readyFile = await ctx.getFile(true);
      card.setSize(formatBytes(readyFile.size));
    } catch (error) {
      console.error("Error exporting annotated PDF:", error);
      card.setSize("");
      hint.textContent = "Couldn't export the annotated PDF";
      return;
    }
    renderHint();
  };

  const render = () => {
    toggle.checked = attaching();
    toggle.disabled = !hasLink();
    toggleRow.classList.toggle("locked", !hasLink());
    toggleNote.textContent = hasLink()
      ? "Attach the file with your annotations"
      : "No obtainable link, attachment only.";

    if (!bodyEdited) body.value = defaultBody();
    fitBody();
    attachment.hidden = !attaching();
    if (attaching()) {
      card.showPages(true);
      prepareFile();
    }
    renderHint();
  };

  toggle.addEventListener("change", () => ctx.relayout(render));
  body.addEventListener("input", () => {
    bodyEdited = true;
    fitBody();
  });

  sendBtn.addEventListener("click", async () => {
    if (!attaching()) {
      // The share sheet can't take a subject, so neither mode offers one; the
      // draft is titled after the paper, as its first line already is.
      openMail(ctx.title, body.value);
      return;
    }
    if (!readyFile) return;

    // A mailto: draft can't carry an attachment. The share sheet can, so use
    // it where the browser has one (Safari, Chrome on macOS); otherwise
    // download the copy and open a draft for the user to attach it to.
    if (navigator.canShare?.({ files: [readyFile] })) {
      try {
        // No `title`: on macOS neither Chrome nor Safari maps it to Mail's
        // subject. Chrome adds it to the body as its own line instead, which
        // repeats the title the draft already opens with.
        await navigator.share({ files: [readyFile], text: body.value });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return; // User dismissed the share sheet
        }
        console.warn("Share sheet unavailable, falling back:", error);
      }
    }
    downloadFile(readyFile);
    openMail(ctx.title, body.value);
    ctx.showToast(`Saved "${ctx.fileName}". Attach it to the email`);
  });

  return { el, onShow: render };
}
