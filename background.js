// ============================================
// Hover PDF Viewer - Background Script
// ============================================

let pendingPdfData = null;
let localPdfData = null;
let bypassUrls = new Set();

// ============================================
// Pre-warm WASM cache on PDF detection
// ============================================

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
        // Fire-and-forget: pre-fetch WASM binary into HTTP cache
        // so it's ready when the viewer opens
        fetch(chrome.runtime.getURL("pdfium.wasm")).catch(() => { });
      }
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"],
  );
} catch (error) {
  console.warn("[Hover BG] webRequest listener error:", error.message);
}

// ============================================
// Message Handlers
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "BYPASS_NEXT") {
    bypassUrls.add(message.url);
    setTimeout(() => bypassUrls.delete(message.url), 5000);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "TOGGLE_HOVER") {
    handleToggle(message.enabled)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Content script detected a PDF page
  if (message.type === "PDF_PAGE_DETECTED") {
    handlePdfPageDetected(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Content script sending PDF data after fetching with credentials
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

  // Fetch local document
  if (message.type === "FETCH_LOCAL_FILE") {
    fetchLocalFile(message.url)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message }));
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

  if (message.type === "OPEN_EXTENSION_SETTINGS") {
    chrome.tabs.create({
      url: `chrome://extensions/?id=${chrome.runtime.id}`,
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "CHECK_FILE_ACCESS") {
    chrome.extension.isAllowedFileSchemeAccess().then((allowed) => {
      sendResponse({ allowed });
    });
    return true;
  }
});

// ============================================
// PDF Page Detection Handlers
// ============================================

async function handlePdfPageDetected(message, sender) {
  const { hoverEnabled = true } =
    await chrome.storage.local.get("hoverEnabled");
  if (!hoverEnabled) {
    return { action: "none", reason: "disabled" };
  }
  if (bypassUrls.has(message.url)) {
    bypassUrls.delete(message.url);
    return { action: "none", reason: "bypass" };
  }
  return { action: "fetch_and_send" };
}

async function handlePdfDataReady(message, sender) {
  const { url, data, filename } = message;

  pendingPdfData = {
    data: data, // Base64
    url: url,
    name: filename || extractFilename(url),
  };

  const viewerUrl =
    chrome.runtime.getURL("index.html") + "?url=" + encodeURIComponent(url);
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

  // Find the original PDF URL from any open Hover viewer tab
  const viewerBase = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});

  let originalPdfUrl = null;
  let viewerTabId = null;

  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith(viewerBase)) {
      try {
        const parsed = new URL(tab.url);
        originalPdfUrl =
          parsed.searchParams.get("url") ||
          parsed.searchParams.get("file") ||
          null;
        viewerTabId = tab.id;
      } catch {
        // ignore parse errors
      }
      break;
    }
  }

  return {
    success: true,
    enabled,
    currentPdfUrl: originalPdfUrl,
    viewerTabId,
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

async function fetchLocalFile(fileUrl) {
  try {
    const response = await fetch(fileUrl);
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return { success: true, data: btoa(binary) };
  } catch (error) {
    return { success: false, error: "FILE_ACCESS_DENIED" };
  }
}

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
