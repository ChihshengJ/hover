// ============================================
// Hover PDF Viewer - Content Script
// ============================================

(function() {
  // Only run in the mainframe
  if (window !== window.top) return;

  const isPdf = document.contentType === "application/pdf";
  if (!isPdf) return;

  if (window.location.href.includes(chrome.runtime.id)) return;

  console.log("[Hover] PDF detected at document_start:", window.location.href);

  // Hide default PDF viewer and show downloading overlay

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
      width: 200px;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      margin-top: 16px;
      overflow: hidden;
    }
    #hover-loading-overlay .hover-progress-bar {
      height: 100%;
      width: 0%;
      background: #A0A0B0;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    @keyframes hover-spin {
      to { transform: rotate(360deg); }
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
    if (progressBar && progress !== undefined) {
      progressBar.style.width = `${Math.min(100, Math.round(progress))}%`;
    }
  }

  // Check status, fetch PDF and send message to background

  (async function intercept() {
    try {
      const statusResponse = await chrome.runtime.sendMessage({
        type: "GET_HOVER_STATUS",
      });

      if (!statusResponse?.enabled) {
        console.log("[Hover] Extension disabled, restoring native viewer");
        restoreNativeViewer();
        return;
      }

      const detectResponse = await chrome.runtime.sendMessage({
        type: "PDF_PAGE_DETECTED",
        url: window.location.href,
      });

      if (detectResponse?.action !== "fetch_and_send") {
        console.log(
          "[Hover] Background declined interception:",
          detectResponse?.reason,
        );
        restoreNativeViewer();
        return;
      }

      updateStatus("Downloading PDF…", 15);

      // Fetch the PDF on the original origin with full credentials
      const pdfResponse = await fetch(window.location.href, {
        credentials: "include",
        cache: "force-cache",
      });

      if (!pdfResponse.ok) {
        console.error(
          "[Hover] Failed to fetch PDF:",
          pdfResponse.status,
          pdfResponse.statusText,
        );
        restoreNativeViewer();
        return;
      }

      // Verify content type
      const contentType = pdfResponse.headers.get("content-type") || "";
      if (
        !contentType.includes("application/pdf") &&
        !contentType.includes("octet-stream")
      ) {
        console.log(
          "[Hover] Response is not a PDF, content-type:",
          contentType,
        );
        restoreNativeViewer();
        return;
      }

      updateStatus("Reading PDF data…", 35);

      const arrayBuffer = await pdfResponse.arrayBuffer();

      // Verify PDF magic bytes
      const header = new Uint8Array(arrayBuffer.slice(0, 5));
      const pdfMagic = String.fromCharCode(...header);
      if (!pdfMagic.startsWith("%PDF-")) {
        console.log("[Hover] Response does not have PDF magic bytes");
        restoreNativeViewer();
        return;
      }

      console.log(
        "[Hover] PDF fetched successfully, size:",
        arrayBuffer.byteLength,
      );

      updateStatus("Preparing for viewer…", 55);

      // Convert to base64 for message passing
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      const base64 = btoa(binary);

      updateStatus("Opening viewer…", 80);

      // Send to background script
      const result = await chrome.runtime.sendMessage({
        type: "PDF_DATA_READY",
        url: window.location.href,
        data: base64,
        filename: extractFilename(window.location.href),
      });

      if (result?.success) {
        updateStatus("Opening viewer…", 100);
        console.log("[Hover] PDF sent to viewer successfully");
      } else {
        console.error("[Hover] Failed to send PDF to viewer:", result?.error);
        restoreNativeViewer();
      }
    } catch (error) {
      console.error("[Hover] Error intercepting PDF:", error);
      restoreNativeViewer();
    }
  })();

  // ===========================================================
  // Helpers
  // ===========================================================

  function restoreNativeViewer() {
    const overlayEl = document.getElementById("hover-loading-overlay");
    if (overlayEl) overlayEl.remove();
    if (hideStyle.parentNode) hideStyle.remove();
  }

  function extractFilename(url) {
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop() || "document.pdf";
      const cleanName = filename.split("?")[0];
      return cleanName.endsWith(".pdf") ? cleanName : cleanName + ".pdf";
    } catch {
      return "document.pdf";
    }
  }
})();
