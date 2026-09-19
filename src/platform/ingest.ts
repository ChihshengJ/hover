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
 */

/** The hand-off record: bytes, a display name, and where they came from. */
export interface PendingRecord {
  data: ArrayBuffer;
  name: string;
  url: string | null;
}

export interface LoadProgress {
  loaded: number;
  /** -1 when the length is unknown. */
  total: number;
  percent: number;
  phase: string;
}

/** How `resolvePdfSource()` reports what it is waiting on. */
export interface ResolveHooks {
  /**
   * A phase, with a 0-1 fraction when one is known and nothing when the wait is
   * indeterminate.
   */
  onStatus?: (message: string, fraction?: number) => void;
  /** The byte-level detail of a direct fetch. */
  onProgress?: (p: LoadProgress) => void;
}

const PENDING_DB_NAME = "hover-pending-pdf";
const PENDING_DB_STORE = "data";

/** The URL a dev-mode viewer opens when nothing else was asked for. */
const DEV_DEFAULT_PDF_URL = "https://arxiv.org/pdf/2501.19393";

/**
 * True only in the packaged viewer page, as opposed to the dev server. The
 * protocol check is what separates the two: `chrome.runtime.id` is also
 * present in a content script running on an ordinary http page.
 */
export function isExtensionContext(): boolean {
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
 * Every page that parks — popup, viewer, empty state, dev server — is on the
 * same origin as the viewer that will drain the record, so they share one DB.
 */
export async function parkInPage(record: PendingRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PENDING_DB_STORE);
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
 * Ingest a File (popup picker, in-viewer import, drag & drop) into the pending
 * store. Does not navigate — the caller decides whether to open a new tab or
 * reload the current viewer.
 */
export async function ingestFile(file: File): Promise<void> {
  if (!file) throw new Error("No file provided");
  if (file.type !== "application/pdf") throw new Error("Not a PDF file");
  const arrayBuffer = await file.arrayBuffer();
  await parkInPage({ data: arrayBuffer, name: file.name, url: null });
}

// ============================================
// Draining: what is this viewer opening?
// ============================================

/**
 * Read and clear the pending record. Reading is destructive by design — the
 * bytes belong to exactly one viewer load, and leaving them behind would make
 * a plain reload reopen a document the user already closed.
 */
function consumePendingPdf(): Promise<PendingRecord | null> {
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
 */
export async function fetchPdfFromUrl(
  url: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<ArrayBuffer> {
  if (url.startsWith("file:")) return readFileUrl(url, onProgress);

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
  const chunks: Uint8Array[] = [];
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
  return combined.buffer as ArrayBuffer;
}

export const FILE_ACCESS_MESSAGE =
  'Could not read this local file. Enable "Allow access to file URLs" for ' +
  "Hover on the browser's extensions page, then reload.";

/**
 * Read a file: URL into a buffer. Local PDFs land here rather than in the
 * fetch above because the Fetch API refuses the file: scheme; XHR does not,
 * and an extension page may use it once the user has granted file access.
 * This is also why the background never parks a local PDF — a service worker
 * has no XMLHttpRequest, so the viewer page is the only context that can read
 * one.
 */
function readFileUrl(
  url: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onprogress = (e) => {
      if (!onProgress) return;
      const total = e.lengthComputable ? e.total : -1;
      onProgress({
        loaded: e.loaded,
        total,
        percent: total > 0 ? Math.round((e.loaded / total) * 100) : 0,
        phase: "downloading",
      });
    };
    xhr.onload = () => {
      // A successful file: read reports status 0, not 200.
      if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
        reject(new Error(`HTTP ${xhr.status}`));
      } else if (
        !xhr.response ||
        (xhr.response as ArrayBuffer).byteLength === 0
      ) {
        reject(new Error(FILE_ACCESS_MESSAGE));
      } else {
        resolve(xhr.response as ArrayBuffer);
      }
    };
    // Denied file access looks exactly like any other network error here —
    // there is no separate signal to distinguish it from a missing file.
    xhr.onerror = () => reject(new Error(FILE_ACCESS_MESSAGE));
    xhr.send();
  });
}

/** The `?file=` / `?url=` a dev-server viewer was opened with. */
export function getDevUrl(): string | null {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("file") || urlParams.get("url");
}

/** The `?url=` the extension viewer was opened with, if any. */
export function getIntendedUrl(): string | null {
  if (!isExtensionContext()) return getDevUrl();
  return new URLSearchParams(window.location.search).get("url");
}

/** Derive a display name from a URL, ignoring any query string. */
function nameFromUrl(url: string): string {
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
 */
export async function resolvePdfSource({
  onStatus = () => {},
  onProgress,
}: ResolveHooks = {}): Promise<PendingRecord | null> {
  const intendedUrl = getIntendedUrl();

  if (isExtensionContext()) {
    let pending = await consumePendingPdf();

    // A file: URL skips the background hand-off: the service worker can't read
    // local files, so asking it to park them only costs a round trip before
    // the viewer-side read below.
    if (!pending && intendedUrl && !intendedUrl.startsWith("file:")) {
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
 */
async function parkViaBackground(
  url: string,
  onStatus: (message: string, fraction?: number) => void,
): Promise<PendingRecord | null> {
  const onPdfProgress = (msg: any) => {
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
