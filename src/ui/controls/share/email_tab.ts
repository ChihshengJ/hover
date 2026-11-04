/**
 * Share › Email, two ways to send the paper, picked at the top:
 *
 *   Link        A letter: an editable opening line, remembered for next
 *               time, over the paper's title and link, handed to the mail
 *               app as a mailto: draft.
 *   Attachment  The PDF alone, with or without annotations, drawn as a stack
 *               of paper and handed to Mail through the system share sheet.
 *
 * They can't be combined. On macOS, neither Safari's share sheet nor
 * Chrome's offers Mail once any text rides along with a file, and a mailto:
 * draft can't carry a file.
 */

import { createCopyOptions, downloadFile } from "./copy_options.js";
import { Config } from "../../settings/config.js";

import type { ShareContext, ShareTab } from "./share_modal.js";

type Mode = "link" | "file";

/** Most providers cap attachments at 20–25 MB. */
const LARGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Hand a draft to the system's mail client. */
function openMail(subject: string, body = "") {
  const params = [`subject=${encodeURIComponent(subject)}`];
  // RFC 6068 wants CRLF line breaks inside a mailto body.
  if (body) {
    params.push(`body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`);
  }
  window.location.href = `mailto:?${params.join("&")}`;
}

export function createEmailTab(ctx: ShareContext): ShareTab {
  const el = document.createElement("section");
  el.className = "share-panel";
  el.setAttribute("role", "tabpanel");
  el.innerHTML = `
    <div class="share-segmented" role="radiogroup" aria-label="Send as">
      <span class="share-segmented-pill"></span>
      <button class="share-segment" role="radio" data-mode="link">Link</button>
      <button class="share-segment" role="radio" data-mode="file">Attachment</button>
    </div>

    <div class="share-compose share-letter">
      <textarea class="share-letter-opening" rows="1" spellcheck="true" placeholder="Add a note" aria-label="Opening line"></textarea>
      <div class="share-letter-link">
        <span class="share-letter-title"></span>
        <span class="share-letter-url"></span>
      </div>
    </div>

    <div class="share-footer">
      <span class="share-hint"></span>
      <button class="share-btn share-btn-primary share-send"></button>
    </div>
  `;

  const $ = <T extends HTMLElement>(selector: string) =>
    el.querySelector(selector) as T;
  const segmented = $<HTMLDivElement>(".share-segmented");
  const segments = Array.from(
    el.querySelectorAll<HTMLButtonElement>(".share-segment"),
  );
  const letter = $<HTMLDivElement>(".share-letter");
  const opening = $<HTMLTextAreaElement>(".share-letter-opening");
  const hint = $<HTMLSpanElement>(".share-hint");
  const sendBtn = $<HTMLButtonElement>(".share-send");

  // The line as last written, so a greeting kept for every paper stays put.
  opening.value = Config.get("share_email_opening");
  $(".share-letter-title").textContent = ctx.title;

  // The sheet only opens straight from a click, so the file is exported ahead
  // of it and the button waits for that.
  let ready: File | null = null;
  let failed = false;
  const options = createCopyOptions(ctx, {
    onFile: (file, didFail) => {
      ready = file;
      failed = didFail;
      renderFooter();
    },
  });
  letter.after(options.el);

  const hasLink = () => !!ctx.link;
  let chosen: Mode = hasLink() ? "link" : "file";
  // Without a link there's only the file to send.
  const mode = (): Mode => (hasLink() ? chosen : "file");

  /** Grow the sheet with its text, like paper rather than a scroll box. */
  const fitOpening = () => {
    opening.style.height = "auto";
    opening.style.height = `${opening.scrollHeight}px`;
  };

  const renderFooter = () => {
    if (mode() === "link") {
      sendBtn.textContent = "Open in Mail";
      sendBtn.disabled = false;
      hint.textContent = "";
      return;
    }
    sendBtn.textContent = "Share to Mail";
    sendBtn.disabled = !ready;
    hint.textContent = failed
      ? "Couldn't export the PDF"
      : ready && ready.size > LARGE_ATTACHMENT_BYTES
        ? "Large for email. Many providers cap attachments at 25 MB"
        : hasLink()
          ? ""
          : ctx.originalUrl
            ? "The Link tab's link is empty, so there's no link to send"
            : "Opened from your computer, so there's no link to send";
  };

  const render = () => {
    const current = mode();
    segmented.dataset.mode = current;
    for (const segment of segments) {
      const on = segment.dataset.mode === current;
      segment.setAttribute("aria-checked", String(on));
      segment.tabIndex = on ? 0 : -1;
      segment.disabled = segment.dataset.mode === "link" && !hasLink();
    }

    letter.hidden = current !== "link";
    options.el.hidden = current !== "file";
    if (current === "link") {
      $(".share-letter-url").textContent = ctx.link;
      fitOpening();
      renderFooter();
    } else {
      // Exports the file, which reports back through onFile.
      options.sync();
    }
  };

  const choose = (next: Mode) => {
    if (next === mode() || (next === "link" && !hasLink())) return;
    chosen = next;
    ctx.relayout(render);
    segments.find((s) => s.dataset.mode === next)?.focus();
  };

  segments.forEach((segment) =>
    segment.addEventListener("click", () =>
      choose(segment.dataset.mode as Mode),
    ),
  );
  segmented.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    choose(mode() === "link" ? "file" : "link");
  });
  opening.addEventListener("input", () => {
    Config.set("share_email_opening", opening.value);
    ctx.relayout(fitOpening);
  });

  sendBtn.addEventListener("click", async () => {
    if (mode() === "link") {
      const note = opening.value.trim();
      const link = `${ctx.title}\n${ctx.link}`;
      openMail(ctx.title, note ? `${note}\n\n${link}` : link);
      return;
    }

    const file = ready;
    if (!file) return;
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (error) {
        // AbortError is the user dismissing the sheet.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Share sheet failed:", error);
          ctx.showToast("Couldn't open the share sheet");
        }
      }
      return;
    }

    // No share sheet (Firefox): save the copy and open a draft to attach it to.
    downloadFile(file);
    openMail(ctx.title);
    ctx.showToast(`Saved "${ctx.fileName}". Attach it to the email`);
  });

  // The link may have been edited, or cleared, on the Link tab.
  return { el, onShow: render };
}
