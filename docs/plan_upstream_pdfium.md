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
| Runtime on the module   | `addFunction`, `UTF16ToString`, `wasmExports`, … | `_malloc`, `_free`, `addFunction`, `removeFunction`, `ccall`, `cwrap`, `HEAPU8`, `HEAP32`, `HEAPF32` |
| Table growth for `addFunction` | `ALLOW_TABLE_GROWTH=1`                 | **Unverified.** The glue throws "Unable to grow wasm table" if the table can't grow |
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

### Phase 0: Spike (1–2 days, throwaway branch)

Answer the unknowns before building anything.

- [ ] **Table growth.** Load the bblanchon glue under `bun test`, call
      `addFunction(fn, "iiii")`, and pass the pointer to `FPDF_SaveAsCopy` on
      a fixture. If the table can't grow, the save callback is impossible on
      this binary; go to §5.
- [ ] **Bindings.** Implement `PdfiumBindings` over the raw `Module._FPDF_*`
      exports and run plan one's whole test suite against it. List every
      failure.
- [ ] **Goldens.** Diff the render, text, annotation and save goldens against
      the EmbedPDF binary. Sort each diff into "upstream change" or "our bug".
- [ ] **Browser load.** Load it in the Chrome extension build under the
      current CSP (`script-src 'self' 'wasm-unsafe-eval'`).

**Exit:** a written yes or no, with the diff list. If no, stop and pick from
§5.

### Phase 1: Vendoring

The glue isn't an ES module and isn't on npm, so Hover vendors it.

- [ ] Write `scripts/vendor_pdfium.ts`. It:
  1. downloads a **pinned** release tag (`chromium/NNNN`);
  2. checks the tarball's SHA-256 against a value committed in the script;
  3. wraps `lib/pdfium.js` into an ES module factory
     (`export default function createPdfium(moduleArg) { var Module = moduleArg; …glue…; return ready }`),
     resolving on `onRuntimeInitialized`;
  4. copies `pdfium.wasm`, the wrapped glue, `VERSION`, `args.gn` and
     `licenses/` into `vendor/pdfium/`.
- [ ] Commit `vendor/pdfium/` so builds don't depend on the network. Store
      builds already refuse the CDN (`__LOCAL_WASM_ONLY__`).
- [ ] Copy `pdfium.wasm` into each browser build (today it comes from
      `@embedpdf/pdfium`), and the licence files into the extension's
      licences folder.
- [ ] **Firefox AMO.** The glue is generated, minified code. Note its origin
      (release URL and SHA-256) and the vendoring script in the reviewer notes
      before the first submission.

### Phase 2: Switch the bindings

- [ ] In `pdfium_module.ts`, add a second `PdfiumBindings` implementation
      over the vendored module. Function calls become `Module._FPDF_X(...)`.
      Plan one already passes only pointers and numbers, so no string
      marshalling changes.
- [ ] Add a build-time switch (`__PDFIUM_SOURCE__ = "embedpdf" | "upstream"`)
      so both binaries can ship from one tree for a release cycle. Default to
      `embedpdf` until phase 3 passes.
- [ ] Make the FFI rely only on what both modules export: `_malloc`, `_free`,
      `HEAPU8`, `HEAP32`, `HEAPF32`, `addFunction` and `removeFunction`. Phase
      0 reports anything else as a failure.

### Phase 3: Review the differences

Nine months of upstream PDFium will change some output. Each changed golden
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

### Phase 4: Make it the default and remove EmbedPDF

- [ ] Ship one release with `upstream` as the default and `embedpdf` still
      buildable.
- [ ] Next release: remove `@embedpdf/pdfium`, the switch and the EmbedPDF
      bindings.
- [ ] Update `docs/pdf_lifecycle.md` (where the wasm comes from) and
      `docs/text_rendering.md` (§2 build facts, §5 "upstream ask"). The ask
      would now go to Google, or become our own patch (§5).

### Phase 5: Keeping it current

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
| The `addFunction` table can't grow (save impossible)         | Phase 0 checks it first; §5 has the fallback                            |
| Upstream text changes shift indices the analysis relies on   | Fixture diffs reviewed in phase 3; plan one already maps indices in one place (`text_extractor.ts`) |
| Glue wrapping breaks on a future Emscripten version          | The vendoring script fails loudly; the SHA-256 pin means nothing changes without a deliberate bump |
| bblanchon stops publishing wasm                              | Their build scripts are open source and run on GitHub Actions; §5 (b)   |
| A binary about 21% larger slows cold start                         | Measured in phase 3; the wasm already loads once per tab                |

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
