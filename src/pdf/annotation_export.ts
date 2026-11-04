/**
 * Clean-up of a saved PDF's annotations before it leaves Hover.
 *
 * The engine writes an author (`/T`) and a note (`/Contents`) onto every
 * annotation it creates, empty when there's nothing to say. Readers built on
 * Apple's PDFKit, Preview and Skim among them, take any `/Contents` on a
 * highlight as a note, so an empty one shows up as a blank anchored note on
 * every highlight. PDFium has no call to delete a key, so the saved bytes are
 * edited instead.
 *
 * TODO(embedpdf v3): remove this file, its call in
 * `PDFDocumentModel#saveWithAnnotations` and test/annotation_export.test.ts
 * when moving off @embedpdf/engines 2.x. The empty writes are v2's
 * `applyBaseAnnotationProperties` (`annotation.contents ?? ''`, from commit
 * 8c79ee28, 2025-07). v3's engine writes `/Contents` only when a note is
 * given (packages/engine/services/.../write/writeAnnotationBase.ts). Before
 * removing, export a comment-less highlight and check the file holds no
 * `/Contents()`.
 */

/** The marker of an annotation the engine created: its private custom data. */
const ENGINE_MARKER = ascii("/EPDFCustom");
const OBJ = ascii("obj");
const ENDOBJ = ascii("endobj");
/** The entries to drop when empty, exactly as PDFium serialises them. */
const EMPTY_ENTRIES = [ascii("/Contents()"), ascii("/T()")];
const SPACE = 0x20;

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function indexOf(
  bytes: Uint8Array,
  needle: Uint8Array,
  from = 0,
  to = bytes.length,
): number {
  const first = needle[0];
  const last = to - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOf(bytes: Uint8Array, needle: Uint8Array, before: number) {
  for (let i = before - needle.length; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Drop the empty `/Contents` and `/T` entries from the annotations the engine
 * created, in place. Each is overwritten with spaces, so every byte offset
 * stays put and the cross-reference table still holds. Annotations the file
 * came with, and any entry that says something, are left alone.
 */
export function stripEmptyAnnotationNotes<T extends Uint8Array>(bytes: T): T {
  let at = 0;
  for (;;) {
    const marker = indexOf(bytes, ENGINE_MARKER, at);
    if (marker < 0) break;
    const start = lastIndexOf(bytes, OBJ, marker);
    const end = indexOf(bytes, ENDOBJ, marker);
    if (start < 0 || end < 0) break;

    for (const entry of EMPTY_ENTRIES) {
      for (
        let hit = indexOf(bytes, entry, start, end);
        hit >= 0;
        hit = indexOf(bytes, entry, hit + entry.length, end)
      ) {
        bytes.fill(SPACE, hit, hit + entry.length);
      }
    }
    at = end + ENDOBJ.length;
  }
  return bytes;
}
