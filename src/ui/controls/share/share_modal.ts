/**
 * The File menu's Share dialog: Link, Email and Zotero tabs over one shared
 * annotated export of the document.
 */

import { createLinkTab } from "./link_tab.js";
import { createEmailTab } from "./email_tab.js";
import { createZoteroTab } from "./zotero_tab.js";

import type { PDFDocumentModel } from "../../../model/doc.js";

export interface ShareContext {
  doc: PDFDocumentModel;
  title: string;
  /** The document's web address, null for a file opened from disk. */
  originalUrl: string | null;
  /** The link as edited on the Link tab; the other tabs share it. */
  link: string;
  fileName: string;
  /** The annotated copy, exported on first use and then reused. */
  getAnnotatedFile(): Promise<File>;
  /** Make a change that resizes the open tab, animating the dialog's height. */
  relayout(mutate: () => void): void;
  showToast(message: string): void;
}

export interface ShareTab {
  el: HTMLElement;
  /** Runs each time the tab comes to the front. */
  onShow?(): void;
}

type TabId = "link" | "email" | "zotero";

const TABS: { id: TabId; label: string; icon: string }[] = [
  {
    id: "link",
    label: "Link",
    icon: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
           <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  },
  {
    id: "email",
    label: "Email",
    icon: `<rect x="3" y="5" width="18" height="14" rx="2"/>
           <polyline points="3 7 12 13 21 7"/>`,
  },
  {
    id: "zotero",
    label: "Zotero",
    icon: `<path d="M4 19.5V5a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2z"/>
           <path d="M4 19.5A2 2 0 0 0 6 21.5h12"/>
           <line x1="9" y1="7" x2="14" y2="7"/>`,
  },
];

export function shareableUrl(): string | null {
  const url =
    document.documentElement.dataset.hoverOriginalUrl ||
    new URLSearchParams(window.location.search).get("url");

  // A file: URL only resolves on this machine, so there's nothing to share.
  if (!url || !/^https?:/i.test(url)) return null;
  return url;
}

/**
 * Run `mutate`, then animate `el` from its old height to its new one. The
 * height is left on `auto` afterwards so later content can still grow it.
 */
function animateHeight(el: HTMLElement, mutate: () => void) {
  const from = el.offsetHeight;
  el.style.height = "";
  mutate();
  const to = el.offsetHeight;
  if (from === to) return;

  el.classList.add("animating");
  el.style.height = `${from}px`;
  void el.offsetHeight;
  el.style.height = `${to}px`;

  const done = (e: TransitionEvent) => {
    if (e.target !== el || e.propertyName !== "height") return;
    el.removeEventListener("transitionend", done);
    el.style.height = "";
    el.classList.remove("animating");
  };
  el.addEventListener("transitionend", done);
}

export async function openShareModal(
  doc: PDFDocumentModel,
  showToast: (message: string) => void,
) {
  document.querySelector(".file-menu-modal-overlay")?.remove();

  const documentName = document.title.replace(" - Hover PDF", "");
  const originalUrl = shareableUrl();

  const overlay = document.createElement("div");
  overlay.className = "file-menu-modal-overlay";
  overlay.innerHTML = `
    <div class="file-menu-modal share-modal">
      <div class="file-menu-modal-header">
        <h2>Share</h2>
        <button class="file-menu-modal-close">×</button>
      </div>
      <div class="share-tabs" role="tablist">
        <span class="share-tabs-pill"></span>
        ${TABS.map(
          (tab) => `
          <button class="share-tab" role="tab" data-tab="${tab.id}" aria-selected="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${tab.icon}</svg>
            <span>${tab.label}</span>
          </button>`,
        ).join("")}
      </div>
      <div class="share-panels"></div>
    </div>
  `;

  const tabBar = overlay.querySelector(".share-tabs") as HTMLDivElement;
  const pill = overlay.querySelector(".share-tabs-pill") as HTMLSpanElement;
  const panels = overlay.querySelector(".share-panels") as HTMLDivElement;
  const tabButtons = Array.from(
    overlay.querySelectorAll<HTMLButtonElement>(".share-tab"),
  );

  let annotatedFile: Promise<File> | null = null;
  // A tab's onShow runs inside the switch's relayout and may relayout itself;
  // the outer animation already covers that change.
  let relayingOut = false;
  const fileName = documentName + ".pdf";

  const ctx: ShareContext = {
    doc,
    title: (await doc.getDocumentTitle()) || documentName,
    originalUrl,
    link: originalUrl ?? "",
    fileName,
    getAnnotatedFile: () =>
      (annotatedFile ??= doc
        .saveWithAnnotations()
        .then((data) => new File([data], fileName, { type: "application/pdf" }))
        .catch((error) => {
          annotatedFile = null; // Let the next attempt retry
          throw error;
        })),
    relayout: (mutate) => {
      if (relayingOut) return mutate();
      relayingOut = true;
      try {
        animateHeight(panels, mutate);
      } finally {
        relayingOut = false;
      }
    },
    showToast,
  };

  const tabs: Record<TabId, ShareTab> = {
    link: createLinkTab(ctx),
    email: createEmailTab(ctx),
    zotero: createZoteroTab(ctx),
  };
  for (const tab of Object.values(tabs)) {
    tab.el.hidden = true;
    panels.appendChild(tab.el);
  }

  let current: TabId | null = null;

  const movePill = (button: HTMLButtonElement) => {
    pill.style.width = `${button.offsetWidth}px`;
    pill.style.transform = `translateX(${button.offsetLeft}px)`;
    // An overshoot into an end tab would carry the pill past the rail.
    pill.classList.toggle(
      "at-edge",
      button === tabButtons[0] || button === tabButtons[tabButtons.length - 1],
    );
  };

  const select = (id: TabId) => {
    if (id === current) return;
    const previous = current;
    current = id;

    tabButtons.forEach((button) => {
      const selected = button.dataset.tab === id;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) movePill(button);
    });

    ctx.relayout(() => {
      if (previous) tabs[previous].el.hidden = true;
      tabs[id].el.hidden = false;
      tabs[id].onShow?.();
    });
  };

  tabButtons.forEach((button) =>
    button.addEventListener("click", () => select(button.dataset.tab as TabId)),
  );
  tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const index = TABS.findIndex((tab) => tab.id === current);
    const next =
      TABS[
        (index + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length
      ];
    select(next.id);
    tabButtons.find((b) => b.dataset.tab === next.id)?.focus();
  });

  document.body.appendChild(overlay);

  // Place the pill under the first tab without sliding it in from the left.
  pill.style.transition = "none";
  select(originalUrl ? "link" : "email");
  void pill.offsetWidth;
  pill.style.transition = "";

  requestAnimationFrame(() => overlay.classList.add("visible"));

  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    document.removeEventListener("keydown", handleEscape);
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 300);
  };

  document.addEventListener("keydown", handleEscape);
  overlay
    .querySelector(".file-menu-modal-close")!
    .addEventListener("click", close);
  // A click lands on the overlay whenever press and release share no closer
  // ancestor, e.g. a text selection dragged out of the dialog. Only a press
  // that also began on the backdrop closes it.
  let pressedBackdrop = false;
  overlay.addEventListener("pointerdown", (e) => {
    pressedBackdrop = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (pressedBackdrop && e.target === overlay) close();
  });
}
