# Architecture plan: multi-reference support and TypeScript

Written 2026-08-23 against `feat/engine-update` (efd138b). Two goals drive this
plan, and they turn out to want the same refactor:

> **Status.** Phases 1, 2, 3, 5 and 6 have landed on `refactor-TS`, and Phase 7
> has landed for the engine half of the tree (`types/`, `platform/util/`,
> `analysis/`, `pdf/`, `model/doc_events`). Every file path and line number
> below describes the tree as of Phase 2 unless a phase section says otherwise.
>
> **3 and 4 were skipped** ahead of 5, 6 and 7, at the cost recorded under
> "Skipping 3 and 4" below. 3 has since landed; **Phase 4 is the next open
> item**, and Phase 7 stops where it does because of it.

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
src/pdf/pdfium_{ffi,reader,init}.js, text_extractor,
        image_extractor                                 PDFium FFI, raw glyphs
src/analysis/text_index.js                              ← the boundary object
src/analysis/{reference,inline,citation,cross_reference,outline}_*.js
src/analysis/{lexicon,layout_heuristics}.js             pure analysis
src/model/doc.js                                        model: handles + results + query API
src/model/annotation_data.js                            annotation store
src/viewer/{viewpane,page,text_manager,window_manager,
        pointer_gesture}.js                             render stack
src/ui/{controls,settings,annotation,trail,tools}/      UI
src/platform/{ingest,util/base64}.js                    extension boundary (in-page half)
src/main.js                                             entry point (index.html)
background.js, content.js, popup.js  (repo root)        extension boundary
```

Worth preserving as-is:

- DOM access is confined to component constructors. Only `onboarding.js` (11
  sites), `file_menu.js` (3), `settings.js` (1) and `main.js` (1) reach out via
  `document.querySelector`. Everything else owns its own elements.
- No `window.*` globals anywhere.
- `lexicon.js` as the single home for every regex and parse helper.
- `ui/controls/floating_toolbar/index.js` — option objects plus getter callbacks
  (`getPane: () => this.pane`). This is the pattern the rest of the render stack
  should converge on; see Phase 5.

---

## Phase 1 — `checkJs`, and fix what it finds — **DONE**

**Cost: ~1 day. No file renames. Do this first regardless of everything else.**

74 of 77 source files already carry `@param`/`@typedef` JSDoc. Those annotations
have never been verified by a compiler, and they have decayed. Confirmed broken
at the time of writing — all six now fixed:

| Location | Problem |
|---|---|
| `src/window_manager.js:4-5` | `@typedef {import('...') FloatingToolbar};` — brace misplaced, no `.FloatingToolbar` member access. Both typedefs are dead. |
| `src/doc.js:60` | `import('./reference_builder.js')` — file is at `./data/reference_builder.js`, *and* `ReferenceIndex` is not exported as a typedef. Wrong twice. |
| `src/data/citation_builder.js:16` | `RefKey` and `Citation` typedef blocks merged onto one line; `Citation` never parses. |
| `src/data/citation_builder.js:480` | `@param {import('./doc.js')...}` — needs `../doc.js` |
| `src/data/inline_extractor.js:1275` | same |
| `src/data/cross_reference_builder.js:602` | same |

`checkJs` turned up 480 errors in total. Beyond the annotation repairs, it
surfaced live bugs the JSDoc had been hiding — a missing `assert` that made
every pinch gesture throw, a `stopPropagation400` typo, a private
`#selectAnnotation` that made the nav tree's call a silent no-op, an
unreachable shift+minus zoom branch, an inconsistent sort comparator in
`outline_builder`, a botched template-literal edit in `lexicon.js`, and a
PDF.js-era save fallback that could never fire. See the Phase 1 commit for the
full list.

Two things were deliberately left standing rather than fixed:

- **`navigation_tree.js` still calls PDF.js APIs** (`getPage`, `getViewport`,
  `getAnnotations`, `getTextContent`, `getDestination`, `getPageIndex`) on a
  PDFium `PdfDocumentObject`, which silently kills figure/table extraction.
  Marked `FIXME(pdfium-migration)`; porting it is a feature decision.
