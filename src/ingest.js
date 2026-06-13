/**
 * Layer 1 — PDF source ingestion (page side).
 *
 * Every UI entry point (popup picker, in-viewer import, drag & drop, dev URL)
 * acquires PDF bytes in its own way, then hands them to the single pending-PDF
 * store that the viewer drains on load. Acquisition differs per entry point;
 * the hand-off contract — a `{ data, name, url }` record under the key
 * "pending" — does not. Keep all of that contract knowledge here so callers
 * only have to produce a File / bytes and decide how to open the viewer.
 */

import { arrayBufferToBase64 } from "./util/base64.js";

const PENDING_DB_NAME = "hover-pending-pdf";
const PENDING_DB_STORE = "data";

function inExtension() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
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
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore(PENDING_DB_STORE);
    req.onsuccess = (e) => {
      const db = e.target.result;
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
