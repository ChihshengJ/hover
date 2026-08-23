# Architecture plan: multi-reference support and TypeScript

Written 2026-08-23 against `feat/engine-update` (efd138b). Two goals drive this
plan, and they turn out to want the same refactor:

1. **Multiple reference sections per document** (roadmap item) — books with
   per-chapter bibliographies, proceedings, theses.
2. **TypeScript**, for LSP tooling and to stop the JSDoc from silently rotting.

The connecting insight: the reference/citation engine is already 95% pure
functions over a text index, but it's tangled with the PDFium layer and with
`doc.js` in ways that make it untestable and make the single-section assumption
hard to find. Untangling it is a prerequisite for (1), and it's the natural unit
of work for (2).

---

## Current shape

```
src/data/pdfium_*.js, text_extractor, image_extractor   PDFium FFI, raw glyphs
src/data/text_index.js                                  ← the boundary object
src/data/{reference,inline,citation,cross_reference,outline}_*.js
src/data/{lexicon,layout_heuristics}.js                 pure analysis
src/doc.js                                              model: handles + results + query API
src/{viewpane,page,text_manager,window_manager}.js      render stack
src/{controls,settings,annotation,trail}/               UI
background.js, content.js, popup.js  (repo root)        extension boundary
```

Worth preserving as-is:

- DOM access is confined to component constructors. Only `onboarding.js` (11
  sites) and `file_menu.js` (5) reach out via `querySelector`. Everything else
  owns its own elements.
- No `window.*` globals anywhere.
- `lexicon.js` as the single home for every regex and parse helper.
- `controls/floating_toolbar/index.js` — option objects plus getter callbacks
  (`getPane: () => this.pane`). This is the pattern the rest of the render stack
  should converge on; see Phase 5.

---

## Phase 1 — `checkJs`, and fix what it finds

**Cost: ~1 day. No file renames. Do this first regardless of everything else.**

74 of 77 source files already carry `@param`/`@typedef` JSDoc. Those annotations
have never been verified by a compiler, and they have decayed. Confirmed broken
today:

| Location | Problem |
|---|---|
| `src/window_manager.js:4-5` | `@typedef {import('...') FloatingToolbar};` — brace misplaced, no `.FloatingToolbar` member access. Both typedefs are dead. |
| `src/doc.js:60` | `import('./reference_builder.js')` — file is at `./data/reference_builder.js`, *and* `ReferenceIndex` is not exported as a typedef. Wrong twice. |
| `src/data/citation_builder.js:16` | `RefKey` and `Citation` typedef blocks merged onto one line; `Citation` never parses. |
| `src/data/citation_builder.js:480` | `@param {import('./doc.js')...}` — needs `../doc.js` |
| `src/data/inline_extractor.js:1275` | same |
| `src/data/cross_reference_builder.js:602` | same |

Steps:

1. Add `tsconfig.json`:

   ```jsonc
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "ESNext",
       "moduleResolution": "bundler",
       "allowJs": true,
       "checkJs": true,
       "noEmit": true,
       "strict": false,
       "skipLibCheck": true,
       "baseUrl": ".",
       "paths": { "@/*": ["src/*"] }   // mirrors the Vite alias
     },
     "include": ["src/**/*", "background.js", "content.js", "popup.js", "vite.config.js"]
   }
   ```

2. `npm i -D typescript` and add `"typecheck": "tsc --noEmit"` to scripts.
3. Fix the table above, plus whatever else surfaces.

Nothing about the build changes — `noEmit` means `tsc` is a linter here. Vite
keeps doing exactly what it does now.

---

## Phase 2 — split `src/data/` into `src/pdf/` and `src/analysis/`

**Mechanical. This is the step that unlocks testing.**

`src/data/` currently mixes PDFium FFI with pure text analysis. The boundary is
nearly clean already — `reference_builder.js` imports only `text_index` and
`lexicon`.