- **The two DOM expandos** are declared in `src/types/globals.d.ts` rather than
  converted — see Phase 7.

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
       "types": ["chrome"],
       "paths": { "@/*": ["./src/*"] }   // mirrors the Vite alias
     },
     "include": ["src/**/*", "background.js", "content.js", "popup.js"]
   }
   ```

   Two departures from the sketch above, both forced. TypeScript resolved to
   **7.x**, the native port, which has removed `baseUrl` — so `paths` targets
   are written relative to the config file. And `vite.config.js` moved out to
   its own `tsconfig.node.json`: it is the only file that runs under Node, and
   pulling `@types/node` into the main program redeclares browser globals
   (`setTimeout` returning a `Timeout` rather than a `number`).

2. `bun add -d typescript @types/chrome` and add `"typecheck"` to scripts.
3. Fix the table above, plus whatever else surfaces.
4. `src/types/globals.d.ts` for the ambient declarations that have no JS
   declaration site: Vite's `define` constants (`__APP_VERSION__`, `__TARGET__`,
   `__LOCAL_WASM_ONLY__`), `*.css` side-effect imports, `navigator.userAgentData`,
   and the two DOM expandos.

Nothing about the build changes — `noEmit` means `tsc` is a linter here. Vite
keeps doing exactly what it does now.

---

## Phase 2 — split `src/data/` into `src/pdf/` and `src/analysis/` — **DONE**

**Mechanical. This is the step that unlocks testing.**

`src/data/` currently mixes PDFium FFI with pure text analysis. The boundary is
nearly clean already — `reference_builder.js` imports only `text_index` and
`lexicon`.

```
src/pdf/          pdfium_ffi, pdfium_reader, text_extractor, image_extractor, pdfium_init
src/analysis/     text_index, reference_builder, inline_extractor, citation_builder,
                  cross_reference_builder, outline_builder, lexicon, layout_heuristics
