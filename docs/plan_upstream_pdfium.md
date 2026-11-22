# Plan: Move to Upstream PDFium (bblanchon builds)

Replace EmbedPDF's PDFium wasm (`@embedpdf/pdfium`) with Google's PDFium, as
built by [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries).

This is step two. It assumes `docs/plan_own_pdf_engine.md` is done: Hover
calls only standard `FPDF*` functions through `PdfiumBindings`, and nothing
imports `@embedpdf/engines`. Without that, this plan doesn't apply.

Written 2026-11-20. Facts about the bblanchon build were checked against
release `chromium/8165` (published 2026-11-16, PDFium `160.0.8165`) unless
marked **unverified**.

---

## 1. Why

- **EmbedPDF's wasm is a fork with its own update schedule.** The 2.15.0
  binary is built from `embedpdf/pdfium` at `cb29e78` (2026-06-08). That fork's
  newest Google commit is `7cfa57a912` (2026-02-14). So Hover ships PDFium
  about nine months behind Google, security fixes included, and gets newer
  fixes only when EmbedPDF merges them and publishes a release.
- **The fork's additions are ones Hover won't use once plan one is done.** It
  adds 155 commits (+14.5k lines), mostly annotation editing, redaction and
  bookmark editing. It changes nothing in text extraction (`fpdftext`) and
  only a build line in rendering (`fxge`). After plan one, Hover calls none of
  its `EPDF*` additions.
- **bblanchon/pdfium-binaries is the de facto upstream binary.** It builds
  stock Google PDFium for every platform, wasm included, on a regular cadence
  that tracks Chromium, with `args.gn` and licences in each release.

**Not a reason:** font rendering. Both binaries draw glyphs with FreeType
grayscale anti-aliasing in wasm (`docs/text_rendering.md`). Expect the same
look, give or take nine months of upstream changes.

## 2. The two binaries side by side

|                         | `@embedpdf/pdfium` 2.15.0                     | bblanchon `chromium/8165`                                    |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| PDFium source           | EmbedPDF fork, Google base 2026-02-14         | Google PDFium `160.0.8165`                                   |
| Exports                 | 420 `FPDF*` + 138 `EPDF*` + `PDFiumExt_*`     | 433 `FPDF*`                                                  |
| wasm size               | 4.6 MB                                        | 5.6 MB                                                       |
| JS glue                 | `MODULARIZE` factory, wrapped (`init()`)      | **Not modularized**: assigns a global `var Module`, classic script |
| Runtime on the module   | `addFunction`, `UTF16ToString`, `wasmExports`, … | `_malloc`, `_free`, `addFunction`, `removeFunction`, `ccall`, `cwrap`, every `HEAP*` view |
| Table growth for `addFunction` | `ALLOW_TABLE_GROWTH=1`                 | Grows on demand (phase 0)                                     |
| V8 / XFA / Skia         | off / off / geometry-only Skia for redaction  | off / off / off (`args.gn`)                                  |
| Licence files           | `LICENSE.pdfium`                              | `LICENSE` plus 16 third-party licences (FreeType, ICU, libjpeg-turbo, OpenJPEG, lcms, HarfBuzz, abseil, …) |

Every function plan one needs is in `chromium/8165`. Checked by name:
- open, save and init: `FPDF_InitLibraryWithConfig`, `FPDF_SaveAsCopy`;
- rendering: `FPDF_RenderPageBitmap`, `FPDF_FFLDraw`;
- text and page geometry: `FPDFText_GetLooseCharBox`, `FPDFText_GetFontInfo`,
  `FPDFTextObj_GetTextRenderMode`, `FPDF_PageToDevice`,
  `FPDF_GetPageSizeByIndexF`, `FPDFPage_GetRotation`;
- annotations: `FPDFAnnot_SetColor`, `AddInkStroke`,
  `AppendAttachmentPoints`, `SetStringValue`, `SetFlags`, `SetRect`, `SetAP`,
  `GetInkListPath`, `GetNumberValue`, `FPDFPage_RemoveAnnot`;
- links, bookmarks and metadata: `FPDFAnnot_GetLink`, `FPDFLink_GetAction`,
  `FPDFAction_GetURIPath`, `FPDFBookmark_GetFirstChild`, `FPDF_GetNamedDest`,
  `FPDF_GetMetaText`.

