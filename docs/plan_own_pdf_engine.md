# Plan: Own the PDFium JS Layer

Replace `@embedpdf/engines` with Hover's own JS layer over the same PDFium wasm.
This is step one of two. Step two, moving the wasm itself to Google's PDFium,
is in `docs/plan_upstream_pdfium.md`.

Written 2026-11-20 against Hover `0.10.5`, `@embedpdf/engines` /
`@embedpdf/pdfium` `2.15.0`. File references point at the function that owns
the behaviour.

---

## 1. Why

- **Hover already owns half of the stack.** About 1,900 lines in `src/pdf/`
  call PDFium directly: text, glyph geometry, path objects, visible-text
  boxes, images. The engine is a second, overlapping route into the same wasm.
- **Hover uses only a small part of the engine.** About a dozen methods (§3).
  The engine is a ~10k-line bundle (`direct-engine-*.js`) built for a
  general-purpose viewer.
- **Upstream has moved on.** EmbedPDF 3.x replaces `@embedpdf/engines` with
  `@embedpdf/engine`. It runs PDFium in a worker and exposes no raw module, so
  Hover's low-level reads have no home there. 2.x only receives backports.
- **Several current workarounds exist only because of the engine:**
  - the second document handle (`docs/pdf_lifecycle.md` §4);
  - the rect-orientation guess (`src/pdf/annotations.ts`);
  - the byte-level stripping of empty `/Contents` and `/T` in saved files
    (`src/pdf/annotation_export.ts`);
  - render flags hard-coded to `16` (`docs/text_rendering.md` §2).

## 2. Scope

**In scope**

- Every `@embedpdf/engines` and `@embedpdf/models` import, in `src/` and in
  `scripts/build_fixtures.ts`.
- One PDFium document per open file, instead of two.
- Hover's own types for pages, annotations, links, bookmarks and metadata.

**Out of scope**

- **The wasm binary.** Keep `@embedpdf/pdfium` 2.15.x, pinned exactly (drop
  the `^`).
- **A worker.** Rendering stays on the main thread, as it is today (see
  `RenderScheduler`).
- **Font rendering.** Glyphs are still rasterized by FreeType in the wasm. The
  text gamma (`src/viewer/text_gamma.ts`) stays. Owning the render call does
  make render flags reachable, but changing them is a separate change, after
  pixel parity is proven.

### The ground rule

The new layer may call **only standard `FPDF*` functions** and standard
Emscripten runtime methods. It must not call any `EPDF*` or `PDFiumExt_*`
symbol. This is what lets plan two be a binary swap rather than a second
rewrite.

| Non-standard symbol in use today      | Where                      | Standard replacement                                                           |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `PDFiumExt_Init`                      | `pdfium_init.ts:81`        | `FPDF_InitLibraryWithConfig` with a config struct built in the FFI             |
| `PDFiumExt_SaveAsCopy` + file writer  | inside `engine.saveAsCopy` | `FPDF_SaveAsCopy` with an `FPDF_FILEWRITE` whose `WriteBlock` is `addFunction` |
| 119 `EPDF*` calls (112 `EPDFAnnot_*`) | inside the engine          | `FPDFAnnot_*` (§5, phase 5)                                                    |
| `/EPDFCustom` marker                  | `annotation_export.ts:22`  | Not needed: the file is deleted (phase 5)                                      |

`@embedpdf/pdfium` exports `addFunction` (its build sets
`ALLOW_TABLE_GROWTH=1`), so the save callback works on the current binary.

## 3. The surface being replaced