```
src/pdf/          pdfium_ffi, pdfium_reader, text_extractor, image_extractor, pdfium_init
src/analysis/     text_index, reference_builder, inline_extractor, citation_builder,
                  cross_reference_builder, outline_builder, lexicon, layout_heuristics
src/model/        doc.js, annotation/annotation_data.js
src/viewer/       viewpane, page, text_manager, window_manager, pointer_gesture
src/platform/     ingest, util/base64  (+ background.js, content.js, popup.js)
src/ui/           controls/, settings/, annotation/ (view parts), trail/
```

**The rule that makes this worth doing: `src/analysis/` may not import from
`src/pdf/`.** `DocumentTextIndex` is the interface between them. Enforce it with
an ESLint `no-restricted-imports` rule, or just a grep in CI.

Also rename `pdfium-init.js` → `pdfium_init.js`; it's the only kebab-case file
in a snake_case tree.

---

## Phase 3 — snapshot tests on the existing fixture PDFs

**Do this before touching the reference parser.**

There are currently no tests. The reference/citation engine is parser code with
three detection tiers, format heuristics and ~40 regexes in `lexicon.js`.
Changing its scoping model blind is the main risk in this whole plan.

After Phase 2, `src/analysis/` runs in Node with no wasm. So:

1. One-time: for each fixture PDF, run the PDFium half and serialize the
   resulting `DocumentTextIndex` to JSON in `test/fixtures/`.
2. Tests load that JSON, run the full analysis pipeline, and snapshot the anchor
   list and the citation → reference mapping.

`marketing/List of Papers/` already holds what are clearly regression cases in
spirit:

- `Nature paper example.pdf`
- `Range example 19-20.pdf` — range notation
- `no internal example.pdf` — no native link annotations, extraction-only path
- `rotate example.pdf`

Add a multi-bibliography document (a thesis or proceedings) as the fixture for
Phase 4 before writing any of that code.

The roadmap already lists "Building a test suite from Semantic Scholar's
database" — this is the cheap first version of it, and it runs in milliseconds.

---

## Phase 4 — multi-reference support

### 4a. Where the singular assumption lives

Five places, traced:

1. **`src/data/reference_builder.js:243`** — literally
   `// Currently only supports one reference section` before `break outerLoop`.
   All three detection tiers (outline / heading / backward-probe) return the
   first hit and stop.
2. **`buildReferenceIndex()` returns one flat `{anchors, format, sectionStart,
   sectionEnd}`** (`reference_builder.js:82-95`). One `format` for the whole
   document — a book with per-chapter bibliographies can legitimately mix them.
3. **`anchor.index` is a document-global number**, and
   `findReferenceByIndex(anchors, index)` (`reference_builder.js:1127`) is
   `anchors.find(a => a.index === index)`. Two bibliographies both starting at
   `[1]` collide on the first lookup.
4. **Three builders cache the section as two scalars** and test containment with
   `pageNum > start && pageNum <= end`:
   - `citation_builder.js:59-61` and `:115-119`
   - `cross_reference_builder.js:81-82`
   - `inline_extractor.js:253-254`
5. **`citation.refIndices: number[]`** — a bare number can no longer identify a
   reference.

Plus the model-level surface: `doc.getReferenceSectionBounds()`
(`doc.js:606-612`) returns a single `{startPage, endPage}`.

### 4b. Target shape

```ts
type SectionId = string;
type RefRef    = { section: SectionId; index: number | string };

interface ReferenceSection {
  id: SectionId;
  startPage: number;
  endPage: number;
  format: ReferenceFormat;      // per-section, not per-document
  anchors: ReferenceAnchor[];   // anchor.ref = { section: id, index }
  scope?: { kind: 'document' | 'chapter'; startPage: number };
}

interface ReferenceIndex {
  sections: ReferenceSection[];

  /** Which section does a citation on this page resolve against? */
  sectionForCitationOnPage(page: number): ReferenceSection | null;

  resolve(ref: RefRef): ReferenceAnchor | null;
  isInAnyReferenceSection(page: number): boolean;
  get isUsable(): boolean;      // replaces the MIN_USABLE_REFERENCES check in doc.js:176
}
```

