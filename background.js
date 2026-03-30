// ============================================
// Hover PDF Viewer - Background Script
// ============================================

let bypassUrls = new Set();

// ============================================
// Pending PDF Storage (IndexedDB)
// ============================================

const PENDING_DB_NAME = "hover-pending-pdf";
const PENDING_DB_STORE = "data";

/**
 * @returns {Promise<IDBDatabase>}
 */
function openPendingDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB_NAME, 1);
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore(PENDING_DB_STORE);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {{ data: ArrayBuffer, name: string, url: string|null }} record
 */
async function storePendingPdf(record) {
  const db = await openPendingDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_DB_STORE, "readwrite");
    tx.objectStore(PENDING_DB_STORE).put(record, "pending");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = (e) => {
      db.close();
      reject(e.target.error);
    };
  });
}

// ============================================
// Utilities
// ============================================

/**
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
  const raw = base64.includes(",") ? base64.split(",")[1] : base64;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * @param {string} url
 * @returns {string}
 */
function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const segment = pathname.split("/").pop() || "document.pdf";
    const cleaned = segment.split("?")[0];
    return cleaned.endsWith(".pdf") ? cleaned : cleaned + ".pdf";
  } catch {
    return "document.pdf";
  }
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
function hasPdfMagic(buffer) {
  if (buffer.byteLength < 5) return false;
  const header = new Uint8Array(buffer.slice(0, 5));
  return String.fromCharCode(...header).startsWith("%PDF-");
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

  if (message.type === "PDF_PAGE_DETECTED") {
    handlePdfPageDetected(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "PDF_DATA_READY") {
    handlePdfDataReady(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
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
    handleStoreLocalPdf(message)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "FETCH_TAB_AS_PDF") {
    handleFetchTabAsPdf(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
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
// PDF Interception
// ============================================

/**
 * @param {{ url: string }} message
 * @param {chrome.runtime.MessageSender} sender
 */
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

  const url = message.url;
  const isLocal = url.startsWith("file:");
  const canDirectFetch =
    url.startsWith("http:") || url.startsWith("https:") || isLocal;

  if (!canDirectFetch) {
    return { action: "content_fetch" };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return { action: "content_fetch" };

    const arrayBuffer = await response.arrayBuffer();
    if (!hasPdfMagic(arrayBuffer)) return { action: "content_fetch" };

    await storePendingPdf({
      data: arrayBuffer,
      url: url,
      name: extractFilename(url),
    });

    const viewerUrl =
      chrome.runtime.getURL("index.html") + "?url=" + encodeURIComponent(url);
    await chrome.tabs.update(sender.tab.id, { url: viewerUrl });

    return { action: "done" };
  } catch {
    return { action: isLocal ? "file_access_denied" : "content_fetch" };
  }
}

/**
 * @param {{ url: string, data: string }} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function handlePdfDataReady(message, sender) {
  const { url, data } = message;

  const arrayBuffer = base64ToArrayBuffer(data);
  await storePendingPdf({
    data: arrayBuffer,
    url: url,
    name: extractFilename(url),
  });

  const viewerUrl =
    chrome.runtime.getURL("index.html") + "?url=" + encodeURIComponent(url);
  await chrome.tabs.update(sender.tab.id, { url: viewerUrl });

  return { success: true };
}

/**
 * @param {{ data: string, name: string }} message
 */
async function handleStoreLocalPdf(message) {
  const arrayBuffer = base64ToArrayBuffer(message.data);
  await storePendingPdf({
    data: arrayBuffer,
    name: message.name || "document.pdf",
    url: null,
  });
}

/**
 * @param {{ url: string, tabId: number }} message
 */
async function handleFetchTabAsPdf(message) {
  const { url, tabId } = message;

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "FETCH_PDF_FROM_PAGE",
    });

    if (result?.error) {
      return { success: false, error: result.error };
    }

    const arrayBuffer = base64ToArrayBuffer(result.data);
    await storePendingPdf({
      data: arrayBuffer,
      url: url,
      name: extractFilename(url),
    });

    const viewerUrl =
      chrome.runtime.getURL("index.html") + "?url=" + encodeURIComponent(url);
    await chrome.tabs.update(tabId, { url: viewerUrl });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================
// Toggle Handler
// ============================================

async function handleToggle(enabled) {
  await chrome.storage.local.set({ hoverEnabled: enabled });

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
        // ignore
      }
      break;
    }
  }

  return { success: true, enabled, currentPdfUrl: originalPdfUrl, viewerTabId };
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
// Network Fetch Helpers
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
  if (!response.ok)
    throw new Error(`Scholar request failed: ${response.status}`);
  return { html: await response.text(), query };
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
  if (!response.ok)
    throw new Error(`Citation request failed: ${response.status}`);
  return { html: await response.text(), paperId };
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
  if (!response.ok)
    throw new Error(`${query} request failed: ${response.status}`);
  return { html: await response.text(), query };
}
