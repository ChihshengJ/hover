# Throwaway: commit sequence for "Own the PDFium JS layer"

Working notes for executing `docs/plan_own_pdf_engine.md` on
`cjin/refactor/remove-embedpdf-engine`. Delete this file when phase 6 lands.

Rule for every commit: `bun run check` passes and the app still loads a PDF.
Phase 0 commits touch tests only, apart from one test seam (C4). Everything
after that is compared against what they record.

---

## Findings that change the parent plan

Read from `node_modules/@embedpdf/engines/dist/direct-engine-C8xTbxym.js`:

1. **Rendering uses `FPDF_RenderPageBitmapWithMatrix`, not
   `FPDF_RenderPageBitmap`** (`renderRectEncoded`, ~L8700):
   - `FPDFBitmap_CreateEx(w, h, 4 /*BGRA*/, heapPtr, stride)` over a buffer
     the engine mallocs itself;
   - `FillRect(..., 0xFFFFFFFF)`;
   - matrix from `buildUserToDeviceMatrix(rect, rotation, wDev, hDev)`;
   - clip `[0, 0, wDev, hDev]`;
   - flags `16` (`| 1` only with `withAnnotations`);
   - `wDev = max(1, round(rect.w * scale * dpr))`.

   §3 of the parent plan says to render rects with "a negative start offset and
   the full-page size". That is a different code path, and it is unlikely to
   match byte for byte. **Port `buildUserToDeviceMatrix` and the
   WithMatrix call as they are.**
2. **`FPDF_FFLDraw` runs only when `withForms` is true**, and its default is
   false. Hover never sets it, so forms are never drawn. That matches
   SOURCES.md (`forms.pdf`: "draws none"). No form-fill environment is needed,
   which also avoids `PDFiumExt_InitFormFillEnvironment`, another non-standard
   symbol the parent plan's table misses.
3. **The engine calls `PDFiumExt_Init()` itself** in its constructor (~L998).
   Hover's own call in `pdfium_init.ts:81` is already a second init. Swapping
   Hover's call for `FPDF_InitLibraryWithConfig` in phase 1 therefore can't
   remove the extension call until the engine is gone (C21). PDFium's init
   guards against re-entry, so the overlap is harmless. Note it in C6.
4. **`navigation_tree.ts` reads `pdfDoc` as a pdf.js object.** It calls
   `getPage`, `getViewport` and `getDestination`, and is typed `any`. That code
   is already dead (L195 comment). In C21, delete the dead branches, don't port
   them.

5. **The engine writes `/NM` when it reads.** `readPageAnnotation` gives
   every annotation without `/NM` a random UUID and stores it in the
   document, and update and delete find annotations by that `/NM`
   (`EPDFPage_GetAnnotByName`). Preview's annotations have no `/NM`. So
   markup can't load from Hover's document while writes still go to the
   engine's: the store would hold ids the engine's document never got.
   **C17 moves links only. Markup loading moves in C20**, with the writes,
   and Hover's writer must give a nameless annotation its `/NM` on first
   touch, as the engine did.
6. **`FPDFAnnot_GetColor` fails on any annotation with an appearance
   stream**, and standard PDFium can't read the `/C` array. The reader takes
   the colour from the stream's paths (fill for highlight and note, stroke
   for underline and ink), within 1 per channel of `/C`. C19 must write
   colours so that reading them back that way works: an `/AP` whose paths
   carry the colour.
7. **Link rects keep Hover's old page-level shift.** On a page whose first
   five `/Rect`s run bottom-up, links move up by their own height (formerly
   `normalizeAnnotationRects`). Only `rotate example.pdf` triggers it, and
   neither placement lines up with its link text. Ported as it was; a
   follow-up.

