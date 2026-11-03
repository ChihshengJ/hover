/** Matches an inline event handler attribute inside a tag: ` onclick="…"`. */
const HANDLER_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Parse HTML fetched from another site (Google Scholar) into a detached
 * document for reading.
 *
 * DOMParser never runs the page's handlers, but Chrome still checks each
 * `on…="…"` attribute against the extension's CSP as it parses, and logs a
 * "Executing inline event handler violates … script-src" error for every one.
 * Stripping them from the tags first keeps the console clean; nothing here
 * reads them.
 */
export function parseFetchedHtml(html: string): Document {
  const stripped = html.replace(/<[^>]+>/g, (tag) =>
    tag.replace(HANDLER_ATTR, ""),
  );
  return new DOMParser().parseFromString(stripped, "text/html");
}
