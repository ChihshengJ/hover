// ============================================
// Hover PDF Viewer - Content Script
// ============================================
//
// Detects when Chrome displays a PDF natively (via content-type),
// fetches the PDF with credentials, and sends to background script
// to open in Hover viewer.

(async function() {
  // Only run in main frame
  if (window !== window.top) return;

  // Check if this is a PDF displayed by Chrome's native viewer
  // Chrome sets document.contentType to 'application/pdf' for PDF files
  // Also check for the embed element Chrome uses
  const isPdfPage =
    document.contentType === "application/pdf" ||
    document.body?.querySelector('embed[type="application/pdf"]') !== null;

  if (!isPdfPage) {
    return;
  }

  console.log("[Hover] PDF page detected:", window.location.href);

  // Don't intercept if we're already in the Hover viewer
  if (window.location.href.includes(chrome.runtime.id)) {
    return;
  }

  try {
    // Check if Hover is enabled
    const statusResponse = await chrome.runtime.sendMessage({
      type: "GET_HOVER_STATUS",
    });
    if (!statusResponse?.enabled) {
      console.log("[Hover] Extension disabled, not intercepting");
      return;
    }

    // Ask background if we should intercept
    const detectResponse = await chrome.runtime.sendMessage({
      type: "PDF_PAGE_DETECTED",
      url: window.location.href,
    });

    if (detectResponse?.action !== "fetch_and_send") {
      console.log(
        "[Hover] Background declined interception:",
        detectResponse?.reason,
      );
      return;
    }

    console.log("[Hover] Fetching PDF with credentials...");

    // Fetch the PDF with credentials - this works because we're same-origin!
    const pdfResponse = await fetch(window.location.href, {
      credentials: "include", // Include cookies for authenticated access
      cache: "force-cache", // Use cached version if available
    });

    if (!pdfResponse.ok) {
      console.error(
        "[Hover] Failed to fetch PDF:",
        pdfResponse.status,
        pdfResponse.statusText,
      );
      return;
    }

    // Verify it's actually a PDF
    const contentType = pdfResponse.headers.get("content-type") || "";
    if (
      !contentType.includes("application/pdf") &&
      !contentType.includes("octet-stream")
    ) {
      console.log("[Hover] Response is not a PDF, content-type:", contentType);
      return;
    }

    const arrayBuffer = await pdfResponse.arrayBuffer();

    // Verify PDF magic bytes
    const header = new Uint8Array(arrayBuffer.slice(0, 5));
    const pdfMagic = String.fromCharCode(...header);
    if (!pdfMagic.startsWith("%PDF-")) {
      console.log("[Hover] Response does not have PDF magic bytes");
      return;
    }

    console.log(
      "[Hover] PDF fetched successfully, size:",
      arrayBuffer.byteLength,
    );

    // Convert to base64 for message passing (chrome.runtime.sendMessage has size limits,
    // but for most PDFs this should be fine. For very large PDFs, we might need chunking)
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64 = btoa(binary);

    // Send to background script
    const result = await chrome.runtime.sendMessage({
      type: "PDF_DATA_READY",
      url: window.location.href,
      data: base64,
      filename: extractFilename(window.location.href),
    });

    if (result?.success) {
      console.log("[Hover] PDF sent to viewer successfully");
    } else {
      console.error("[Hover] Failed to send PDF to viewer:", result?.error);
    }
  } catch (error) {
    console.error("[Hover] Error intercepting PDF:", error);
  }

  function extractFilename(url) {
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop() || "document.pdf";
      // Clean up query params from filename
      const cleanName = filename.split("?")[0];
      return cleanName.endsWith(".pdf") ? cleanName : cleanName + ".pdf";
    } catch {
      return "document.pdf";
    }
  }
})();