`sectionForCitationOnPage()` is the important addition. Today the question
"which references does `[12]` on page 30 mean?" is answered implicitly by
*"the only ones there are."* With multiple sections it becomes a real policy
decision — nearest following section? enclosing chapter, per the outline? — and
it must live in exactly one place, or it will be re-derived inconsistently
across `inline_extractor`, `citation_builder` and `cross_reference_builder`.

### 4c. Migration order (this is what de-risks it)

**Step 1 — introduce the types with `sections: [theOneSection]`.** Detection is
unchanged; the existing single section is wrapped in an array. Move all five
consumers above onto `sectionForCitationOnPage()` / `isInAnyReferenceSection()`
/ `resolve()`. Behavior is byte-identical, so the Phase 3 snapshots must not
move. Any diff is a bug in the mechanical translation.

**Step 2 — multi-section detection**, now confined to `reference_builder.js`
plus the scope policy. Lift the `break outerLoop` in the heading tier; make the
outline tier collect every matching entry rather than the first; teach the
backward-probe tier to continue scanning past the first sequence.

**Step 3 — per-section format detection.** `detectReferenceFormat()` already
takes just `lines`, so run it per section rather than once for the document.

Getting the order right matters: the risky parser change lands on a codebase
already shaped to receive it, with snapshots proving the shaping was neutral.

---

## Phase 5 — the `doc` ↔ builder cycle

Every analysis builder currently takes the whole model:

```js
createInlineExtractor(doc)        // src/data/inline_extractor.js:1278
createCitationBuilder(doc)        // src/data/citation_builder.js:483
createCrossReferenceBuilder(doc)  // src/data/cross_reference_builder.js:605
```

`doc.js` imports the builders; the builders import `doc.js` back. Each factory
then pulls exactly 4 fields off it.

Meanwhile `doc.js` scatters results across eight mutable fields —
`citationsByPage`, `citationDetails`, `crossRefsByPage`, `crossRefTargets`,
`urlsByPage`, `outline`, `referenceIndex`, `detectedMetadata` — populated by two
divergent code paths, `#buildInlineElements()` (`doc.js:381`) and
`#buildNativeFallback()` (`doc.js:402`), which produce slightly different
citation shapes.

Replace with a pure pipeline producing one value object:

```js
// src/analysis/pipeline.js — no PDFium import, no doc.js import
export function analyzeDocument({ textIndex, nativeAnnotationsByPage, numPages }) {
  const outline    = buildOutline(...);
  const references = buildReferenceIndex(textIndex, outline);
  const inline     = references.isUsable
    ? extractInline({ textIndex, references, numPages })
    : nativeFallback({ nativeAnnotationsByPage });
  return new DocumentAnalysis({ outline, references, ...inline, urls });
}
```

`doc.js` becomes `this.analysis = analyzeDocument({...})`, with its ~15 query
methods delegating. The builders lose their dependency on the model, the two
fallback paths converge on one output type, and the pipeline is directly
callable from the Phase 3 tests.

---

## Phase 6 — interface cleanups

Independent of the above; do them opportunistically.

**Push the option-object pattern down.** These still take a whole parent:
`new NavigationTree(this)`, `new PaneControls(this)`, `new PageView(this, ...)`,
`new TextSelectionManager(this)`, `new AnnotationManager(this)`.
`floating_toolbar/index.js` shows the better shape. Each conversion makes one
more file unit-testable.

**Type the event bus.** `doc.notify(event, data)` is stringly-typed;
`viewpane.js:861` does `event.startsWith("annotation-")`. Make the event set an
exported frozen const, the way `CitationFlags` already is.

**Let non-pane components subscribe.** Only `ViewerPane` subscribes today, so
`main.js:332-333` reaches in imperatively:

