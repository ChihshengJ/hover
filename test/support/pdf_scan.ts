/**
 * Just enough of a PDF parser to answer "what did the save write into each
 * annotation dict?" straight from the bytes, without asking PDFium, which is
 * the thing under test.
 *
 * It finds every top-level `N G obj … endobj`, parses the object's dict, and
 * resolves indirect references among them. It doesn't look inside object
 * streams or decode stream data. That is fine for PDFium's output, which
 * writes every object it saves as a plain top-level object (checked by
 * `annotationDicts` finding them at all).
 */

/** A parsed PDF value. Names keep their leading slash. */
export type PdfValue =
  | number
  | boolean
  | null
  | { name: string }
  | { ref: number }
  | { string: string }
  | PdfValue[]
  | PdfDict;

/** Keyed by name, slash included: `dict.get("/Subtype")`. */
export type PdfDict = Map<string, PdfValue>;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

class Parser {
  pos = 0;
  constructor(readonly s: string) {}

  #skip() {
    for (;;) {
      while (this.pos < this.s.length && WHITESPACE.has(this.s.charCodeAt(this.pos)))
        this.pos++;
      if (this.s[this.pos] !== "%") return;
      while (this.pos < this.s.length && !"\r\n".includes(this.s[this.pos]))
        this.pos++;
    }
  }

  #regular(): string {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
      this.pos++;
    }
    return this.s.slice(start, this.pos);
  }

  value(): PdfValue {
    this.#skip();
    const s = this.s;
    if (s.startsWith("<<", this.pos)) {
      this.pos += 2;
      const dict: PdfDict = new Map();
      for (;;) {
        this.#skip();
        if (s.startsWith(">>", this.pos)) {
          this.pos += 2;
          return dict;
        }
        if (this.pos >= s.length) return dict;
        const key = this.value();
        const name = (key as { name?: string })?.name;
        if (!name) throw new Error(`dict key is not a name at ${this.pos}`);
        dict.set(name, this.value());
      }
    }
    if (s[this.pos] === "[") {
      this.pos++;
      const items: PdfValue[] = [];
      for (;;) {
        this.#skip();
        if (s[this.pos] === "]") {
          this.pos++;
          return items;
        }
        if (this.pos >= s.length) return items;
        items.push(this.value());
      }
    }
    if (s[this.pos] === "/") {
      this.pos++;
      return { name: `/${this.#regular()}` };
    }
    if (s[this.pos] === "(") return { string: this.#literal() };
    if (s[this.pos] === "<") {
      const end = s.indexOf(">", this.pos);
      const hex = s.slice(this.pos + 1, end).replace(/\s+/g, "");
      this.pos = end + 1;
      let out = "";
      for (let i = 0; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, "0"), 16));
      }
      return { string: out };
    }
    const token = this.#regular();
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    const num = Number(token);
    if (token === "" || Number.isNaN(num)) {
      throw new Error(`unexpected token ${JSON.stringify(token)} at ${this.pos}`);
    }
    // `N G R` is a reference; anything else is just a number.
    const save = this.pos;
    const ref = /^\s+(\d+)\s+R(?![^\s/<>\[\]()])/.exec(s.slice(this.pos, this.pos + 24));
    if (Number.isInteger(num) && ref) {
      this.pos += ref[0].length;
      return { ref: num };
    }
    this.pos = save;
    return num;
  }

  #literal(): string {
    // Unescaped only as far as telling empty from non-empty needs.
    let depth = 0;
    let out = "";
    for (; this.pos < this.s.length; this.pos++) {
      const c = this.s[this.pos];
      if (c === "\\") {
        out += this.s[++this.pos];
        continue;
      }
      if (c === "(") {
        if (depth++ === 0) continue;
      } else if (c === ")") {
        if (--depth === 0) {
          this.pos++;
          return out;
        }
      }
      out += c;
    }
    return out;
  }
}

/**
 * Every top-level object's value, by object number. A later definition
 * replaces an earlier one, as an incremental update would.
 */
export function scanObjects(bytes: Uint8Array): Map<number, PdfValue> {
  const text = Buffer.from(bytes).toString("latin1");
  const objects = new Map<number, PdfValue>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let m; (m = header.exec(text)); ) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) break;
    // Stop the dict at `stream`, so the parser never sees stream data.
    let body = text.slice(start, end);
    const stream = /\bstream\r?\n/.exec(body);
    if (stream) body = body.slice(0, stream.index);
    try {
      objects.set(Number(m[1]), new Parser(body).value());
    } catch {
      // Not something this scanner can read. Leave it out.
    }
    header.lastIndex = end;
  }
  return objects;
}