8. **Phase 5 decisions** (with the user, 2026-11-21):
   - **Appearances: Hover's own, through `SetAP`** (parent plan, opacity).
     Never render with `FPDF_ANNOT` on the document that gets saved: that
     stamps `/PDFIUM_HasGeneratedAP` on every annotation on the page. Region
     select now renders through `renderer.ts` for this reason.
   - **Comments live in the markup's `/Contents` only**, on the first page's
     part. No separate `/Text` note. Older Hover files' notes still load
     (`/EPDFCustom` `linkedAnnotationId`) and are removed when that comment
     changes.
   - **Drawings are saved as turned points** and reload at rotation 0. Hover
     0.10 never kept the angle: the engine dropped `rotation` from
     `/EPDFCustom` on write.
   - `FPDFPage_CreateAnnot` writes the annotation dict **directly** into
     `/Annots`. The spec wants indirect references; check it in Preview,
     Acrobat and Chrome during the manual pass.

---

## Phase 0: baselines (tests only)

Test layout: `test/engine/` (new). Snapshots go in
`test/engine/__snapshots__/`. The fixture list is every file in
`test/pdfs/**` plus the four `marketing/List of Papers/` PDFs.

**C1 · test(support): shared PDFium loader for bun tests**
- `test/support/pdfium.ts`: load the wasm from
  `node_modules/@embedpdf/pdfium/dist/pdfium.wasm` (lifted from
  `build_fixtures.ts#loadEngine`), build the engine with a stub image
  converter, and memoize. Export `fixturePdfs()` → `{ slug, path, bytes }[]`.
- `scripts/build_fixtures.ts` imports the loader instead of keeping its own
  copy.
- Check: `bun run fixtures` followed by `git diff test/fixtures` shows nothing.

**C2 · test(engine): document snapshots**
- `test/engine/document.test.ts`, one `describe` per fixture. It records:
  - page count;
  - each page's `size` and `rotation`;
  - `getMetadata`;
  - `getBookmarks` (ids stripped);
  - `collectNamedDestinations`;
  - every page's annotations from `getPageAnnotations` after
    `normalizeAnnotationRects`, with `id` stripped and numbers rounded the way
    `build_fixtures.ts#round` does.
- Error path: open `encrypted-user-password.pdf`, `truncated.pdf` and
  `not-a-pdf.pdf`, and record the error code (4, 3 and 3). Also open
  `encrypted-user-password.pdf` with `hover-user`.

**C3 · test(engine): render goldens**
- `test/engine/render.test.ts`. For each fixture, render pages 1–2 (every page
  of the `generated/` files) with `renderPageRaw` at scale 1 and 2.5, plus one
  `renderPageRect` crop of page 1. Use a fixed rect in the middle third, at
  scale 4.
- Snapshot `{ width, height, sha256(data) }`, not the pixels, so goldens stay
  a few KB.
- With `HOVER_DUMP_RENDERS=<dir>` set, the test also writes PNGs for
  side-by-side review. Use the scratchpad and never commit them.
- Measure the runtime. If the papers push `bun test` past ~10 s, put this
  file behind `bun test test/engine` and keep it out of the default glob.

**C4 · test(engine): annotation round trip and saved-file checks**
- Seam: let `initPdfiumEngine` accept a preloaded `wasmBinary` through a
  `primePdfiumWasm(bytes)` setter, so `PDFDocumentModel.load()` runs under
  bun. Define `__LOCAL_WASM_ONLY__` in a bun preload (`bunfig.toml`
  `[test] preload`). This is the only `src/` change in phase 0.
- `test/engine/annotations.test.ts`, on a fresh load of
  `arxiv-cvpr-convnext.pdf`:
  1. create a Highlight, an Underline, an Ink stroke and a Highlight with a
     linked comment through `AnnotationStore`;
  2. `saveWithAnnotations()`, reload the bytes, `loadFromDocument`;
  3. snapshot the app model: `RatioRect`s, colour names, comments, strokes.
- Also: update one annotation (move and recolour) and delete one, then save,
  reload and snapshot again.
- Saved-file checks: scan the saved bytes per annotation dict. For each one,
  record whether it has `/AP`, `/CA`, `/T`, `/Contents`, `/NM`, `/M` and `/F`,
  and whether its `/AP` stream sets `/BM /Multiply`. This answers the
  phase 5 opacity question in advance.