`FPDFAnnot_SetNumberValue` is absent, as in every upstream build. Plan one
phase 5 resolves opacity without it.

## 3. Phases

### Phase 0: Spike (throwaway branch)

Answer the unknowns before building anything.

- [x] **Table growth.** Load the bblanchon glue under `bun test`, call
      `addFunction(fn, "iiii")`, and pass the pointer to `FPDF_SaveAsCopy` on
      a fixture. If the table can't grow, the save callback is impossible on
      this binary; go to §5.
- [x] **Bindings.** Implement `PdfiumBindings` over the raw `Module._FPDF_*`
      exports and run plan one's whole test suite against it. List every
      failure.
- [x] **Goldens.** Diff the render, text, annotation and save goldens against
      the EmbedPDF binary. Sort each diff into "upstream change" or "our bug".
- [x] **Browser load.** Load it in the Chrome extension build under the
      current CSP (`script-src 'self' 'wasm-unsafe-eval'`).

**Exit:** a written yes or no, with the diff list. If no, stop and pick from
§5.

#### Phase 0 result (2026-11-22): yes, pinned to `chromium/8100`

**Decision:** vendor `chromium/8100` (2026-10-12, the last release before
item 2 below; tarball SHA-256
`0d68fef9aca2c69f20717c697f90f4fcb7d66a7a30307ad527769d18707394c8`, wasm
5.4 MB). On 8100 the suite fails only on items 1 and 4, both new goldens to
accept. Re-check item 2 at each bump, and move past 8111 once it is fixed
upstream. **Security wins:** if a PDFium security fix that affects parsing
lands while item 2 is still open, take the fix and accept the lighter rules.
Don't hold the pin, and don't build our own binary just to revert item 2.

The checks below were run against `chromium/8165` (tarball SHA-256
`febcdebc11b2a015d3b7e3614085ca7bfd381deb76445a6949cf00966c9edf25`).

- **Table growth: works.** The table starts full at 3326 entries and grows on
  demand. 200 `addFunction(…, "iiii")` calls succeed, and `FPDF_SaveAsCopy`
  writes a valid file through the callback. §5 isn't needed.
- **Bindings: no code change.** `bind()` in `pdfium_module.ts` binds every
  `PdfiumFunctions` name, `FPDF_RenderPageBitmapWithMatrix` included, against
  the upstream module unchanged. The glue exports every heap view Hover reads
  (`HEAPU8`, `HEAP32`, `HEAPU32`, `HEAPF32`, `HEAPF64`), not just the three §2
  lists. The spike swapped the module in through a `mock.module` in the bun
  preload. Result: 121 of 141 tests pass. The document, text, outline,
  metadata, link and analysis snapshots are identical. The 20 failures are 17
  render hashes and 3 annotation-save tests.
- **Glue wrapping.** The glue runs inside a factory if `var Module = moduleArg`
  sits in the *same* function scope as the glue, because the glue re-declares
  `var Module`. `process`, `require`, `module` and `__dirname` must be shadowed
  as `undefined`; otherwise under bun it takes its Node path and calls
  `require("fs")`. Resolve on `onRuntimeInitialized` and reject on `onAbort`.
  When `wasmBinary` is passed, the glue never fetches.
