// ============================================
// Hover PDF Viewer - Background Script
// ============================================
//
// Handles PDF interception via two mechanisms:
// 1. Port-based transfer: content script fetches PDF with credentials
//    on the original origin and streams raw bytes (no base64) via a
//    chrome.runtime.connect() port.
// 2. Pre-warm: webRequest.onHeadersReceived detects PDF responses and
//    pre-fetches the WASM module so it's cached when the viewer opens.

// Temporary storage for intercepted PDF data
let pendingPdfData = null;
let localPdfData = null;

// ============================================
// Port-based PDF Transfer (Phase 2)
// ============================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pdf-transfer") return;

  let meta = null;
  const chunks = [];
  let receivedBytes = 0;

  port.onMessage.addListener((msg) => {
    if (msg.type === "meta") {
      meta = msg;
      console.log(
        `[Hover BG] PDF transfer started: ${meta.filename} (${formatBytes(meta.size)})`,
      );
    } else if (msg.type === "chunk") {
      // msg.data is a Uint8Array (structured cloning in MV3)
      const chunk = new Uint8Array(msg.data);
      chunks.push(chunk);
      receivedBytes += chunk.length;
    } else if (msg.type === "done") {
      if (!meta) {
        console.error("[Hover BG] Received 'done' without metadata");
        return;
      }

      console.log(
        `[Hover BG] Transfer complete: ${receivedBytes} bytes in ${chunks.length} chunks`,
      );

      // Reassemble chunks into a single Uint8Array
      const assembled = new Uint8Array(meta.size);
      let offset = 0;
      for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.length;
      }

      // Store for viewer retrieval — raw bytes, no base64
      pendingPdfData = {
        data: assembled,
        url: meta.url,
        name: meta.filename,
      };

      // Redirect the sender tab to the viewer
      const viewerUrl =
        chrome.runtime.getURL("index.html") + "?source=intercepted";

      if (port.sender?.tab?.id) {
        chrome.tabs
          .update(port.sender.tab.id, { url: viewerUrl })
          .then(() => {
            // Confirm redirect to content script (it may already be navigating away)
            try {
              port.postMessage({ type: "redirect" });
            } catch {
              // Port may have disconnected — that's fine
            }
          })
          .catch((err) => {
            console.error("[Hover BG] Failed to redirect tab:", err);
          });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    // Normal — tab navigated to viewer, port disconnects
    // If we never got 'done', something went wrong
    if (meta && receivedBytes < meta.size) {
      console.warn(
        `[Hover BG] Port disconnected before transfer complete (${receivedBytes}/${meta.size} bytes)`,
      );
    }
  });
});

// ============================================
// Pre-warm: Cache WASM on PDF Detection (Phase 3)
// ============================================

// When we see a PDF response header on a main_frame navigation,
// pre-fetch the WASM binary so it's in the HTTP cache when the
// viewer loads. This runs in parallel with the content script's
// fetch, shaving ~200-500ms off WASM init.

try {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.type !== "main_frame") return;

      const contentTypeHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type",
      );
      const contentType = contentTypeHeader?.value || "";

      if (
        contentType.includes("application/pdf") ||
        contentType.includes("application/x-pdf")
      ) {
        console.log("[Hover BG] PDF response detected, pre-warming WASM cache");

        // Fire-and-forget: pre-fetch WASM binary into HTTP cache.
        // The viewer will hit the cache when it loads.
        fetch(chrome.runtime.getURL("pdfium.wasm")).catch(() => {
          // Ignore errors — this is just an optimization
        });
      }
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"],
  );
} catch (error) {
  // webRequest may not be available if permissions aren't granted yet.
  // The extension still works — just without pre-warming.
  console.warn("[Hover BG] webRequest listener not available:", error.message);
}

