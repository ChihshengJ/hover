/**
 * Base64 <-> ArrayBuffer helpers, shared by every context that moves PDF bytes
 * across the extension messaging boundary (popup, content script, background,
 * viewer). Previously each of those carried its own near-identical copy.
 */

/**
 * Convert an ArrayBuffer to a base64 string. Chunked so large PDFs don't blow
 * the argument limit of String.fromCharCode.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string (or `data:` URL) to an ArrayBuffer.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const raw = base64.includes(",") ? base64.split(",")[1] : base64;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
