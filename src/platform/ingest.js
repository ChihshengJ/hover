/**
 * Layer 1 — PDF source ingestion (page side).
 *
 * Every UI entry point (popup picker, in-viewer import, drag & drop, dev URL)
 * acquires PDF bytes in its own way, then hands them to the single pending-PDF
 * store that the viewer drains on load. Acquisition differs per entry point;
 * the hand-off contract — a `{ data, name, url }` record under the key
 * "pending" — does not. Keep all of that contract knowledge here so callers
 * only have to produce a File / bytes and decide how to open the viewer.
 *
 * That includes the draining half: `resolvePdfSource()` below is the viewer's
 * only question ("what am I opening?"), and it is answered here because every
 * answer involves this store.
 *
 * @typedef {Object} PendingRecord
 * @property {ArrayBuffer} data
 * @property {string} name
 * @property {string|null} url
 *
 * @typedef {Object} LoadProgress
 * @property {number} loaded
 * @property {number} total - -1 when the length is unknown
 * @property {number} percent
 * @property {string} phase
 */

import { arrayBufferToBase64 } from "./util/base64.js";

const PENDING_DB_NAME = "hover-pending-pdf";
const PENDING_DB_STORE = "data";

/** The URL a dev-mode viewer opens when nothing else was asked for. */
const DEV_DEFAULT_PDF_URL = "https://arxiv.org/pdf/2501.19393";

/**
 * True anywhere the extension APIs exist — popup and content script included.
 * `isExtensionContext()` is the stricter viewer-only test.
 */
function inExtension() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

/**
 * True only in the packaged viewer page, as opposed to the dev server. The
 * protocol check is what separates the two: `chrome.runtime.id` is also
 * present in a content script running on an ordinary http page.
 *
 * @returns {boolean}
 */
export function isExtensionContext() {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.runtime?.id &&
    ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(
      window.location.protocol,
    )
  );
}

/**
 * Write a pending record straight to IndexedDB from the current page context.
 * Used only in dev, where there's no background to message; in the extension
 * the background owns the write so a single context manages the DB.
 * @param {{ data: ArrayBuffer, name: string, url: string|null }} record
 * @returns {Promise<void>}
 */
function parkInPage(record) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB_NAME, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(PENDING_DB_STORE);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(PENDING_DB_STORE, "readwrite");
      tx.objectStore(PENDING_DB_STORE).put(record, "pending");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Park PDF bytes in the pending store for the viewer to pick up.
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} name
 * @param {string|null} [url]
 * @returns {Promise<void>}
 */
export async function parkPdfBytes(arrayBuffer, name, url = null) {
  if (inExtension()) {
    await chrome.runtime.sendMessage({
      type: "STORE_LOCAL_PDF",
      data: arrayBufferToBase64(arrayBuffer),
      name,
    });
  } else {
    await parkInPage({ data: arrayBuffer, name, url });
  }
}

/**
 * Ingest a File (popup picker, in-viewer import, drag & drop) into the pending
 * store. Does not navigate — the caller decides whether to open a new tab or
 * reload the current viewer.
 * @param {File} file
 * @returns {Promise<void>}
 */
export async function ingestFile(file) {
  if (!file) throw new Error("No file provided");
  if (file.type !== "application/pdf") throw new Error("Not a PDF file");
  const arrayBuffer = await file.arrayBuffer();
  await parkPdfBytes(arrayBuffer, file.name);
}

// ============================================
// Draining: what is this viewer opening?
// ============================================

/**
 * Read and clear the pending record. Reading is destructive by design — the
 * bytes belong to exactly one viewer load, and leaving them behind would make
 * a plain reload reopen a document the user already closed.
 *
 * @returns {Promise<PendingRecord|null>}
 */
function consumePendingPdf() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PENDING_DB_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(PENDING_DB_STORE, "readwrite");
      const store = tx.objectStore(PENDING_DB_STORE);
      const getReq = store.get("pending");
      store.delete("pending");
      tx.oncomplete = () => {
        db.close();
        resolve(getReq.result || null);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/**
 * Fetch a PDF over the network, reporting download progress when the server
 * gives us a content-length to measure against.
 *
 * @param {string} url
 * @param {(p: LoadProgress) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchPdfFromUrl(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : -1;

  if (!(total > 0 && response.body)) {
    return await response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;

    if (onProgress) {
      const percent = Math.round((loaded / total) * 100);
      onProgress({ loaded, total, percent, phase: "downloading" });
    }
  }

  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined.buffer;
}

/** The `?file=` / `?url=` a dev-server viewer was opened with. */
export function getDevUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("file") || urlParams.get("url");
}

