(function() {
  if (window !== window.top) return;
  if (window.location.href.includes(chrome.runtime.id)) return;

  // ============================================
  // Shared Utilities
  // ============================================

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /**
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  async function fetchAsPdfBase64(url) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "force-cache",
    });
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const header = new Uint8Array(arrayBuffer.slice(0, 5));
    if (!String.fromCharCode(...header).startsWith("%PDF-")) return null;

    return arrayBufferToBase64(arrayBuffer);
  }

  /**
   * @param {string} pageUrl
   * @returns {Promise<{ data: string } | { error: string }>}
   */
  async function findAndFetchPdf(pageUrl) {
    try {
      const direct = await fetchAsPdfBase64(pageUrl);
      if (direct) return { data: direct };

      const candidates = [];

      const pdfIframe = document.getElementById("pdf-iframe");
      if (pdfIframe?.src) candidates.push(pdfIframe.src);

      for (const iframe of document.querySelectorAll("iframe[src]")) {
        if (candidates.includes(iframe.src)) continue;
        try {
          const path = new URL(iframe.src).pathname.toLowerCase();
          if (path.includes("pdf")) candidates.push(iframe.src);
        } catch { }
      }

      for (const embed of document.querySelectorAll(
        'embed[type="application/pdf"]',
      )) {
        if (embed.src && !candidates.includes(embed.src)) {
          candidates.push(embed.src);
        }
      }

      for (const candidateUrl of candidates) {
        const data = await fetchAsPdfBase64(candidateUrl);
        if (data) return { data };
      }

      return { error: "No PDF found on this page" };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ============================================
  // On-Demand Fetch (for "Open Current Tab")
  // ============================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FETCH_PDF_FROM_PAGE") {
      findAndFetchPdf(window.location.href).then(sendResponse);
      return true;
    }
  });

  // ============================================
  // Auto-Interception (PDF pages only)
  // ============================================

  if (document.contentType !== "application/pdf") return;

  console.log("[Hover] PDF detected at document_start:", window.location.href);

  const hideStyle = document.createElement("style");
  hideStyle.textContent = `
    body, embed[type="application/pdf"] {
      display: none !important;
      visibility: hidden !important;
    }
    #hover-loading-overlay {
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: #1C1C1E;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #E5E5EA;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    #hover-loading-overlay .hover-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(255, 255, 255, 0.12);
      border-top-color: #A0A0B0;
      border-radius: 50%;
      animation: hover-spin 0.8s linear infinite;
      margin-bottom: 20px;
    }
    #hover-loading-overlay .hover-title {
      font-size: 15px;
      font-weight: 500;
      color: #E5E5EA;
      margin-bottom: 6px;
      letter-spacing: 0.01em;
    }
    #hover-loading-overlay .hover-status {
      font-size: 13px;
      color: #8E8E93;
      transition: opacity 0.2s ease;
    }
    #hover-loading-overlay .hover-progress-track {
      position: relative;
      width: 200px;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      margin-top: 16px;
      overflow: hidden;
    }
    #hover-loading-overlay .hover-progress-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 0%;
      background: #A0A0B0;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    #hover-loading-overlay .hover-progress-bar.indeterminate {
      width: 30%;
      animation: hover-indeterminate 1.5s ease-in-out infinite;
    }
    @keyframes hover-spin {
      to { transform: rotate(360deg); }
    }
    @keyframes hover-indeterminate {
      0% { left: 0%; width: 30%; }
      50% { left: 35%; width: 35%; }
      100% { left: 70%; width: 30%; }
    }
  `;
  document.documentElement.appendChild(hideStyle);

  const overlay = document.createElement("div");
  overlay.id = "hover-loading-overlay";
  overlay.innerHTML = `
    <div class="hover-spinner"></div>
    <div class="hover-title">Hover</div>
    <div class="hover-status" id="hover-status-text">Preparing document…</div>
    <div class="hover-progress-track">
      <div class="hover-progress-bar" id="hover-progress-bar"></div>
    </div>
  `;
  document.documentElement.appendChild(overlay);

  function updateStatus(text, progress) {
    const statusEl = document.getElementById("hover-status-text");
    const progressBar = document.getElementById("hover-progress-bar");
    if (statusEl) statusEl.textContent = text;
    if (progressBar) {
      if (progress === undefined) {
        progressBar.classList.add("indeterminate");
        progressBar.style.width = "";
      } else {
        progressBar.classList.remove("indeterminate");
        progressBar.style.width = `${Math.min(100, Math.round(progress))}%`;
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PDF_PROGRESS") {
      updateStatus("Downloading PDF…", msg.percent);
    }
  });

  function restoreNativeViewer() {
    const overlayEl = document.getElementById("hover-loading-overlay");
    if (overlayEl) overlayEl.remove();
    if (hideStyle.parentNode) hideStyle.remove();
  }

  function showFileAccessPrompt() {
    const el = document.getElementById("hover-loading-overlay");
    if (!el) return;

    el.innerHTML = `
      <div style="max-width: 400px; text-align: center; padding: 24px;">
        <div style="font-size: 28px; margin-bottom: 16px;">📄</div>
        <div style="font-size: 15px; font-weight: 600; color: #E5E5EA; margin-bottom: 8px;">
          Local File Access Required
        </div>
        <div style="font-size: 13px; color: #8E8E93; line-height: 1.6; margin-bottom: 20px;">
          To open local PDF files, Hover needs file access permission.
          Enable <strong style="color: #E5E5EA;">"Allow access to file URLs"</strong>
          in your extension settings.
        </div>
        <div style="display: flex; gap: 10px; justify-content: center;">
          <button id="hover-open-settings" style="
            background: #3A3A3C; color: #E5E5EA; border: none;
            padding: 8px 16px; border-radius: 8px; font-size: 13px;
            cursor: pointer; font-weight: 500;
          ">Open Extension Settings</button>
          <button id="hover-use-native" style="
            background: transparent; color: #8E8E93; border: 1px solid #3A3A3C;
            padding: 8px 16px; border-radius: 8px; font-size: 13px;
            cursor: pointer;
          ">Use Default Viewer</button>
        </div>
      </div>
    `;

    document
      .getElementById("hover-open-settings")
      ?.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "OPEN_EXTENSION_SETTINGS" });
      });

    document
      .getElementById("hover-use-native")
      ?.addEventListener("click", () => {
        restoreNativeViewer();
      });
  }

  (async function intercept() {
    try {
      updateStatus("Connecting…");

      const detectResponse = await chrome.runtime.sendMessage({
        type: "PDF_PAGE_DETECTED",
        url: window.location.href,
      });

      if (detectResponse?.action === "none") {
        restoreNativeViewer();
        return;
      }

      if (detectResponse?.action === "done") {
        updateStatus("Opening viewer…", 100);
        return;
      }

      if (detectResponse?.action === "file_access_denied") {
        showFileAccessPrompt();
        return;
      }

      updateStatus("Downloading PDF…", 15);
      const pdfResponse = await fetch(window.location.href, {
        credentials: "include",
        cache: "force-cache",
      });

      if (!pdfResponse.ok) {
        restoreNativeViewer();
        return;
      }

      const contentType = pdfResponse.headers.get("content-type") || "";
      if (
        !contentType.includes("application/pdf") &&
        !contentType.includes("octet-stream")
      ) {
        restoreNativeViewer();
        return;
      }

      updateStatus("Reading PDF data…", 35);
      const arrayBuffer = await pdfResponse.arrayBuffer();

      const header = new Uint8Array(arrayBuffer.slice(0, 5));
      if (!String.fromCharCode(...header).startsWith("%PDF-")) {
        restoreNativeViewer();
        return;
      }

      updateStatus("Preparing for viewer…", 55);
      const base64 = arrayBufferToBase64(arrayBuffer);

      updateStatus("Opening viewer…", 80);
      const result = await chrome.runtime.sendMessage({
        type: "PDF_DATA_READY",
        url: window.location.href,
        data: base64,
      });

      if (result?.success) {
        updateStatus("Opening viewer…", 100);
      } else {
        restoreNativeViewer();
      }
    } catch (error) {
      console.error("[Hover] Error intercepting PDF:", error);
      restoreNativeViewer();
    }
  })();
})();