| Engine call                 | Call sites                                                     | PDFium replacement                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openDocumentBuffer`        | `model/doc.ts:176`                                             | `FPDF_LoadMemDocument`. The low-level handle already does this.                                                                                                                            |
| `closeDocument`             | `model/doc.ts:545`                                             | `FPDF_CloseDocument`, then free the file buffer                                                                                                                                            |
| `saveAsCopy`                | `model/doc.ts:447`                                             | `FPDF_SaveAsCopy` + `FPDF_FILEWRITE`                                                                                                                                                       |
| `renderPageRaw`             | `viewer/page.ts:238`, `share/annotated_pages.ts:49`            | `FPDFBitmap_CreateEx` + `FPDF_RenderPageBitmap`                                                                                                                                            |
| `renderPageRect`            | `viewer/page.ts:352`                                           | Same, with a negative start offset and the full-page size, so only the region lands in the bitmap                                                                                         |
| `getMetadata`               | `model/doc.ts:316`, `:331`                                     | `FPDF_GetMetaText`                                                                                                                                                                         |
| `getBookmarks`              | `model/doc.ts:282`                                             | `FPDFBookmark_GetFirstChild` / `GetNextSibling` / `GetTitle` / `GetDest` / `GetAction`                                                                                                     |
| `getPageAnnotations`        | `model/annotation_data.ts:207`, `:745`                         | `FPDFPage_GetAnnotCount` / `GetAnnot`, `FPDFAnnot_GetSubtype` / `GetRect` / `GetAttachmentPoints` / `GetInkListPath` / `GetColor` / `GetStringValue`, `FPDFAnnot_GetLink` → `FPDFLink_*`, `FPDFDest_*`, `FPDFAction_*` |
| `createPageAnnotation`      | `annotation_data.ts:598`, `:653`                               | `FPDFPage_CreateAnnot` + setters (phase 5)                                                                                                                                                 |
| `updatePageAnnotation`      | `annotation_data.ts:717`, `:751`                               | The same setters on the found annotation                                                                                                                                                   |
| `removePageAnnotation`      | `annotation_data.ts:787`, `:819`                               | `FPDFPage_RemoveAnnot`                                                                                                                                                                     |
| `getPageTextRects`          | `pdf/page_source.ts:56` (fallback only)                        | Deleted. With one document there is no "low-level handle failed" case.                                                                                                                    |
| `pdfDoc.pages[i].size`      | `doc.ts`, `page_source.ts`, viewer                             | `FPDF_GetPageSizeByIndexF`. See phase 2 on rotation.                                                                                                                                       |

**What Hover reads back must keep its shape**, because `src/analysis/` reads
it from the annotation objects:

- `annot.rect` (`{origin, size}`, top-left origin);
- `annot.target.type` (`"destination"` or an action);
- `annot.target.destination.pageIndex` and `.view[0..1]`
  (`citation_builder.ts:178`, `cross_reference_builder.ts:430`);
- `annot.target.action.uri` (`indexUrls`).

Freeze these as a Hover type (`NativeLink`) rather than inheriting them from
`@embedpdf/models`.

## 4. Target layout (`src/pdf/`)

| File                      | Owns                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdfium_module.ts` (new)  | Loading the wasm (the current `pdfium_init.ts` URL logic) and a typed `PdfiumBindings` interface listing every function Hover calls, with raw numeric signatures. **The only file that imports `@embedpdf/pdfium`.** |
| `pdfium_ffi.ts`           | Memory, scratch frames, strings. Decode UTF-16 and UTF-8 with `TextDecoder` over `HEAPU8`, not the module's `UTF16ToString` / `UTF8ToString`, which plan two's binary doesn't export. |
| `document.ts` (new)       | `PdfiumDocument`: open, close, save, page count, page sizes, metadata, bookmarks, named destinations. It replaces both the engine doc and `PdfiumDocumentHandle`.             |
| `renderer.ts` (new)       | `renderPage(doc, index, scale)` and `renderRect(doc, index, scale, rect)`, returning `{ data, width, height }` as `ImageData` expects                                         |
| `annotation_reader.ts` (new) | Reads Hover's annotation types and link targets into Hover types. Absorbs `annotations.ts`.                                                                               |
| `annotation_writer.ts` (new) | Creates, updates and removes Highlight, Underline, Ink and Text annotations                                                                                               |
| `pdfium_reader.ts`, `text_extractor.ts` | Unchanged in role. `PdfiumDocumentFactory` and `PdfiumDocumentHandle` fold into `document.ts`.                                                                  |

`src/types/` gains the replacements for `PdfDocumentObject`, `PdfPageObject`,
`PdfAnnotationObject` and `PdfMetadataObject`. Keep only the fields Hover
reads.

The API is **synchronous**. PDFium already runs on the main thread, and the
engine's `.toPromise()` wrappers only added a microtask. Existing `await`s at
call sites keep working on plain values and can be cleaned up later.

## 5. Phases