/** The `?url=` the extension viewer was opened with, if any. */
export function getIntendedUrl() {
  if (!isExtensionContext()) return getDevUrl();
  return new URLSearchParams(window.location.search).get("url");
}

/**
 * Derive a display name from a URL, ignoring any query string.
 * @param {string} url
 */
function nameFromUrl(url) {
  return url.split("/").pop()?.split("?")[0] || "document.pdf";
}

/**
 * Answer the viewer's one question: what document am I opening, and where did
 * it come from?
 *
 * Four sources, in the order they are tried:
 *
 *   1. The pending store — Chrome/Safari park bytes there from the content
 *      script before the viewer tab even exists.
 *   2. The background, asked to fetch `?url=` into the pending store. Firefox
 *      lands here: its webRequest redirect gives a URL and nothing parked.
 *      Routing through the store keeps one viewer code path across browsers,
 *      and keeps bytes on the UTF-8-safe buffer route.
 *   3. A direct fetch of `?url=`, if the background hand-off produced nothing —
 *      a messaging hiccup or an event-page restart should still render.
 *   4. Dev only: the `?file=`/`?url=` param, then the pending store, then a
 *      default paper, so `bun dev` always shows something.
 *
 * `null` means there is nothing to open. In the extension that is the normal
 * landing for a viewer opened with nothing queued; the caller shows its empty
 * state. In dev it means every source came up empty, which is an error.
 *
 * @param {{
 *   onStatus?: (message: string, fraction?: number) => void,
 *   onProgress?: (p: LoadProgress) => void,
 * }} [hooks] - `onStatus` reports a phase, with a 0-1 fraction when one is
 *   known and nothing when the wait is indeterminate; `onProgress` carries the
 *   byte-level detail of a direct fetch.
 * @returns {Promise<PendingRecord|null>}
 */
export async function resolvePdfSource({
  onStatus = () => {},
  onProgress,
} = {}) {
  const intendedUrl = getIntendedUrl();

  if (isExtensionContext()) {
    let pending = await consumePendingPdf();

    if (!pending && intendedUrl) {
      onStatus("Downloading document...");
      pending = await parkViaBackground(intendedUrl, onStatus);
    }

    if (pending) {
      console.log("[Ingest] Loading PDF from IDB:", pending.name);
      return { ...pending, url: pending.url || null };
    }

    if (intendedUrl) {
      console.log("[Ingest] Falling back to viewer-side fetch:", intendedUrl);
      onStatus("Downloading document...");
      return {
        data: await fetchPdfFromUrl(intendedUrl, onProgress),
        name: nameFromUrl(intendedUrl),
        url: intendedUrl,
      };
    }

    return null;
  }

  const devUrl = getDevUrl();
  if (devUrl) {
    console.log("[Ingest] DEV MODE - Loading from URL:", devUrl);
    onStatus("Downloading document...");
    return {
      data: await fetchPdfFromUrl(devUrl, onProgress),
      name: nameFromUrl(devUrl),
      url: devUrl,
    };
  }

  const pending = await consumePendingPdf();
  if (pending) {
    console.log("[Ingest] DEV MODE - Loading from IDB:", pending.name);
    return { ...pending, url: pending.url || null };
  }

  console.log("[Ingest] DEV MODE - No URL specified, loading default paper");
  return {
    data: await fetchPdfFromUrl(DEV_DEFAULT_PDF_URL, onProgress),
    name: "default.pdf",
    url: DEV_DEFAULT_PDF_URL,
  };
}

/**
 * Ask the background to fetch a URL into the pending store, then drain it.
 * Returns null if the hand-off failed for any reason — the caller has a
 * direct-fetch fallback.
 *
 * @param {string} url
 * @param {(message: string, fraction?: number) => void} onStatus
 * @returns {Promise<PendingRecord|null>}
 */
async function parkViaBackground(url, onStatus) {
  const onPdfProgress = (msg) => {
    if (msg?.type === "PDF_PROGRESS") {
      onStatus("Downloading document...", msg.percent / 100);
    }
  };
  chrome.runtime.onMessage.addListener(onPdfProgress);
  try {
    await chrome.runtime.sendMessage({ type: "FETCH_URL_TO_PENDING", url });
    return await consumePendingPdf();
  } catch (e) {
    console.warn("[Ingest] Background URL park failed:", e);
    return null;
  } finally {
    chrome.runtime.onMessage.removeListener(onPdfProgress);
  }
}
