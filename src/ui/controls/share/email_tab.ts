/**
 * Share › Email: an editable draft, sent with the link or, toggled on, with
 * the annotated PDF attached and previewed page by page.
 */

import {
  annotatedPages,
  pageAspect,
  renderThumbnail,
} from "./annotated_pages.js";

import { Config } from "../../settings/config.js";

import type { ShareContext, ShareTab } from "./share_modal.js";

/** Most providers cap attachments at 20–25 MB. */
const LARGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const THUMB_HEIGHT = 88;
/** Past this many annotated pages the strip stops and says how many remain. */
const MAX_THUMBS = 24;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Hand a draft to the system's mail client. */
function openMail(subject: string, body: string) {
  // RFC 6068 wants CRLF line breaks inside a mailto body.
  const params = [
    `subject=${encodeURIComponent(subject)}`,
    `body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`,
  ];
  window.location.href = `mailto:?${params.join("&")}`;
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      <div class="share-attachment" hidden>
        <div class="share-attachment-file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 3 14 8 19 8"/>
          </svg>
          <span class="share-attachment-name"></span>
          <span class="share-attachment-size"></span>
        </div>
        <div class="share-attachment-pages"></div>
      </div>
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
  const attachment = $<HTMLDivElement>(".share-attachment");
  const sizeLabel = $<HTMLSpanElement>(".share-attachment-size");
  const strip = $<HTMLDivElement>(".share-attachment-pages");
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

  $(".share-attachment-name").textContent = ctx.fileName;

  let readyFile: File | null = null;
  let stripBuilt = false;

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

  /** Lay out a placeholder per annotated page now, and fill them in as they render. */
  const buildStrip = () => {
    if (stripBuilt) return;
    stripBuilt = true;

    const pages = annotatedPages(ctx.doc);
    if (pages.length === 0) {
      strip.hidden = true;
      return;
    }

    const shown = pages.slice(0, MAX_THUMBS);
    const frames = shown.map((pageNumber) => {
      const frame = document.createElement("figure");
      frame.className = "share-thumb";
      frame.innerHTML = `<div class="share-thumb-sheet"></div><figcaption>p. ${pageNumber}</figcaption>`;
      const sheet = frame.firstElementChild as HTMLDivElement;
      sheet.style.height = `${THUMB_HEIGHT}px`;
      sheet.style.width = `${Math.round(THUMB_HEIGHT * pageAspect(ctx.doc, pageNumber))}px`;
      strip.appendChild(frame);
      return sheet;
    });
    if (pages.length > shown.length) {
      const more = document.createElement("span");
      more.className = "share-thumb-more";
      more.textContent = `+${pages.length - shown.length} more`;
      strip.appendChild(more);
    }

    // One at a time, so the viewer's own renders aren't starved.
    (async () => {
      for (let i = 0; i < shown.length; i++) {
        try {
          const canvas = await renderThumbnail(ctx.doc, shown[i], THUMB_HEIGHT);
          if (canvas) frames[i].appendChild(canvas);
        } catch (error) {
          console.warn(`Thumbnail for page ${shown[i]} failed:`, error);
        }
      }
    })();
  };

  const prepareFile = async () => {
    if (readyFile) return;
    sizeLabel.textContent = "Preparing…";
    try {
      readyFile = await ctx.getAnnotatedFile();
      sizeLabel.textContent = formatBytes(readyFile.size);
    } catch (error) {
      console.error("Error exporting annotated PDF:", error);
      sizeLabel.textContent = "";
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
      buildStrip();
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
    download(readyFile);
    openMail(ctx.title, body.value);
    ctx.showToast(`Saved "${ctx.fileName}". Attach it to the email`);
  });

  return { el, onShow: render };
}
