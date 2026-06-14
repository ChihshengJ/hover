import { ingestFile } from "../ingest.js";

/**
 * Viewer empty state — shown when the viewer opens with no PDF to display
 * (e.g. the popup's "Open Local PDF" lands here, or a fresh viewer tab).
 *
 * It hosts the local file picker so the picker runs inside this persistent
 * tab. A browser-action popup is torn down the instant the native file dialog
 * opens on Firefox, so its `change` event never fires — the picker has to live
 * in a tab where the user gesture survives. This is the same reason FileMenu's
 * in-viewer Import works across browsers.
 */
export class EmptyState {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    this.#injectStyles();
    this.#render();
  }

  #render() {
    const wrap = document.createElement("div");
    wrap.className = "hover-empty-state";
    wrap.innerHTML = `
      <div class="hover-empty-card">
        <div class="hover-empty-icon">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="18" x2="12" y2="12"/>
            <polyline points="9 15 12 12 15 15"/>
          </svg>
        </div>
        <div class="hover-empty-title">Open a PDF</div>
        <div class="hover-empty-subtitle">Choose a file to start reading in Hover</div>
        <button class="hover-empty-btn" id="hover-empty-open">Choose PDF…</button>
        <input type="file" id="hover-empty-input" accept="application/pdf" hidden />
      </div>
    `;
    this.container.appendChild(wrap);

    const input = wrap.querySelector("#hover-empty-input");
    wrap.querySelector("#hover-empty-open").addEventListener("click", () => {
      input.value = "";
      input.click();
    });
    input.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await ingestFile(file);
        // Reload the viewer so it drains the pending store and renders.
        window.location.href = window.location.pathname;
      } catch (err) {
        console.error("[Hover] Failed to open PDF:", err);
      }
    });
  }

  #injectStyles() {
    if (document.getElementById("hover-empty-state-styles")) return;
    const style = document.createElement("style");
    style.id = "hover-empty-state-styles";
    style.textContent = `
      .hover-empty-state {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .hover-empty-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 40px 48px;
        border-radius: 16px;
        color: #3A3A3C;
      }
      .hover-empty-icon { color: #B0B0B8; margin-bottom: 18px; }
      .hover-empty-title { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
      .hover-empty-subtitle { font-size: 13px; color: #8E8E93; margin-bottom: 22px; }
      .hover-empty-btn {
        background: #3A3A3C;
        color: #fff;
        border: none;
        padding: 10px 22px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .hover-empty-btn:hover { background: #4A4A4C; }
      body.night-mode .hover-empty-card { color: #E5E5EA; }
      body.night-mode .hover-empty-btn { background: #E5E5EA; color: #1C1C1E; }
      body.night-mode .hover-empty-btn:hover { background: #fff; }
    `;
    document.head.appendChild(style);
  }
}
