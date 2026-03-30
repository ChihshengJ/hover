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
 * Open the shared IndexedDB used to pass PDF ArrayBuffers from
 * the background service-worker to the viewer page. Both run on
 * the same chrome-extension:// origin, so they share this store.
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
 * Write a PDF record to IndexedDB under a fixed key so the viewer
 * page can retrieve it on load without a message round-trip.
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

/**
 * Decode a base64 string (with optional data-URI prefix) to ArrayBuffer.
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
    handlePdfPageDetected(message)
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
 * Decide whether to intercept a detected PDF page.
 * Combines the status check and detection decision into a single
 * round-trip so content.js doesn't need a separate GET_HOVER_STATUS.
 */
async function handlePdfPageDetected(message) {
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

/**
 * Receive base64-encoded PDF from content.js, decode it to an
 * ArrayBuffer, persist in IndexedDB, and open the viewer in a new
 * tab adjacent to the source. Navigates the original tab back so
 * the user returns to the page they clicked from.
 */
async function handlePdfDataReady(message, sender) {
  const { url, data, filename } = message;

  const arrayBuffer = base64ToArrayBuffer(data);
  await storePendingPdf({
    data: arrayBuffer,
    url: url,
    name: filename || extractFilename(url),
  });

  const viewerUrl =
    chrome.runtime.getURL("index.html") + "?url=" + encodeURIComponent(url);

  await chrome.tabs.update(sender.tab.id, { url: viewerUrl });

  return { success: true };
}

/**
 * Persist a PDF uploaded from the extension popup into IndexedDB.
 * The popup handles navigation to the viewer separately.
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
 * Inject a script into the active tab to grab the PDF bytes.
 * First tries fetching the page URL itself from cache. If the
 * response isn't a PDF (e.g. Wiley/Elsevier HTML wrappers), it
 * looks for an embedded iframe or embed element whose src points
 * to the actual PDF and fetches that instead.
 */
async function handleFetchTabAsPdf(message) {
  const { url, tabId } = message;

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (pageUrl) => {
      async function fetchAsPdf(targetUrl) {
        const response = await fetch(targetUrl, {
          credentials: "include",
          cache: "force-cache",
        });
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        const header = new Uint8Array(arrayBuffer.slice(0, 5));
        const magic = String.fromCharCode(...header);
        if (!magic.startsWith("%PDF-")) return null;

        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(
            i,
            Math.min(i + chunkSize, bytes.length),
          );
          binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
      }

      try {
        // 1. Try the page URL directly (works for cached direct PDFs)
        const direct = await fetchAsPdf(pageUrl);
        if (direct) return { data: direct };

        // 2. Look for a PDF embedded in an iframe or embed element
        const candidates = [];

        // Named PDF iframes (Wiley uses #pdf-iframe)
        const pdfIframe = document.getElementById("pdf-iframe");
        if (pdfIframe?.src) candidates.push(pdfIframe.src);

        // Any iframe whose src path contains "pdf"
        for (const iframe of document.querySelectorAll("iframe[src]")) {
          if (candidates.includes(iframe.src)) continue;
          try {
            const path = new URL(iframe.src).pathname.toLowerCase();
            if (path.includes("pdf")) candidates.push(iframe.src);
          } catch { }
        }

        // Embed elements with PDF type
        for (const embed of document.querySelectorAll(
          'embed[type="application/pdf"]',
        )) {
          if (embed.src && !candidates.includes(embed.src)) {
            candidates.push(embed.src);
          }
        }

        for (const candidateUrl of candidates) {
          const data = await fetchAsPdf(candidateUrl);
          if (data) return { data };
        }

        return { error: "No PDF found on this page" };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [url],
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
}

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
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
