/**
 * Share › Email: an editable draft, sent with the link or, toggled on, with
 * the annotated PDF attached and previewed page by page.
 */

import {
  pageAspect,
  renderThumbnail,
  summarizeAnnotations,
} from "./annotated_pages.js";

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
      <input class="share-compose-subject" type="text" placeholder="Subject" aria-label="Subject">
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
        <span class="share-attachment-summary"></span>
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
  const subject = $<HTMLInputElement>(".share-compose-subject");
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
    if (!attaching()) return `${ctx.title}\n${ctx.link}`;
    const lines = [ctx.title, "", "I've attached my annotated copy."];
    if (hasLink()) lines.push("", `Original: ${ctx.link}`);
    return lines.join("\n");
  };

  subject.value = ctx.title;
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
    if (!readyFile) {
      hint.textContent = "";
    } else if (readyFile.size > LARGE_ATTACHMENT_BYTES) {
      hint.textContent =
        "Large for email. Many providers cap attachments at 25 MB";
    } else if (navigator.canShare?.({ files: [readyFile] })) {
      hint.textContent = "Opens the share sheet. Choose Mail to attach it";
    } else {
      hint.textContent = "Downloads the PDF for you to attach to the draft";
    }
  };

  /** Lay out a placeholder per annotated page now, and fill them in as they render. */
  const buildStrip = () => {
    if (stripBuilt) return;
    stripBuilt = true;

    const { pages, summary } = summarizeAnnotations(ctx.doc);
    $(".share-attachment-summary").textContent =
      summary || "No annotations yet. The PDF goes as it is";
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
    toggleNote.textContent = !hasLink()
      ? "This PDF has no web link, so it goes as a file"
      : toggle.checked
        ? "Sends your copy with its highlights and comments"
        : "Sends the link only";

    if (!bodyEdited) body.value = defaultBody();
    attachment.hidden = !attaching();
    if (attaching()) {
      buildStrip();
      prepareFile();
    }
    renderHint();
  };

  toggle.addEventListener("change", () => ctx.relayout(render));
  body.addEventListener("input", () => (bodyEdited = true));

  sendBtn.addEventListener("click", async () => {
    if (!attaching()) {
      openMail(subject.value, body.value);
      return;
    }
    if (!readyFile) return;

    // A mailto: draft can't carry an attachment. The share sheet can, so use
    // it where the browser has one (Safari, Chrome on macOS); otherwise
    // download the copy and open a draft for the user to attach it to.
    if (navigator.canShare?.({ files: [readyFile] })) {
      try {
        await navigator.share({
          files: [readyFile],
          title: subject.value,
          text: body.value,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return; // User dismissed the share sheet
        }
        console.warn("Share sheet unavailable, falling back:", error);
      }
    }
    download(readyFile);
    openMail(subject.value, body.value);
    ctx.showToast(`Saved "${ctx.fileName}". Attach it to the email`);
  });

  return { el, onShow: render };
}