// ============================================
// Message Handlers
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TOGGLE_HOVER") {
    handleToggle(message.enabled)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Legacy: Content script detected a PDF page (kept for backward compat)
  if (message.type === "PDF_PAGE_DETECTED") {
    handlePdfPageDetected(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Legacy: Content script sending base64 PDF data (kept for backward compat)
  if (message.type === "PDF_DATA_READY") {
    handlePdfDataReady(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Viewer requesting the pending PDF data
  if (message.type === "GET_PENDING_PDF") {
    const data = pendingPdfData;
    pendingPdfData = null; // Clear after retrieval
    sendResponse({ success: true, data });
    return true;
  }

  if (message.type === "FETCH_SCHOLAR") {
    fetchGoogleScholar(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === "FETCH_CITE") {
    fetchGoogleScholarCite(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === "FETCH_WEB") {
    fetchWebsite(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === "STORE_LOCAL_PDF") {
    localPdfData = {
      data: message.data,
      name: message.name,
    };
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "GET_LOCAL_PDF") {
    sendResponse({
      success: true,
      data: localPdfData,
    });
    localPdfData = null;
    return true;
  }

  if (message.type === "GET_HOVER_STATUS") {
    chrome.storage.local.get("hoverEnabled").then(({ hoverEnabled = true }) => {
      sendResponse({ enabled: hoverEnabled });
    });
    return true;
  }
});

// ============================================
// PDF Page Detection Handlers (Legacy)
// ============================================

async function handlePdfPageDetected(message, sender) {
  const { hoverEnabled = true } =
    await chrome.storage.local.get("hoverEnabled");

  if (!hoverEnabled) {
    return { action: "none", reason: "disabled" };
  }

  return { action: "fetch_and_send" };
}

async function handlePdfDataReady(message, sender) {
  const { url, data, filename } = message;

  // Legacy path: base64 data from old content script.
  // Convert to Uint8Array for consistency with new path.
  let pdfBytes;
  if (typeof data === "string") {
    // base64 encoded
    const binary = atob(data);
    pdfBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      pdfBytes[i] = binary.charCodeAt(i);
    }
  } else {
    pdfBytes = new Uint8Array(data);
  }

  pendingPdfData = {
    data: pdfBytes,
    url: url,
    name: filename || extractFilename(url),
  };

  const viewerUrl = chrome.runtime.getURL("index.html") + "?source=intercepted";

  await chrome.tabs.update(sender.tab.id, { url: viewerUrl });

  return { success: true };
}

function extractFilename(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop() || "document.pdf";
    return filename.endsWith(".pdf") ? filename : filename + ".pdf";
  } catch {
    return "document.pdf";
  }
}

// ============================================
// Toggle Handler
// ============================================

async function handleToggle(enabled) {
  await chrome.storage.local.set({ hoverEnabled: enabled });

  const viewerUrl = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});

  let currentPdfUrl = null;
  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith(viewerUrl)) {
      const url = new URL(tab.url);
      currentPdfUrl = url.searchParams.get("file");
      break;
    }
  }

  return {
    success: true,
    enabled,
    currentPdfUrl,
  };
}

// ============================================
// Initialization
// ============================================

chrome.runtime.onInstalled.addListener(async () => {
  const { hoverEnabled } = await chrome.storage.local.get("hoverEnabled");
  if (hoverEnabled === undefined) {
    await chrome.storage.local.set({ hoverEnabled: true });
  }
  console.log("Hover PDF Viewer installed");
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("Hover PDF Viewer started");
});

// ============================================
// Scholar Fetch Functions
// ============================================

async function fetchGoogleScholar(query) {
  const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`;

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Scholar request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, query };
}

async function fetchGoogleScholarCite(paperId) {
  const citeUrl = `https://scholar.google.com/scholar?q=info:${paperId}:scholar.google.com/&output=cite&hl=en`;

  const response = await fetch(citeUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Citation request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, paperId };
}

async function fetchWebsite(query) {
  const response = await fetch(query, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`${query} request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, query };
}

// ============================================
// Utilities
// ============================================

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