- `annotated.pdf`: snapshot what `loadFromDocument` produces from Preview's
  six annotations.

> Phase 0 exit: four snapshot files committed and green, and the analysis
> fixtures unchanged.

## Phase 1: module and bindings

**C5 · refactor(pdf): `pdfium_module.ts` and `PdfiumBindings`**
- New `src/pdf/pdfium_module.ts`. It holds the wasm URL and fetch logic moved
  from `pdfium_init.ts`, `loadPdfiumModule(wasmBinary)`, and
  `interface PdfiumBindings`: every `FPDF*` function Hover calls, with raw
  numeric signatures, plus `_malloc`, `_free`, `HEAP*`, `addFunction` and
  `removeFunction`.
- `pdfium_init.ts` calls it and keeps its `EngineInstances` shape. The engine
  still gets the `WrappedPdfiumModule`, which `pdfium_module.ts` also exposes
  for now as `engineModule`.

**C6 · refactor(pdf): `FPDF_InitLibraryWithConfig`**
- Build the config struct in the FFI: version 3, null user font paths, null
  isolate and platform. Call it from `pdfium_module.ts`.
- Remove Hover's `PDFiumExt_Init()` calls from `pdfium_init.ts` and
  `build_fixtures.ts`. The engine still calls its own (finding 3).

**C7 · refactor(pdf): decode strings with `TextDecoder`**
- `pdfium_ffi.ts:291/295`: decode UTF-16LE up to the `\0\0` terminator and
  UTF-8 up to `\0`, with `TextDecoder` over `HEAPU8`.
- C2's metadata and bookmark titles, and the analysis fixtures, must not move.

**C8 · refactor(pdf): move the readers onto `PdfiumBindings`**
- Retype `pdfium_ffi.ts`, `pdfium_reader.ts`, `text_extractor.ts`,
  `image_extractor.ts` and `ui/tools/region_select.ts:360` (heap views) to
  `PdfiumBindings`. `PdfiumHeaps` folds into the bindings.
- Exit: `grep -rn '@embedpdf/pdfium' src` matches only `pdfium_module.ts`.
  (`@embedpdf/engines` and `@embedpdf/models` imports remain.)

## Phase 2: one document

**C9 · feat(pdf): `PdfiumDocument`**
- New `src/pdf/document.ts`: `PdfiumDocument.open(bindings, bytes, password?)`,
  `close()`, `pageCount`, `fileBytes()`, and typed open errors from
  `FPDF_GetLastError`. It absorbs `PdfiumDocumentHandle` and
  `PdfiumDocumentFactory` (text/path extraction methods move with them).
- `doc.ts`: `lowLevelHandle` becomes `document: PdfiumDocument`, opened once,
  next to the engine doc. Retarget `page_source.ts`, `annotations.ts`,
  `build_fixtures.ts` and `saveOriginal()`.
- C2's error-path cases must also hold for `PdfiumDocument.open`. On failure,
  the file buffer is freed.

**C10 · feat(pdf): page sizes from `PdfiumDocument`**
- `pageSize(i)` uses `FPDF_GetPageSizeByIndexF`. If C2 shows that the engine's
  size is the `/Rotate`-applied one, swap w/h when `FPDFPage_GetRotation` is
  odd. (C2 already shows this for `rotated.pdf`: 792×612 at 90.)
- New Hover type `PdfPage { index, size, rotation }` in `src/types/`.
  `doc.getPage()` returns it. `pageDimensions` and
  `page_source.getPageSize/numPages` read from it.
- The viewer still needs the engine's page object for rendering until C15, so
  `doc.enginePage(i)` stays as a temporary accessor.
- Test: for every fixture, `PdfiumDocument` sizes and rotations equal C2's.

**C11 · feat(pdf): metadata from `PdfiumDocument`**
- `metadata()` via `FPDF_GetMetaText` for Title, Author, Subject, Keywords,
  Producer, Creator, CreationDate and ModDate. Hover type `PdfMetadata`, with
  only the fields `getDocumentTitle` and `file_menu` read.