Each phase lands on its own and leaves the app working. `@embedpdf/engines`
stays installed until phase 6.

### Phase 0: Baselines before touching anything

These run under `bun test` against the real wasm. `scripts/build_fixtures.ts`
already loads it in Node.

#### The fixture set

Real papers cover fonts, layouts and producers. Small generated files cover
the page-level cases that papers rarely contain.

The repo is public, so **every committed paper must be open access under
CC BY**: arXiv papers with a CC BY licence, Nature Communications or
Scientific Reports, Elsevier open-access CC BY articles, and J-STAGE articles
marked CC BY. Record each paper's source URL and licence next to it.

| Fixture                                          | Kind      | What it exercises                                                                                                                        |
| ------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 2 × arXiv, NLP or CV, in a classic template (ACL, CVPR) | Paper | LaTeX Type 1 fonts, ligatures, math, internal and URI links, a bookmark tree, named destinations                                         |
| 1 × Nature-family, biology or physics            | Paper     | Publisher OpenType fonts, dense multi-column layout, heavy figures                                                                       |
| 2 × Elsevier: linguistics, psychology or animal studies | Paper | A second publisher pipeline; Unicode quirks such as unusual ligatures and missing ToUnicode maps                                     |
| 1 × Japanese (CJK)                               | Paper     | CID-keyed fonts and large ToUnicode maps; the character↔text index mapping (phase 4); FreeType's CJK path. Ideally an InDesign file with no bookmark tree (the outline fallback), mixed CJK, Latin and maths, and vertical text or non-embedded fonts if one can be found |
| 1 × scanned paper with an invisible OCR layer    | Paper     | Render mode 3 text, visible-text boxes, text gamma skipping the scan                                                                     |
| 1 × one of the above, annotated in Preview or Acrobat | Paper | Annotations made by another app: highlight, ink, sticky note. The only real test of the rect orientation `normalizeAnnotationRects` guesses at |
| The four existing `marketing/List of Papers/` files | Paper  | Already used by the analysis fixtures; `rotate example.pdf` covers `/Rotate`                                                             |
| Rotated, CropBox ≠ MediaBox, form fields, encrypted, truncated | Generated | Page sizes (phase 2), form drawing during rendering (phase 3), and the error path that must still close the document. Made by a script (`qpdf` or `pypdf`) from a one-page CC BY source, a few KB each |

If one of the PDFs that originally broke embedPDF's text conversion has a
licence that allows committing it, add it. It is the most direct regression
test for that problem.

#### What to record

- [ ] **Render goldens.** For each fixture, record `renderPageRaw` output at
      two scales and one `renderPageRect` crop.
- [ ] **Annotation round trip.** Create each of Highlight, Underline, Ink and
      a linked Text comment through the current engine, then save, reload and
      read back. Record the app-model result: `RatioRect`s, colour names,
      comments, strokes.
- [ ] **Link and bookmark snapshots.** Record the `nativeAnnotationsByPage`
      link targets and `getBookmarks` output for the fixture set. The analysis
      fixtures (`test/analysis.test.ts`) already pin much of this indirectly.
- [ ] **Saved-file checks.** For each annotation type, the saved bytes hold an
      `/AP`. Record which of `/CA`, `/T`, `/Contents`, `/NM`, `/M` and `/F`
      appear.

### Phase 1: Module and bindings

- [ ] Create `pdfium_module.ts` and `PdfiumBindings`. Move the wasm URL and
      fetch logic out of `pdfium_init.ts`.
- [ ] Replace `PDFiumExt_Init()` with `FPDF_InitLibraryWithConfig`, using
      the config the shim builds today: version 3, no user font paths, no V8
      isolate or platform.
- [ ] Switch the FFI string decoders to `TextDecoder`.
- [ ] Move `pdfium_reader.ts`, `text_extractor.ts` and `image_extractor.ts`
      onto `PdfiumBindings` rather than `WrappedPdfiumModule`.
- [ ] Keep `initPdfiumEngine()`'s return shape while the engine still exists.

**Exit:** `bun run check` passes. No file outside `pdfium_module.ts` imports
`@embedpdf/pdfium`.

### Phase 2: One document

- [ ] `PdfiumDocument` opens the bytes once. The engine doc is still opened
      too, for now: annotations live there until phase 5.