function isDict(value: PdfValue | undefined): value is PdfDict {
  return value instanceof Map;
}

function nameOf(value: PdfValue | undefined): string | undefined {
  return value && typeof value === "object" && "name" in value
    ? value.name
    : undefined;
}

export function resolve(
  objects: Map<number, PdfValue>,
  value: PdfValue | undefined,
): PdfValue | undefined {
  if (value && typeof value === "object" && "ref" in value) {
    return objects.get(value.ref as number);
  }
  return value;
}

/** Whether `/BM /Multiply` is reachable from `value` through dicts and refs. */
function setsMultiply(
  objects: Map<number, PdfValue>,
  value: PdfValue | undefined,
  seen = new Set<number>(),
): boolean {
  if (value && typeof value === "object" && "ref" in value) {
    const ref = value.ref as number;
    if (seen.has(ref)) return false;
    seen.add(ref);
    return setsMultiply(objects, objects.get(ref), seen);
  }
  if (Array.isArray(value)) return value.some((v) => setsMultiply(objects, v, seen));
  if (!isDict(value)) return false;
  if (nameOf(value.get("/BM")) === "/Multiply") return true;
  return [...value].some(
    // `/Parent` and `/P` lead back up the page tree, never into an appearance.
    ([k, v]) => k !== "/Parent" && k !== "/P" && setsMultiply(objects, v, seen),
  );
}

/** The keys the saved-file checks ask about. */
const CHECKED_KEYS = ["/AP", "/CA", "/T", "/Contents", "/NM", "/M", "/F", "/EPDFCustom"];

export interface AnnotationDictSummary {
  subtype: string;
  /** Which of `CHECKED_KEYS` are present. */
  keys: string[];
  /** Present but empty: `/Contents()` or `/T()`. */
  empty: string[];
  /** The normal appearance stream sets `/BM /Multiply` somewhere in it. */
  apMultiply: boolean;
  /** `/CA`, when present. */
  ca?: number;
  /**
   * Set when the dict sits directly inside `/Annots` rather than being an
   * object of its own, as PDFium's `FPDFPage_CreateAnnot` writes it. Absent
   * for an indirect one.
   */
  direct?: true;
}

/**
 * Every dict in `value`, depth first, without following references: the
 * annotation dicts written directly inside an `/Annots` array.
 */
function nestedDicts(value: PdfValue | undefined, out: PdfDict[]) {
  if (Array.isArray(value)) {
    for (const item of value) nestedDicts(item, out);
  } else if (isDict(value)) {
    out.push(value);
    for (const item of value.values()) nestedDicts(item, out);
  }
}

/**
 * One summary per annotation dict of the given subtypes, in object-number
 * order, with dicts written inline in `/Annots` after the object holding
 * them (stable for a given save).
 */
export function annotationDicts(
  bytes: Uint8Array,
  subtypes: string[],
): AnnotationDictSummary[] {
  const objects = scanObjects(bytes);
  const out: AnnotationDictSummary[] = [];
  const numbers = [...objects.keys()].sort((a, b) => a - b);
  const candidates: [PdfDict, boolean][] = [];
  for (const n of numbers) {
    const value = objects.get(n);
    if (isDict(value)) candidates.push([value, false]);
    // Annotation dicts written inline in a page's (or an array object's)
    // `/Annots`.
    const annots = isDict(value) ? value.get("/Annots") : Array.isArray(value) ? value : undefined;
    const inline: PdfDict[] = [];
    nestedDicts(annots, inline);
    for (const dict of inline) candidates.push([dict, true]);
  }
  for (const [dict, direct] of candidates) {
    const subtype = nameOf(dict.get("/Subtype"));
    if (!subtype || !subtypes.includes(subtype)) continue;
    if (nameOf(dict.get("/Type")) !== "/Annot" && !dict.has("/Rect")) continue;

    const keys = CHECKED_KEYS.filter((k) => dict.has(k));
    const empty = ["/Contents", "/T"].filter((k) => {
      const v = resolve(objects, dict.get(k));
      return !!v && typeof v === "object" && "string" in v && v.string === "";
    });
    const ap = resolve(objects, dict.get("/AP"));
    const normal = isDict(ap) ? ap.get("/N") : undefined;
    const summary: AnnotationDictSummary = {
      subtype,
      keys,
      empty,
      apMultiply: setsMultiply(objects, normal),
    };
    const ca = resolve(objects, dict.get("/CA"));
    if (typeof ca === "number") summary.ca = ca;
    if (direct) summary.direct = true;
    out.push(summary);
  }
  return out;
}