- `doc.getMetadata` and `getDocumentTitle` switch over. Must match C2.

**C12 · feat(pdf): bookmarks and named destinations from `PdfiumDocument`**
- `bookmarks()` walks `FPDFBookmark_*` into Hover's `PdfBookmark`, with the
  fields `outline_builder` reads. `FPDF_CountNamedDests` / `GetNamedDest` are
  used only if `collectNamedDestinations` needs them. Otherwise it keeps
  deriving them from the tree, as today.
- `doc.ts#loadBookmarksAndDestinations` and `build_fixtures.ts` switch over.
- Check: C2 matches, `bun run fixtures` gives no diff, and the analysis tests
  pass.

**C13 · refactor(pdf): delete the `getPageTextRects` fallback**
- `createPdfPageSource({ document })` only. Drop the `native` and `pdfDoc`
  parameters.

## Phase 3: rendering

**C14 · feat(pdf): `renderer.ts`**
- `renderPage(doc, index, scale)` and `renderRect(doc, index, scale, rect)`
  return `{ data: Uint8ClampedArray, width, height }`. Port the engine's
  `renderRectEncoded` exactly (finding 1): malloc the buffer, `CreateEx`
  format 4, white fill, `buildUserToDeviceMatrix`, clip, flags 16,
  WithMatrix, then copy out and free. No `FFLDraw`.
- Check how `renderPageRaw` reaches `renderRectEncoded` (full-page rect, how
  `dpr` is passed) and mirror it.
- Test: matches C3 **byte for byte**. If it doesn't, the cause is a choice not
  yet ported. Don't tune.

**C15 · refactor(viewer): switch rendering to `renderer.ts`**
- `viewer/page.ts` `render` and `renderDetail`, and
  `share/annotated_pages.ts`, switch over. The viewer page type becomes
  `PdfPage`, and `@embedpdf/models` leaves `viewer/`. Remove
  `doc.enginePage()` if nothing else uses it.
- Manual: zoom past the detail threshold, rotate, and use Share → annotated
  pages.

## Phase 4: reading annotations

**C16 · feat(pdf): `annotation_reader.ts`**
- `readPageAnnotations(doc, index)` returns Hover types in `src/types/`:
  `NativeLink` (`rect`, `target.type`, `target.destination.{pageIndex,view}`,
  `target.action.uri`) and `NativeMarkup` (highlight/underline segments, ink
  strokes, text, colour, opacity, contents, `/NM`).
- Rect from `FPDFAnnot_GetRect`, min/max-normalized, converted to a top-left
  origin with the page height. Colour from `GetColor`, falling back to `/C`.
  Opacity from `GetNumberValue("CA")`.
- Test: links match C2's annotation snapshot for every fixture, and markup
  matches C4's `annotated.pdf` snapshot. It runs standalone and is not yet
  wired in.

**C17 · refactor(model): load annotations through the reader**
- `AnnotationStore.loadFromDocument` and `build_fixtures.ts` switch over. Type
  `nativeAnnotationsByPage` as `NativeLink[]`. Delete `pdf/annotations.ts`
  (`normalizeAnnotationRects`).
- **Done for links only** (finding 5). Markup still loads through the
  engine, and only on pages where the reader finds some.
- Writes still go to the engine doc. That is safe because at load time both
  docs hold the same file. `annotation_data.ts:745` (finding a linked comment
  on update) still reads from the engine until C20.
- Check: `bun run fixtures` gives no diff, or a diff explained in the commit
  message. C4 is still green.

## Phase 5: writing and saving

**C18 · feat(pdf): `PdfiumDocument.save()`**
- `FPDF_SaveAsCopy(doc, writer, FPDF_NO_INCREMENTAL)`. The writer is a struct
  `{ version: 1, WriteBlock }` with `WriteBlock = addFunction(fn, "iiii")`
  appending `HEAPU8.slice`. Call `removeFunction` in `finally`.