- [ ] **Page sizes.** The engine filled `pdfDoc.pages[i].size` through
      `EPDF_GetPageSizeByIndexNormalized`. Confirm against the goldens whether
      that is the `/Rotate`-applied size. Then reproduce it with
      `FPDF_GetPageSizeByIndexF`, plus `FPDFPage_GetRotation` where needed.
      Every layout calculation depends on this, so test rotated pages
      explicitly.
- [ ] Move metadata, bookmarks and named destinations to `PdfiumDocument`.
      Match the Phase 0 snapshots exactly.
- [ ] Delete the `getPageTextRects` fallback in `page_source.ts`.

**Exit:** bookmark, outline and metadata snapshots match. The analysis tests
pass.

### Phase 3: Rendering

- [ ] Implement `renderer.ts` with exactly the engine's choices:
  - a BGRA bitmap (`FPDFBitmap_CreateEx(..., FPDFBitmap_BGRA, ...)`) filled
    with opaque white;
  - flags `FPDF_REVERSE_BYTE_ORDER` (16) only, with `withAnnotations: false`
    everywhere Hover renders;
  - the same rounding of raster size (`docs/pdf_lifecycle.md` §5).
- [ ] Find out whether the engine called `FPDF_FFLDraw` when
      `withAnnotations` is false. Match whatever the form-field golden shows.
- [ ] Switch `PageView.render`, `PageView.renderDetail` and
      `renderThumbnail` over.

**Exit:** the render goldens match **byte for byte**. If they don't, the
difference is a choice not yet reproduced, not something to tune.

Changing render flags or the bitmap format afterwards (text_rendering.md §5)
is a separate follow-up.

### Phase 4: Reading annotations

- [ ] Implement `annotation_reader.ts`:
  - **Highlight and Underline:** attachment points become `segmentRects`.
  - **Ink:** `FPDFAnnot_GetInkListCount` / `GetInkListPath`.
  - **Text:** contents, rect and colour.
  - **Link:** `FPDFAnnot_GetLink`, then `FPDFLink_GetDest` → `FPDFDest_GetDestPageIndex` /
    `GetLocationInPage`, or `FPDFLink_GetAction` → `FPDFAction_GetURIPath`.
- [ ] **Rects come straight from `FPDFAnnot_GetRect`**, normalized with
      min/max. That removes the need for `normalizeAnnotationRects` and its
      five-annotation sample. Delete it.
- [ ] Read colour with `FPDFAnnot_GetColor`, falling back to the `/C` array.
      Read opacity with `FPDFAnnot_GetNumberValue(annot, "CA")`.
- [ ] Switch `loadFromDocument` and `build_fixtures.ts` over. Regenerate
      fixtures only if the diff is fully explained.

**Exit:** the link and annotation snapshots match. The analysis fixtures are
unchanged.

### Phase 5: Writing annotations and saving

This phase carries the most risk. Annotations and save move together, because
the saved bytes must come from the document that holds the edits.

- [ ] **Identity.** Write Hover's UUID as `/NM` with
      `FPDFAnnot_SetStringValue(annot, "NM", ...)`. Update and delete find the
      annotation by scanning the page for that `/NM`. This removes
      `#annotationIdToPdfId` and the PDFium-assigned ids. Annotations that came
      with the file have no Hover UUID, so read them with their index plus
      their existing `/NM` when present.
- [ ] **Create:**
  - `FPDFPage_CreateAnnot`
  - `FPDFAnnot_SetRect`
  - `FPDFAnnot_AppendAttachmentPoints` for each segment
  - `FPDFAnnot_AddInkStroke` for each stroke
  - `FPDFAnnot_SetColor`
  - `FPDFAnnot_SetFlags` (Print)
  - `/M` (date) and `/NM`
  - `/Contents` and `/T` **only when non-empty**. With that,
    `annotation_export.ts`, its call in `saveWithAnnotations` and
    `test/annotation_export.test.ts` are deleted.
- [ ] **Update:** move and recolour in place. A change of page is still
      delete-and-recreate (`docs/pdf_lifecycle.md` §6).