```js
wm.toolbar?.navigationTree?.reinitialize();
wm.progressBar?.buildSectionMarks();
```

That's `main.js` knowing the internals of two UI subtrees. If both subscribe to
`index-ready`, those lines disappear.

**Consolidate the pending-PDF contract.** `main.js` and `ingest.js` both declare
`PENDING_DB_NAME`/`PENDING_DB_STORE`; `ingest.js` owns the write (`parkInPage`),
`main.js` owns the read (`consumePendingPdf`, `main.js:29`). `ingest.js`'s own
header comment says it exists to keep that contract in one place — so move
`consumePendingPdf` and the whole source-resolution branch there as
`resolvePdfSource()` (extension vs dev, pending vs URL vs background-park).
`main.js` drops to roughly 150 lines: resolve → construct → wire.

**One `Rect` type.** `{x, y, width, height}` is re-declared inline in 10 JSDoc
sites across `text_extractor`, `pdfium_reader`, `image_extractor`,
`inline_extractor`, `citation_builder` and `cross_reference_builder`. PDFium's
`{origin, size}` shape is converted by hand in `citation_builder.js:165-170` and
`doc.js:428-433`. One named `Rect` plus a `rectFromPdfium()` converter removes a
whole class of bug.

---

## Phase 7 — the `.ts` renames

Only after Phases 1–5. By then the types that matter already exist as JSDoc that
compiles.

1. **Write `src/types.d.ts` first** — `Rect`, `TextLine`, `PageData`,
   `OutlineItem`, `ReferenceAnchor`, `ReferenceSection`, `RefRef`, `Citation`,
   `CrossRef`. Do this alongside Phase 4b; writing the types is how the
   remaining single-section assumptions surface.
2. **Rename leaves-first:** `util/` → `lexicon` → `layout_heuristics` →
   `pdfium_ffi` → `text_index` → builders → `doc.js` → UI last. Under
   `moduleResolution: "bundler"` the existing `./foo.js` imports resolve to
   `foo.ts` unchanged, so imports need no edits.
3. **Enable `strict` per-directory** as each one lands. Leave `strictNullChecks`
   for last — it's the expensive one, given how much of this code optional-chains
   against nullable model fields.

### Friction to expect

- **DOM expando properties**, ~120 sites: `el._crossRefData` (`page.js:707`),
  `imgRect._imageInfo`, plus `dataset` string round-trips. TS flags all of them.
  Fix pattern is `WeakMap<Element, CrossRef>`, which is better code anyway — but
  it is real work, so batch it.
- **`PdfiumFFI` pointer arithmetic** — type pointers as plain `number`. Branded
  types are not worth it there.
- **`Config.get(key)` is the best free win.** Typing it from `SCHEMA` via
  `keyof typeof SCHEMA` yields literal-typed config values and catches typo'd
  keys across the 7 files that import it. Roughly 20 lines of type code.

---

## Suggested order

Execution order, which is not the same as the phase numbering above:

| Order | Work | Phase | Why here |
|---|---|---|---|
| 1 | `checkJs` + fix broken JSDoc | 1 | ~1 day, no renames, immediate LSP payoff |
| 2 | Split `data/` → `pdf/` + `analysis/` | 2 | mechanical; unlocks the tests |
| 3 | Snapshot tests on fixture PDFs | 3 | must exist before the parser changes |
| 4 | Section-scoped types, `sections: [one]` | 4, step 1 | behavior-neutral; snapshots prove it |
| 5 | `analyzeDocument()` pipeline, kill the cycle | 5 | can swap with 4; both precede 6 |
| 6 | Multi-section detection + per-section format | 4, steps 2–3 | the actual feature |
| 7 | Interface cleanups, `.ts` renames | 6, 7 | continuous, alongside everything |

Orders 1–3 are worth doing even if multi-reference support is deferred; they pay
for themselves in tooling and regression safety. The 4-before-6 split is the
part not to shortcut.
