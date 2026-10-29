/**
 * Saving to the Zotero desktop app through its local connector server, the
 * same endpoint the Zotero Connector extension talks to. Zotero has to be
 * running for any of this to answer.
 *
 * The server drops a request that looks like it came from a browser unless it
 * carries `X-Zotero-Connector-API-Version`, and it only answers CORS for its
 * own bookmarklet. So these requests go out from the extension page under a
 * host permission for the server, which is optional in the manifest and asked
 * for on first use (`requestZoteroAccess`) rather than at install.
 */

const ZOTERO_ORIGIN = "http://127.0.0.1:23119";
const ZOTERO_PERMISSION = { origins: [`${ZOTERO_ORIGIN}/*`] };
/** The connector API version this client speaks; Zotero 7–9 report 3. */
const CONNECTOR_API_VERSION = "3";

/** A library or collection a save can go to. */
export interface ZoteroTarget {
  /** Zotero's tree ID: `L<libraryID>` for a library, `C<collectionID>` for a collection. */
  id: string;
  name: string;
  /** 0 for a library, 1+ for collections nested under it. */
  level: number;
}

export interface ZoteroTargets {
  /** Every library and collection a PDF can be saved to, in tree order. */
  targets: ZoteroTarget[];
  /** What's selected in Zotero right now; a sensible default to offer. */
  selectedId: string;
}

function hasPermissionsApi(): boolean {
  return typeof chrome !== "undefined" && !!chrome.permissions;
}

export async function hasZoteroAccess(): Promise<boolean> {
  if (!hasPermissionsApi()) return false;
  try {
    return await chrome.permissions.contains(ZOTERO_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Call this synchronously from the click that asked for it: browsers only show
 * the permission prompt during a user gesture. Resolves immediately when the
 * permission is already held.
 */
export async function requestZoteroAccess(): Promise<boolean> {
  if (!hasPermissionsApi()) return false;
  try {
    return await chrome.permissions.request(ZOTERO_PERMISSION);
  } catch {
    return false;
  }
}

function zoteroFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Zotero-Connector-API-Version", CONNECTOR_API_VERSION);
  return fetch(`${ZOTERO_ORIGIN}${path}`, { ...init, headers });
}

function postJson(path: string, body: unknown, init: RequestInit = {}) {
  return zoteroFetch(path, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The libraries and collections a PDF can be saved to, or null when Zotero
 * isn't reachable.
 */
export async function getZoteroTargets(): Promise<ZoteroTargets | null> {
  try {
    const response = await postJson(
      "/connector/getSelectedCollection",
      {},
      { signal: AbortSignal.timeout(2000) },
    );
    if (!response.ok) return null;
    const data = await response.json();

    // Zotero only lists libraries it can write to; a PDF also needs one that
    // accepts files.
    const targets: ZoteroTarget[] = (data.targets ?? [])
      .filter((t: { filesEditable?: boolean }) => t.filesEditable !== false)
      .map((t: { id: string; name: string; level?: number }) => ({
        id: t.id,
        name: t.name,
        level: t.level ?? 0,
      }));
    const selectedId = data.id ? `C${data.id}` : `L${data.libraryID}`;

    return { targets, selectedId };
  } catch {
    return null;
  }
}

/**
 * Header values must be Latin-1, but titles often aren't. Escaping everything
 * past ASCII as `\uXXXX` keeps the JSON identical once Zotero parses it.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * Save a PDF to Zotero as a standalone attachment. Zotero then tries to
 * recognize it (DOI, arXiv ID, …) and builds a parent item from the metadata,
 * the way it does for a PDF dragged into the app.
 *
 * A save first lands wherever Zotero would put it, and `targetId` is applied
 * afterwards, as the Zotero Connector's own popup does. The move is sent even
 * when `targetId` looks like Zotero's selection: with the main window closed
 * Zotero saves to its remembered last folder instead, which can be a different
 * collection or the library root. It also waits for recognition, so the move
 * takes the new parent item along.
 *
 * @param url Where the PDF came from. Zotero requires one and names the
 *   stored file after it.
 * @param onIdentifying Called once the file is stored and Zotero has started
 *   identifying the paper.
 * @returns The recognized item's title, or null when Zotero couldn't
 *   identify the paper.
 */
export async function saveToZotero(
  file: File,
  { url, title, targetId }: { url: string; title: string; targetId: string },
  onIdentifying?: () => void,
): Promise<string | null> {
  const sessionID = crypto.randomUUID();

  const response = await zoteroFetch(
    `/connector/saveStandaloneAttachment?sessionID=${sessionID}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Metadata": asciiJson({ sessionID, url, title }),
      },
      body: file,
    },
  );
  if (response.status !== 201) {
    throw new Error(`Zotero refused the save (HTTP ${response.status})`);
  }

  const { canRecognize } = await response.json();
  let recognizedTitle: string | null = null;
  if (canRecognize) {
    onIdentifying?.();
    recognizedTitle = await getRecognizedTitle(sessionID);
  }

  const moved = await postJson("/connector/updateSession", {
    sessionID,
    target: targetId,
  });
  if (!moved.ok) {
    throw new Error(`Zotero couldn't file the item (HTTP ${moved.status})`);
  }

  return recognizedTitle;
}

/** Waits for Zotero to finish recognizing the PDF saved in `sessionID`. */
async function getRecognizedTitle(sessionID: string): Promise<string | null> {
  try {
    const response = await postJson("/connector/getRecognizedItem", {
      sessionID,
    });
    if (response.status !== 200) return null;
    return (await response.json()).title ?? null;
  } catch {
    return null;
  }
}