src/model/        doc.js, annotation_data.js
src/viewer/       viewpane, page, text_manager, window_manager, pointer_gesture
src/platform/     ingest, util/base64  (+ background.js, content.js, popup.js)
src/ui/           controls/, settings/, annotation/ (view parts), trail/, tools/
```

`src/main.js` stays at the top level — `index.html` points at it — as does
`src/types/`. Two calls the sketch left open: `annotation_data.js` sits flat in
`src/model/` rather than in a one-file `model/annotation/`, and `src/tools/`
went to `src/ui/tools/`.

**The rule that makes this worth doing: `src/analysis/` may not import from
`src/pdf/`.** `DocumentTextIndex` is the interface between them. Enforced by
`scripts/check_layering.mjs` (`bun run check:layers`, also folded into `bun run
check` alongside typecheck) rather than ESLint, since the repo has no ESLint.

It turned out the boundary was already clean: `src/analysis/` has **no**
runtime import leaving the directory, so the whole reference/citation engine
loads in plain Node with no wasm — verified by importing all eight modules.
That is exactly what Phase 3 needs.

Three JSDoc type-only references into `src/pdf/` survive. They are erased
before runtime, so they cost nothing to execute, but they are still design
dependencies — the check pins them to an allowlist so a new one has to be a
deliberate decision:

- `inline_extractor.js` → `PdfiumTextExtractor` (twice). Removed by Phase 5,
  when the builders stop taking a PDFium handle.
- `text_index.js` → `PathObjectInfo`. A plain geometry record that happens to
  be declared next to its producer; Phase 7's `types.d.ts` is its real home.

Also rename `pdfium-init.js` → `pdfium_init.js`; it's the only kebab-case file
in a snake_case tree.

The move was verified behaviour-neutral: a from-scratch chrome build produced
the same main-chunk content hash as before it.

---

## Skipping 3 and 4 — what it cost

Phases 5, 6 and 7 were executed ahead of 3 and 4, on the reasoning that 5 and 6
are plumbing rather than parser work and the plan itself allows 4 and 5 to
swap. That held, with three consequences worth writing down.

**Phase 5 and 6 landed without the snapshots that exist to prove them neutral.**
The translations were kept mechanical and the whole-program typecheck plus a
three-target build stand in for them, but "the reference output did not move" is
not something anyone has actually checked. That is the debt, and Phase 3 landing
afterwards does not retire it: the snapshots record the tree as it is *after*
those phases, so they pin everything from here forward and nothing before.

**Phase 7 stopped at the model boundary.** Renaming a `.js` file to `.ts` makes
TypeScript *stop reading its JSDoc* — annotations are honoured in `.js` files
and ignored in `.ts` ones — so a rename without a real conversion silently
deletes every parameter type in the file, and with `strict: false` nothing
reports it. Every file renamed here had its JSDoc converted to TS syntax and is
held to `noImplicitAny` by `tsconfig.strict.json`, which is what makes the
rename a gain rather than a quiet loss. The remaining ~26k lines of `viewer/`
and `ui/` are the same job at five times the size.

Note what Phase 3 does and does not buy there. The snapshots pin the analysis
pipeline's output — anchors, and the citation → reference mapping — so they
cover `analysis/` and the model's boundary with it, which is most of what
Phases 5 and 6 moved. They do not cover rendering, so they say nothing about
`viewer/` or `ui/`. The conversion risk in those directories is the same in kind
(a decayed annotation turns out to describe code that never ran — see the
`viewer/page.js` text-layer font below) but the safety net is a different one:
running the viewer and looking at it. Worth knowing before treating "wait for
Phase 3" as sufficient cover for the rest of Phase 7.

**The types were written for the single-section shape.** Phase 7's first step
was meant to happen alongside 4b so that writing the types would surface the
remaining single-section assumptions. Written against today's shape instead,
`ReferenceIndex` in `src/analysis/reference_builder.ts` is a flat
`{anchors, format, sectionStart, sectionEnd}` and Phase 4 will have to revise
it. One thing did surface anyway: `RefIndex` (`src/types/index.d.ts`) is
`number | string`, because the abbreviated format stores its key string where
the JSDoc had always claimed a number. That is the same question `RefRef`
answers in 4b, and it is now named.

### Bugs the conversion surfaced

Typing found four live defects the JSDoc had been hiding. Two were fixed; two
are flagged in place because fixing them moves output that nothing yet pins.

| Where | What | Status |
|---|---|---|
| `analysis/outline_builder.ts` `detectTitle()` | One branch returned a bare string where every other returns `{title, lines}`. `Object.assign` then spread it as character indices, so a detected title was silently dropped and the metadata object was polluted with numeric keys. | **fixed** |
| `analysis/*` `refIndices` | Declared `number[]`; the abbreviated-citation path has always stored key strings. Now `RefIndex[]`. | **fixed** |
| `analysis/reference_builder.ts` `findReferenceSectionEnd()` | `/\d+/.test(line)` tests the line *object*, so `isAllCapital` is always false and never contributes to where a section ends. | `FIXME(reference-detection)` — fixing it moves section boundaries |
| `viewer/page.js` text layer | `line.font?.family` — a `TextLine` has no `font`; the index reads the family off the raw slice and drops it when building lines. The invisible text layer has always been laid out in sans-serif. | `FIXME(text-layer-font)` — fixing it moves selection geometry |

Two dead paths also came out: `CitationBuilder#organizeByPage` (no callers) and
`PageView#renderImageOverlays` (both call sites already commented out, and the
model half it read from no longer exists) — the latter parked alongside the rest
of the image feature rather than deleted.

---

## Phase 3 — snapshot tests on the existing fixture PDFs — **DONE**

**Do this before touching the reference parser.**

There are currently no tests. The reference/citation engine is parser code with
three detection tiers, format heuristics and ~40 regexes in `lexicon.js`.
Changing its scoping model blind is the main risk in this whole plan.

After Phase 2, `src/analysis/` runs in Node with no wasm (confirmed). So:

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

### What landed

`bun test` — 21 tests over the four fixture PDFs, ~300 ms, no wasm. `bun run
check` now runs typecheck, the layering check and the tests.

    scripts/build_fixtures.ts       PDF → test/fixtures/<slug>.json.gz  (one-time)
    test/support/fixture.ts         the fixture format, and the two sources that replay it
    test/analysis.test.ts           the snapshots
    test/__snapshots__/             ~2.7k lines, one anchor or citation per line

Four departures from the sketch, each forced by something the sketch did not
know:

- **The fixture holds the `PageSource` inputs, not the built `DocumentTextIndex`.**
  Serialising the index would have meant a `toJSON`/`fromJSON` pair on the class
  and would have frozen its output; feeding it raw glyph slices instead costs
  nothing extra and puts `text_index.ts` — line grouping, header/footer
  detection, column detection — inside the covered surface.
- **`RawPageTextSource` is a recording, not a serialisation.** Which character
  ranges `InlineExtractor` probes depends on what it finds, so there is no
  bounded set to write out in advance. The generator runs the real pipeline once
  behind a recording proxy and stores the calls. A miss at replay time throws
  with a pointer at `bun run fixtures` — the fixture is a recording of PDFium,
  and only PDFium can extend it. In practice a fixture records 23–361 ranges.
- **Snapshots are flat text, one record per line**, not serialized objects. The
  point of a snapshot here is that a reviewer can look at the diff and say
  whether the move was intended, and nested JSON of 312 citations does not read.
  Anchor ids are omitted: they are fresh UUIDs per run, and nothing downstream
  depends on the value.
- **Fixtures are gzipped** (~1.3 MB total, from ~11 MB of JSON). Nothing reads
  one by eye; `gunzip -c … | jq` is in the script header. Regeneration is
  byte-stable — every float is rounded to four places, and the engine's per-run
  annotation UUIDs are dropped — so a rebuild that changes a fixture means
  PDFium's output actually moved.

Two extractions the generator forced, both of which belong where they went:

- `normalizeAnnotationRects()` → `src/pdf/annotations.ts`, out of a private
  method on `AnnotationStore`. It is raw FFI — `FPDFAnnot_GetRect` and a heap
  read — and the generator has to produce the same annotation shape the model
  does. It now goes through `PdfiumFFI`'s scratch frames rather than reaching
  into `HEAPF32`, which retires the last hand-rolled heap access outside
  `pdfium_ffi.ts`. Its two locals were also named backwards: it read `FS_RECTF`
  offset 4 as `bottom` and offset 12 as `top`, which is the reverse of the
  struct. Same behaviour, honest names.
- `collectNamedDestinations()` → `src/analysis/outline_builder.ts`, out of
  `#loadBookmarksAndDestinations`. It is a pure walk over a bookmark tree, and
  the only consumer of its output is `buildOutline()`. One behavioural
  difference, deliberate: a bookmark whose action carries no `view` array is
  skipped rather than throwing, where the old version abandoned the rest of the
  tree on the first malformed entry.

**Still open: the multi-bibliography fixture.** Phase 4 needs a thesis or
proceedings with per-chapter bibliographies, and there isn't one in
`marketing/List of Papers/`. Drop the PDF in there and `bun run fixtures` picks
it up — no test code changes, the suite enumerates the directory. Do that before
writing any of Phase 4, per the sketch above: today's four fixtures all have
exactly one reference section, so they can prove step 1 neutral but say nothing
about steps 2 and 3.

---

## Phase 4 — multi-reference support

### 4a. Where the singular assumption lives

Five places, traced:

1. **`src/analysis/reference_builder.js:262`** — literally
   `// Currently only supports one reference section` before `break outerLoop`.
   All three detection tiers (outline / heading / backward-probe) return the
   first hit and stop.
2. **`buildReferenceIndex()` returns one flat `{anchors, format, sectionStart,
   sectionEnd}`** (`reference_builder.js:101-114`). One `format` for the whole
   document — a book with per-chapter bibliographies can legitimately mix them.
   Phase 1 gave that return value a `ReferenceIndex` typedef
   (`reference_builder.js:22-31`), which is the thing 4b replaces.
3. **`anchor.index` is a document-global number**, and
   `findReferenceByIndex(anchors, index)` (`reference_builder.js:1146`) is
   `anchors.find(a => a.index === index)`. Two bibliographies both starting at
   `[1]` collide on the first lookup.
4. **Three builders cache the section as two scalars** and test containment with
   `pageNum > start && pageNum <= end`:
   - `citation_builder.js:64-65`, cached at `:78-80`, tested at `:135-136`
   - `cross_reference_builder.js:58-59`, cached at `:80-82`
   - `inline_extractor.js:260-262`, tested at `:268`
5. **`citation.refIndices: number[]`** — a bare number can no longer identify a
   reference.

Plus the model-level surface: `doc.getReferenceSectionBounds()`
(`model/doc.js:610-616`) returns a single `{startPage, endPage}`.

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
  get isUsable(): boolean;      // replaces the MIN_USABLE_REFERENCES check in model/doc.js:181
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

## Phase 5 — the `doc` ↔ builder cycle — **DONE**

Every analysis builder currently takes the whole model:

```js
createInlineExtractor(doc)        // src/analysis/inline_extractor.js:1286
createCitationBuilder(doc)        // src/analysis/citation_builder.js:502
createCrossReferenceBuilder(doc)  // src/analysis/cross_reference_builder.js:605
```

`doc.js` imports the builders; the builders name `doc.js` back in JSDoc. Each
factory then pulls exactly 4 fields off it.

Meanwhile `doc.js` scatters results across eight mutable fields —
`citationsByPage`, `citationDetails`, `crossRefsByPage`, `crossRefTargets`,
`urlsByPage`, `outline`, `referenceIndex`, `detectedMetadata` — populated by two
divergent code paths, `#buildInlineElements()` (`model/doc.js:385`) and
`#buildNativeFallback()` (`model/doc.js:406`), which produce slightly different
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

### What landed

`src/analysis/pipeline.js` → `.ts` owns both paths and returns one
`DocumentAnalysis`. `PDFDocumentModel` holds `this.analysis` and exposes the old
eight fields as getters, so no call site outside the model changed.

Three things the sketch did not anticipate:

- **`buildOutline()` was making a PDFium call.** It fetched bookmarks itself,
  duplicating the fetch the model already did for its named destinations. It now
  takes `bookmarks` and is synchronous and pure; the model fetches once. That,
  plus `buildReferenceIndex()` having been `async` with nothing to await, makes
  `analyzeDocument()` fully synchronous.
- **The builders were not the only thing holding the model.** `DocumentTextIndex`
  took `doc` too, for `numPages`, page sizes and the engine text fallback. It now
  takes a `PageSource` (`src/analysis/text_index.ts`), and `InlineExtractor` a
  `RawPageTextSource` (`src/analysis/inline_extractor.ts`). `src/pdf/page_source.ts`
  is the only place either becomes a PDFium call. This is what makes the engine
  constructible from a fixture — the whole pipeline now runs in Bun against a
  synthetic `PageSource`, with no wasm and no model, which is what Phase 3 needs.
- **One behaviour change.** Previously, a usable reference index with a missing
  `lowLevelHandle` produced no citations at all and no warning; it now takes the
  native fallback, like the insufficient-index case already did.

`scripts/check_layering.mjs`'s allowlist is empty: `src/analysis/` has no
reference into `src/pdf/`, runtime or type.

---

## Phase 6 — interface cleanups — **DONE**

Independent of the above; do them opportunistically.

**Push the option-object pattern down.** These still take a whole parent:
`new NavigationTree(this)`, `new PaneControls(this)`, `new PageView(this, ...)`,
`new TextSelectionManager(this)`, `new AnnotationManager(this)`.
`floating_toolbar/index.js` shows the better shape. Each conversion makes one
more file unit-testable.

**Type the event bus.** `doc.notify(event, data)` is stringly-typed;
`viewer/viewpane.js:861` does `event.startsWith("annotation-")`. Make the event
set an exported frozen const, the way `CitationFlags` already is.

**Let non-pane components subscribe.** Only `ViewerPane` subscribes today, so
`main.js:200-201` and `:332-333` reach in imperatively:

```js
wm.toolbar?.navigationTree?.reinitialize();
wm.progressBar?.buildSectionMarks();
```

That's `main.js` knowing the internals of two UI subtrees. If both subscribe to
`index-ready`, those lines disappear.

**Consolidate the pending-PDF contract.** `main.js:23-24` and
`platform/ingest.js:14-15` both declare `PENDING_DB_NAME`/`PENDING_DB_STORE`;
`ingest.js` owns the write (`parkInPage`, `:28`), `main.js` owns the read
(`consumePendingPdf`, `main.js:29`). `ingest.js`'s own header comment says it
exists to keep that contract in one place — so move `consumePendingPdf` and the
whole source-resolution branch there as `resolvePdfSource()` (extension vs dev,
pending vs URL vs background-park). `main.js` drops from 410 lines to roughly
150: resolve → construct → wire.

**One `Rect` type.** `{x, y, width, height}` is re-declared inline in 12 JSDoc
sites across `pdf/text_extractor`, `pdf/pdfium_reader`, `pdf/image_extractor`,
`analysis/inline_extractor`, `analysis/citation_builder`,
`analysis/cross_reference_builder` and `ui/controls/search/search_controller`.
PDFium's `{origin, size}` shape is converted by hand in
`analysis/citation_builder.js:184-189` and `model/doc.js:432-437`. One named
`Rect` plus a `rectFromPdfium()` converter removes a whole class of bug.

---

### What landed

All five bullets, plus what each surfaced:

- **Option objects.** `PaneControls`, `PageView`, `AnnotationManager` and
  `NavigationTree` take the slice of their parent they use, with getters for
  anything read later (`getScroller` — `PaneControls` is built before the
  scroller exists). `TextSelectionManager` turned out to take the whole pane and
  never touch it, so it now takes nothing. The annotation layer went further: the
  pane had been serving as an event bus between `AnnotationManager` and children
  it constructs itself (`AnnotationSVGLayer` read back `pane.onAnnotationHover`
  that the manager had assigned). Handlers now travel parent-to-child, and
  `src/ui/annotation/host.js` names the pane surface the layer needs. The pane's
  five callback fields survive only for the outside callers that use them
  (the drawing controller, the navigation tree).
- **Typed event bus.** `src/model/doc_events.ts`, `DocEvent` frozen const plus
  `ANNOTATION_EVENTS`. Closing the set found `highlight-added`: nothing emitted
  it, `doc.highlights` was never written, and its handler called a
  `renderHightlights` that does not exist — dead, removed with the field.
- **Non-pane subscribers.** `NavigationTree` and `ProgressBar` subscribe to
  `index-ready`; `main.js` no longer reaches into two UI subtrees.
- **Pending-PDF contract.** `resolvePdfSource()` in `src/platform/ingest.js` owns
  every source (pending store → background park → direct fetch → dev default).
  `main.js` is 410 → 262 lines: resolve → construct → wire, plus the status-message
  table and the onboarding/trail composition, which are viewer concerns.
- **One `Rect`.** `Rect`, `Point`, `PdfiumRect`, `PathObjectInfo`, `PageLocation`
  and `RefIndex` are global in `src/types/index.d.ts`; `rectFromPdfium()` lives in
  `src/analysis/geometry.ts` and replaced four hand-written conversions.

---

## Phase 7 — the `.ts` renames — **engine half done**

Only after Phases 1–5. By then the types that matter already exist as JSDoc that
compiles.

1. **Write `src/types/index.d.ts` first** — `Rect`, `TextLine`, `PageData`,
   `OutlineItem`, `ReferenceAnchor`, `ReferenceSection`, `RefRef`, `Citation`,
   `CrossRef`, alongside the `globals.d.ts` Phase 1 added. Do this alongside
   Phase 4b; writing the types is how the remaining single-section assumptions
   surface. It is also where `PathObjectInfo` belongs, which retires the last
   allowlisted `analysis/` → `pdf/` type reference.
2. **Rename leaves-first:** `platform/util/` → `lexicon` → `layout_heuristics` →
   `pdfium_ffi` → `text_index` → builders → `model/doc.js` → `ui/` last. Under
   `moduleResolution: "bundler"` the existing `./foo.js` imports resolve to
   `foo.ts` unchanged, so imports need no edits.
3. **Enable `strict` per-directory** as each one lands. Leave `strictNullChecks`
   for last — it's the expensive one, given how much of this code optional-chains
   against nullable model fields.

### Friction to expect

- **DOM expando properties**: `el._crossRefData` (`viewer/page.js:434` sets it,
  `:707` and `:727` read it) and `imgRect._imageInfo` (`:335`). Phase 1 declared
  both on `HTMLElement` in `src/types/globals.d.ts` to get to zero errors; the
  real fix is `WeakMap<Element, CrossRef>`, which is better code anyway. The
  `dataset` string round-trips are already handled — Phase 1 put `String()` on
  every numeric write.
- **`PdfiumFFI` pointer arithmetic** — type pointers as plain `number`. Branded
  types are not worth it there. Phase 1 added a `PdfiumHeaps` typedef and a
  `#heap` getter for the HEAP views `@embedpdf/pdfium` omits from its own types.
- **`Config.get(key)` is the best free win.** Typing it from `SCHEMA` via
  `keyof typeof SCHEMA` yields literal-typed config values and catches typo'd
  keys across the 10 files that import it. Roughly 20 lines of type code.

---

### What landed

`tsconfig.strict.json` is the mechanism: it extends the base config with
`strict: true` (minus `strictNullChecks`) and `include`s only the subtrees that
have been converted. `bun run typecheck` runs the permissive whole-program check,
then the strict tier, then the Node tier — so a converted file is held to both
and an unconverted one cannot quietly regress the tier.

Converted and strict-clean, leaves first as planned:

    src/types/          Rect, Point, PdfiumRect, PathObjectInfo, PageLocation, RefIndex
    src/platform/util/  base64
    src/analysis/       all ten modules, ~7.2k lines
    src/pdf/            all six modules, ~1.6k lines
    src/model/          doc_events

Left as `.js`: `model/doc`, `model/annotation_data`, `platform/ingest`,
`viewer/`, `ui/`, `main.js`, and the three root extension entry points. The
order to continue in is unchanged — `model/` next, `ui/` last. `model/doc.js`
and `model/annotation_data.js` are the ones Phase 3's snapshots cover, and those
now exist, so they are ready to convert; `viewer/` and `ui/` are gated on manual
verification instead.

Friction, against what was expected:

- **`Config.get(key)` typed from `SCHEMA`** is still the best free win, and is
  still unclaimed — `ui/settings/config.js` has not been converted.
- **The DOM expandos** are still declared on `HTMLElement` in `globals.d.ts`.
  `_imageInfo`'s only writer went with the parked image overlay renderer;
  `_crossRefData` waits for `viewer/page.js`.
- **`PdfiumFFI` pointer arithmetic** as plain `number` was the right call.
  `PdfiumHeaps` is now a real exported interface, and `ui/tools/region_select.js`
  stopped reaching for `HEAPU8` directly — it goes through `ffi.bytes()`, the one
  place the gap in `@embedpdf/pdfium`'s module type is papered over.

---

## Suggested order

Execution order, which is not the same as the phase numbering above:

| Order | Work | Phase | Why here |
|---|---|---|---|
| ~~1~~ | ~~`checkJs` + fix broken JSDoc~~ **done** | 1 | ~1 day, no renames, immediate LSP payoff |
| ~~2~~ | ~~Split `data/` → `pdf/` + `analysis/`~~ **done** | 2 | mechanical; unlocks the tests |
| ~~3~~ | ~~`analyzeDocument()` pipeline, kill the cycle~~ **done** | 5 | taken early; the plan allows 4↔5 |
| ~~4~~ | ~~Interface cleanups~~ **done** | 6 | explicitly independent of everything else |
| ~~5~~ | ~~`.ts` renames, engine half~~ **done** | 7 | needed 1–5; `ui/` deferred, see above |
| ~~6~~ | ~~Snapshot tests on fixture PDFs~~ **done** | 3 | had to exist before the parser changes — and before `ui/` is renamed |
| 7 | Section-scoped types, `sections: [one]` ← **next** | 4, step 1 | behavior-neutral; snapshots prove it |
| 8 | Multi-section detection + per-section format | 4, steps 2–3 | the actual feature |
| 9 | `.ts` renames, `viewer/` + `ui/` | 7 | the remaining ~26k lines |

Orders 1–3 are worth doing even if multi-reference support is deferred; they pay
for themselves in tooling and regression safety. The 4-before-6 split is the
part not to shortcut.

Order 7 needs one thing order 6 could not supply: a multi-bibliography fixture
PDF. See the end of Phase 3.
