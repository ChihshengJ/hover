// ============================================
// Hover PDF Viewer - Background Script
// ============================================
//
// Content-type based PDF interception:
// - Content script detects when Chrome displays a PDF natively
// - Content script fetches PDF with credentials (same-origin)
// - Background receives PDF data and opens in Hover viewer
//
// Optional optimization:
// - webRequest.onHeadersReceived pre-caches WASM on PDF detection

// Temporary storage for intercepted PDF data
let pendingPdfData = null;
let localPdfData = null;

// ============================================
// Optional: Pre-warm WASM cache on PDF detection
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
  // webRequest may not be available — extension still works without it
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
// PDF Page Detection Handlers
// ============================================

async function handlePdfPageDetected(message, sender) {
  const { hoverEnabled = true } =
    await chrome.storage.local.get("hoverEnabled");

  if (!hoverEnabled) {
    return { action: "none", reason: "disabled" };
  }

  // Tell content script to fetch the PDF with credentials and send it back
  return { action: "fetch_and_send" };
}

async function handlePdfDataReady(message, sender) {
  const { url, data, filename } = message;

  // Store the PDF data temporarily
  pendingPdfData = {
    data: data, // Base64 encoded
    url: url,
    name: filename || extractFilename(url),
  };

  // Open the viewer in the same tab
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