- **Browser: works under the CSP.** Tested on Chrome 157 (headless) with a page
  served from 127.0.0.1 under the extension's exact CSP as a meta tag. The
  page loads the wrapped glue, renders a page, grows the table and saves.
  Removing `'wasm-unsafe-eval'` makes it fail, so the CSP was enforced. The
  glue has no `eval` or `new Function`; its only generated code is wasm
  (`addFunction`'s signature thunk). Not yet tried in the real extension build
  (that's phase 3), Firefox or Safari.

**The fork changes nothing that Hover sees.** bblanchon `chromium/7690`
(2026-02-16, just after the fork's Google base) passes all 141 tests
byte-identical to `@embedpdf/pdfium` 2.15.0. So every diff below is an upstream
change between February and November, not an EmbedPDF patch. Each was bisected
to a pair of bblanchon releases:

| # | Diff | Introduced | Verdict |
| - | ---- | ---------- | ------- |
| 1 | Glyph anti-aliasing: every text page differs by at most 4 levels, on 2–10% of pixels | 7690 → 7699 | Upstream change. Accept; re-check `text_gamma.ts` §5 in phase 4 |
| 2 | Edges of sub-pixel fills (thin rules) and some image edges are now drawn with proportional coverage instead of snapped to a solid pixel. A black hairline rule at 1× goes from 0 to 191 (light gray); at 2.5× from 0 to about 103. Seen on the Elsevier headers, ncomms and rotate-example. No render flag restores it: `FPDF_RENDER_NO_SMOOTHPATH` drops the rule entirely. Cause: PDFium `b02da6c41c`, "Stop recognizing open, 3-sided paths as rectangles". A rule drawn as `m l l l f` (no `h`) is no longer treated as a rectangle, although a fill closes it implicitly. With `h` or `re` it still renders solid | 8100 → 8111 | Upstream change, and a **visible regression** for table and header rules. **Pinned below it** (see the decision above) |
| 3 | `FPDFPage_CreateAnnot` writes the new annotation as an indirect object, no longer inline in `/Annots` (the snapshot's `"direct":true` goes away). PDFium `89660bafdb`, "Store annotations as indirect objects in /Annots" | 8152 → 8165 | Upstream change, harmless (the spec requires indirect). Update the snapshot |
| 4 | `/CA` is written with shortest round-trip digits: `0.5019608`, not `0.50196081` | 8009 → 8021 | Upstream change, harmless. Update the snapshot |
| 5 | An annotation created and then removed **in the same session** (deleted, or recreated by `updateAnnotation` when a comment is cleared or segments shrink) stays in the saved file as an unreferenced object, `/Contents` included. Readers don't show it, but the deleted comment's text is still in the bytes. Caused by item 3 (same commit); see below | 8152 → 8165 | **Hover must handle it** before moving past 8152. Fix below |

None of the five is "our bug" in the sense of Hover calling PDFium wrongly.
Item 2 and item 5 are the only ones that need work beyond accepting new
goldens.

**Why item 5 happens.** A full-rewrite save (`CPDF_Creator`) treats old and new
objects differently. `WriteOldObjs()` writes only the objects from the loaded
file that are still reachable from the trailer (`GetObjectsWithReferences`).
`WriteNewObjs()` writes *every* object created since load, reachable or not.
Before `89660bafdb`, a created annotation was a dict inline in `/Annots`, so
removing it from the array removed it from the file. Now it is a new indirect
object, and `FPDFPage_RemoveAnnot` only drops the reference to it.

**The same asymmetry already leaks on EmbedPDF's binary.** An appearance stream
is always a new indirect object, so each in-place `updateAnnotation` leaves the
replaced `/AP` stream in the saved file. Five edits to one highlight save six
streams. These leaks hold only geometry and colour, no text, but they grow the
file with every edit.

**Fix: write annotations only on save, into a fresh copy.** Hover already owns
the annotation model. `AnnotationStore` reads the file's annotations once at
load, and the viewer draws them itself (`FPDF_ANNOT` is off in `renderer.ts`).
The only reason PDFium holds Hover's edits at all is `saveWithAnnotations()`.
Today the store writes each edit through to the live document (`#create`,
`#update`, `#remove` in `annotation_data.ts`), and that write-through is what
leaves the garbage.

Instead, each save:
1. opens a second `PdfiumDocument` from the original bytes (the live document
   already keeps them in the wasm heap);
2. applies the net change from the file as loaded: removes the loaded
   annotations the user deleted, rewrites the changed ones, creates the new
   ones;
3. saves it and closes it.

The live document is never written to after load.

Every annotation is written at most once into a document that never removes
it, so no new object can be orphaned. Removed annotations and replaced
appearance streams from the loaded file are old objects, which
`WriteOldObjs()` drops once nothing refers to them. That holds on every
binary, so this fixes item 5 and the appearance-stream leak together. Every
save starts from the original, so repeated saves in one session behave the
same.

Applying the edits to the live document only at save time would not be enough.
Annotations written by one save are new objects in that document, so an
edit or delete before the next save would orphan them again.

Costs: the store must track a change set instead of applying each edit as it
happens, and the second parsed copy exists only during a save (about the cost
of one load: 20–30 ms on a 1 MB paper). A write that fails now shows up at save
time instead of at edit time. Today such failures are only logged
(`console.warn`), so the user loses nothing.

Rejected:
- **compact on save** (save, reload, save again): measured on 8165, it removes
  the deleted comment's text and cuts 6 appearance streams to 1 for the same
  20–30 ms. But it creates the garbage first and then relies on a reload to
  clean it up;
- **blanking the annotation before removing it:** there is no public call to
  delete a key, so `/NM`, `/Rect` and `/QuadPoints` would survive. It also
  doesn't touch the appearance-stream leak;
- **avoiding remove-and-create:** impossible when a comment is cleared or
  quads shrink, and a user's delete is a remove anyway.

**Upstream reports.** Drafts with minimal repro PDFs, verified on the
bblanchon builds on either side of each change, are in `docs/pdfium_reports/`:
- `open_rect_fill.md` for item 2;
- `create_remove_annot_leak.md` for item 5.

They haven't been filed yet.

### Phase 1: Write annotations only on save

Phase 0 item 5. It doesn't depend on the binary and fixes the
appearance-stream leak on today's binary, so it comes first and lands as its own commit.

- `AnnotationStore` keeps what it loaded from the file: each annotation's
  pages, its locator while it has no `/NM` (`#unnamed`), and the comment
  notes (`#linkedNotes`). Edits only update the model and mark the id dirty.
  Deleting a loaded annotation records it as removed. Creating and then
  deleting one before a save leaves nothing to do.
- `PdfiumDocument` gets a way to open a second document over its original
  bytes, with the same password, so the save copy and the live document
  never share state.
- `saveWithAnnotations()` opens the copy and applies the changes. It removes
  the deleted loaded annotations and notes. Each dirty loaded annotation is
  updated in place, or removed and recreated when its pages or type
  changed. Each dirty new annotation is created. Then it saves the copy and
  closes it.
- Nothing outside the save path calls `annotation_writer.ts` on the live
  document.
- Tests:
  - a deleted comment's text is absent from the saved bytes;
  - N in-place edits save one `/AP` stream;
  - creating and deleting an annotation before saving leaves the file's
    annotations as loaded;
  - two saves with edits in between are each correct;
  - the existing round-trip snapshots don't change on the EmbedPDF binary.

**Exit:** the tests above pass on the EmbedPDF binary and on `chromium/8165`
(the release where item 5 appears), and `annotation_writer.ts` has no caller
outside the save path.

### Phase 2: Vendoring

The glue isn't an ES module and isn't on npm, so Hover vendors it.

- [ ] Write `scripts/vendor_pdfium.ts`. It:
  1. downloads a **pinned** release tag (`chromium/NNNN`);
  2. checks the tarball's SHA-256 against a value committed in the script;
  3. wraps `lib/pdfium.js` into an ES module factory
     (`export default function createPdfium(moduleArg) { var Module = moduleArg; …glue…; return ready }`),
     resolving on `onRuntimeInitialized` and rejecting on `onAbort`. Phase 0
     proved the shape: `var Module` must share the glue's function scope, and
     `process`, `require`, `module` and `__dirname` must be shadowed;
  4. copies `pdfium.wasm`, the wrapped glue, `VERSION`, `args.gn` and
     `licenses/` into `vendor/pdfium/`.
- [ ] Commit `vendor/pdfium/` so builds don't depend on the network. Store
      builds already refuse the CDN (`__LOCAL_WASM_ONLY__`). The repo grows
      by about 5 MB per bump (about 65 MB a year at a monthly cadence). That
      was accepted over Git LFS or downloading at build time (2026-11-22).
- [ ] Copy `pdfium.wasm` into each browser build (today it comes from
      `@embedpdf/pdfium`), and the licence files into the extension's
      licences folder.
- [ ] **Firefox AMO.** The glue is generated, minified code. Note its origin
      (release URL and SHA-256) and the vendoring script in the reviewer notes
      before the first submission.

### Phase 3: Switch the bindings

- [ ] In `pdfium_module.ts`, add a second `PdfiumBindings` implementation
      over the vendored module. Function calls become `Module._FPDF_X(...)`.
      Plan one already passes only pointers and numbers, so no string
      marshalling changes.
- [ ] Add a build-time switch (`__PDFIUM_SOURCE__ = "embedpdf" | "upstream"`)
      so both binaries can ship from one tree for a release cycle. Default to
      `embedpdf` until phase 4 passes.
- [ ] Make the FFI rely only on what both modules export: `_malloc`, `_free`,
      `HEAPU8`, `HEAP32`, `HEAPU32`, `HEAPF32`, `HEAPF64`, `addFunction` and
      `removeFunction`. Phase 0 found nothing else in use.

### Phase 4: Review the differences

Eight months of upstream PDFium (to the `chromium/8100` pin) will change some
output. Phase 0 found two such changes on 8100: items 1 and 4. Each changed golden
needs a recorded reason.

- [ ] **Render goldens.** Expect small anti-aliasing and font differences.
      Review them visually, side by side. Text gamma (`text_gamma.ts`) is
      fitted to the current raster, so re-check its §5 measurements on the
      new binary.
- [ ] **Text.** Re-run the analysis fixtures. A change in PDFium's character
      list (ligatures, generated spaces, hyphen handling) moves character
      indices, and the inline and citation extractors key off them. Rebuild
      the fixtures with `bun run fixtures` only after the diffs are
      understood.
- [ ] **Annotations and save.** Run the round trip. Check the saved-file
      `/AP`, blend mode and the absence of empty `/Contents` and `/T` in
      Preview, Acrobat and Chrome again.
- [ ] **Performance.** Compare first-page time and a full-document index on a
      large paper. The binary is about 21% bigger, so check the extension's cold
      start.

**Exit:** every changed golden has a reason. Plan one's manual pass (§6) is
clean on all three browsers with `__PDFIUM_SOURCE__ = "upstream"`.

### Phase 5: Make it the default and remove EmbedPDF

- [ ] Ship one release with `upstream` as the default and `embedpdf` still
      buildable.
- [ ] Next release: remove `@embedpdf/pdfium`, the switch and the EmbedPDF
      bindings.
- [ ] Update `docs/pdf_lifecycle.md` (where the wasm comes from) and
      `docs/text_rendering.md` (§2 build facts, §5 "upstream ask"). The ask
      would now go to Google, or become our own patch (§5).

### Phase 6: Keeping it current

- [ ] Write the update routine into the vendoring script's header:
  1. bump the tag;
  2. update the SHA-256;
  3. run `bun run check` plus the goldens;
  4. review the diffs;
  5. ship.
- [ ] **Cadence:** monthly, and on any PDFium security fix that affects
      parsing. Hover opens untrusted PDFs from the web, so falling behind is
      the risk this plan exists to remove.

## 4. Risks

| Risk                                                         | Mitigation                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| The `addFunction` table can't grow (save impossible)         | Ruled out in phase 0                                                    |
| Hairline rules render lighter from `chromium/8111` (phase 0 item 2) | Pinned to `chromium/8100`; re-check at each bump. A parsing security fix overrides the pin |
| Upstream text changes shift indices the analysis relies on   | Fixture diffs reviewed in phase 4; plan one already maps indices in one place (`text_extractor.ts`) |
| Glue wrapping breaks on a future Emscripten version          | The vendoring script fails loudly; the SHA-256 pin means nothing changes without a deliberate bump |
| bblanchon stops publishing wasm                              | Their build scripts are open source and run on GitHub Actions; §5 (b)   |
| A binary about 21% larger slows cold start                         | Measured in phase 4; the wasm already loads once per tab                |

## 5. If Phase 0 says no

- **(a) Save without `addFunction`.** Not available. `FPDF_SaveAsCopy` only
  writes through a callback in the function table, so this needs a build
  change.
- **(b) Build upstream ourselves.** Use bblanchon's own build scripts in a
  GitHub Actions workflow, adding `-sALLOW_TABLE_GROWTH=1` and
  `-sMODULARIZE=1`. This is still Google's source, with only Emscripten link
  flags changed. It also makes a carried patch possible: the glyph-emboldening
  change in `docs/text_rendering.md` §5 (D). The cost is owning a
  depot_tools/emsdk build. Run it from CI, never from a laptop.
- **(c) Stay on EmbedPDF's binary for now.** After plan one this is a
  supported state, not a dead end. Re-check with each bblanchon release.