- Test: save each fixture untouched, reopen it, and get the same C2 snapshot.

**C19 · feat(pdf): `annotation_writer.ts`**
- `create`, `update` and `remove`, keyed by `/NM`:
  - `CreateAnnot`, `SetRect`, `AppendAttachmentPoints`, `AddInkStroke`,
    `SetColor`, `SetFlags(Print)`;
  - `/M` and `/NM` via `SetStringValue`;
  - `/Contents` and `/T` only when non-empty.
- Settle opacity with C4's saved-file data: (a) if `/BM /Multiply` is there,
  otherwise (b) `SetAP`. Record the decision in the parent plan in this
  commit.
- Test: write through the writer on a `PdfiumDocument`, save, read back
  through the reader, and compare to C4's app-model snapshot. Run the
  saved-file checks on the output: `/AP` on every annotation and no empty
  `/Contents` or `/T`.

**C20 · refactor(model): move annotation writes and save off the engine**
- One commit, because the saved bytes must come from the doc that holds the
  edits. Also takes over C17's markup half: `loadFromDocument` builds markup
  from `readPageAnnotations(...).markup` (`NativeMarkup`, already tested
  against the engine), keeping `custom.linkedAnnotationId` / `rotation` for
  files earlier Hover versions saved. `AnnotationStore` create, update, delete and comment linking go
  through `annotation_writer`. `saveWithAnnotations` returns
  `document.save()`.
- Delete `#annotationIdToPdfId`, `pdf/annotation_export.ts` and
  `test/annotation_export.test.ts`.
- C4 is regenerated only for the expected differences (`/CA`, `/T`,
  `/Contents` presence). Every app-model snapshot stays the same.
- Manual: Preview and Skim show no blank note, and the file opens in Acrobat
  and Chrome.

## Phase 6: remove the engine

**C21 · refactor(model): stop opening the engine doc**
- Remove `engine`, `native` and `pdfDoc` from `PDFDocumentModel` and
  `openDocumentBuffer` / `closeDocument`.
- `file_menu.ts:476/496` checks `doc.document`. In `navigation_tree.ts`,
  delete the dead pdf.js branches (finding 4).
- `pdfium_init.ts` collapses into `pdfium_module.ts`, and the
  `primePdfiumWasm` seam moves with it.
- The C2–C4 suites now record from Hover's layer. Each has an engine-side
  `describe` that comes out here. Keep the snapshots unchanged.

**C22 · chore(deps): drop `@embedpdf/engines`**
- In `package.json`, remove `@embedpdf/engines` and pin
  `"@embedpdf/pdfium": "2.15.0"`. Run `bun install`.
- Update the `check_layering.mjs` allowlist if needed, and the
  `scripts/package.mjs` comment.
- Check: `grep -rnE "EPDF|PDFiumExt|@embedpdf/(engines|models)" src scripts`
  finds nothing. (The `/EPDFCustom` marker went with C20.)
- `bun run build:all` succeeds.

**C23 · docs: lifecycle and rendering**
- `pdf_lifecycle.md` §0, §4–§7, and `text_rendering.md` §2.
- Tick the parent plan's checkboxes. Delete this file.

Then do the manual pass in parent §6 on all three browsers.

---

## Where it can go wrong

- **C4's seam.** If `PDFDocumentModel.load()` pulls in DOM or `chrome.*`
  beyond the wasm fetch under bun, record the round trip at the
  `engine.createPageAnnotation` level instead. Snapshot the store's converted
  output by calling `#convertPdfAnnotation` through a test export.
- **C10's rotation semantics** are the commit most likely to break layout
  quietly. Check `rotated.pdf` and `boxes.pdf` page 4 (CropBox + `/Rotate 90`)
  explicitly.
- **C14** may need `dpr` and rounding details from `renderPageRaw`'s wrapper.
  Read it before writing.
- **C20** is the only commit that can't be split. If it gets large, land C19
  with more tests rather than splitting C20.