- [ ] **Opacity, an open decision.** Highlights are written today at opacity
      0.5. **Standard PDFium has no number setter** (`FPDFAnnot_SetNumberValue`
      doesn't exist; checked against the `chromium/8165` headers), so `/CA`
      can't be written with the standard API. Choose one of these, using the
      Phase 0 saved-file checks:
  - **(a)** Drop `/CA` and rely on the Multiply blend that PDFium's generated
    highlight appearance uses, so the text under an opaque highlight still
    shows. **Recommended, if** the saved-file check confirms PDFium writes the
    Multiply blend and Preview, Acrobat and Chrome agree.
  - **(b)** Write the appearance stream yourself with `FPDFAnnot_SetAP`.
  - **(c)** Keep one byte-level patch at save time. The Phase 0 code proves
    this works, but it's the kind of workaround this plan exists to remove.
- [ ] **Appearance streams.** Check that the saved file has `/AP` for every
      created annotation, in Preview, Acrobat and Chrome. If PDFium doesn't
      generate one on save for some type, generate it with `FPDFAnnot_SetAP`
      for that type only.
- [ ] **Save:**
  - `FPDF_SaveAsCopy(doc, writer, FPDF_NO_INCREMENTAL)`;
  - the writer is a struct `{ version: 1, WriteBlock }`, where `WriteBlock` is
    an `addFunction` callback (signature `"iiii"`) that appends
    `HEAPU8.slice(ptr, ptr + size)` to a list of chunks;
  - `removeFunction` it in a `finally`.

**Exit:** the round-trip tests match Phase 0. A saved highlight opens without
a blank note in Preview and Skim. Manual check in Acrobat and Chrome.

### Phase 6: Remove the engine

- [ ] Remove `@embedpdf/engines` from `package.json`. This also drops the
      `@embedpdf/models` and `@embedpdf/fonts-*` transitive packages. Hover
      never passed `fontFallback`, so the font packages were never loaded, and
      rendering is unchanged.
- [ ] Remove `engine`, `native` and `pdfDoc` from `PDFDocumentModel` and
      `EngineInstances`.
- [ ] Update `scripts/build_fixtures.ts` and the `scripts/check_layering.mjs`
      allowlist.
- [ ] Update `docs/pdf_lifecycle.md`:
  - §0 vocabulary: drop "Engine doc" and "Low-level handle";
  - §4: one load, not two;
  - §5, §6 and §7: the new call names.
- [ ] Update `docs/text_rendering.md` §2, since flags are now Hover's choice.
- [ ] Check: `grep -rE "EPDF|PDFiumExt|@embedpdf/(engines|models)" src scripts`
      returns nothing.

**Exit:** `bun run check` passes, all three browser builds load a PDF, and the
manual pass in §6 is clean.

## 6. Manual pass before shipping

On Chrome, Firefox and Safari builds:

- [ ] Open a paper, zoom past the detail threshold, scroll, rotate.
- [ ] Highlight, underline, ink and comment; edit and delete each.
- [ ] Save; reopen the saved file in Hover, Preview, Acrobat and Chrome.
- [ ] Print.
- [ ] Use a citation popup, a cross-ref and the outline, which exercises links
      and bookmarks.
- [ ] Open a password-protected PDF and a broken one; the error path in
      `loadPdf` must still close the document.

## 7. Risks

| Risk                                                                    | Mitigation                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Page-size or rotation semantics differ subtly from the engine's         | Rotated and cropped pages in the Phase 0 goldens; phase 2 lands before rendering |
| Saved annotations look different in other readers                       | Saved-file checks plus the manual pass in four readers                           |
| Opacity behaviour changes                                               | An explicit decision in phase 5, not a side effect                               |
| Hidden engine behaviour that nothing in Phase 0 covers                  | `@embedpdf/engines` stays installed until phase 6; each phase can be reverted    |
| Bigger scope creep (worker, render flags, font work)                    | Out of scope by name (§2)                                                        |

## 8. What it buys

- One document in the wasm heap instead of two copies of the file.
- No `EPDF*` dependency, so the wasm can be replaced (plan two).
- Render flags and bitmap format under Hover's control (text_rendering.md §5).
- Three workarounds deleted: `annotation_export.ts`,
  `normalizeAnnotationRects`, and the `getPageTextRects` fallback.
- Dependencies shrink from three `@embedpdf` packages plus seven font packages
  to one wasm package.
