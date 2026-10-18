# Why Page Text Renders Thinner Than Preview and Chrome

Findings behind issue #25: Hover's page text looks lighter and thinner than the
same PDF in macOS Preview or Chrome's built-in viewer. This document records
what causes it, what does _not_ cause it, and the fix we intend to propose
upstream to EmbedPDF.

Investigated against `@embedpdf/engines` / `@embedpdf/pdfium` `2.15.0` and the
EmbedPDF PDFium fork (`embedpdf/runtime`) at `72c5eb114`. PDFium source
references are to that fork; they name the function so they survive drift.

---

## 1. Summary

- The difference is **macOS native text rendering**, not a bug and not a missing
  parameter.
- PDFium's Apple build hands glyphs to CoreGraphics when it renders into an
  opaque bitmap. CoreGraphics applies font smoothing, which thickens stems
  slightly, the way Preview does.
- Our wasm build has no CoreGraphics. Every glyph goes through FreeType
  grayscale anti-aliasing, which applies no gamma and no stem darkening.
- **Skia is not the cause.** Toggling `chrome://flags/#pdf-use-skia-renderer`
  on and off leaves Chrome's text equally bold.
- No render flag available to us changes this. The clean fix is a small,
  text-only emboldening inside PDFium's glyph rasterizer (§5).

---

## 2. What Hover does today

`PageView.render()` (`src/viewer/page.ts`) calls
`native.renderPageRaw(pdfDoc, page, { scaleFactor, withAnnotations: false })`.

In `@embedpdf/engines`, `renderRectEncoded` makes these choices:

- It allocates a **BGRA** bitmap (`FPDFBitmap_CreateEx(..., 4, ...)`) filled
  with opaque white.
- It hard-codes `flags = 16` (`FPDF_REVERSE_BYTE_ORDER`), adding `FPDF_ANNOT`
  only when annotations are requested.
- Callers cannot pass other render flags.

The wasm itself (`@embedpdf/pdfium/dist/pdfium.wasm`) is built with these GN
settings:

- `pdf_use_skia=false` for every target (`scripts/embedpdf-runtime/build-target.sh`).
  The fork pulls in Skia only as a geometry-only stroker for redaction, and
  patches Skia (`patches/embedpdf-runtime/skia/geometry-only-stroke.patch`) to
  keep its renderer and font code out.
- `target_os="emscripten"`, so none of PDFium's Apple platform code exists in
  the binary.

---

## 3. The mechanism

Text drawing in PDFium's default (AGG) renderer:

1. `CPDF_TextRenderer` fills in `CFX_TextRenderOptions`.
   - `native_text` is true unless `FPDF_NO_NATIVETEXT` is set
     (`fpdfsdk/cpdfsdk_renderpage.cpp`, `cpdf_textrenderer.cpp`).
2. The device driver gets the first chance to draw the run via
   `DrawDeviceText`.
   - **On Apple builds only**, `CFX_AggDeviceDriver::DrawDeviceText`
     (`core/fxge/apple/fx_apple_impl.cpp`) draws the glyphs with CoreGraphics
     into a Quartz context wrapping the page bitmap.
   - That context comes from `CQuartz2D::CreateGraphics`
     (`core/fxge/apple/cquartz_2d.cpp`), which returns `nullptr` for anything
     except `FXDIB_Format::kBgrx`. A **BGRA bitmap never gets native text**,
     even on a Mac.
   - `CFX_Font::ShouldDrawDeviceText` also opts out CID fonts, a few named
     fonts, and runs with glyph adjustments.
3. Everything else falls back to `CFX_Face::RenderGlyph`
   (`core/fxge/cfx_face.cpp`).
   - Glyphs are loaded with `FT_LOAD_NO_HINTING` for non-TrueType/OpenType
     fonts.
   - `FT_Render_Glyph` produces plain coverage: a stem edge covering 40% of a
     pixel becomes 40% gray.
   - The only thickening is `FT_Outline_Embolden`, applied for _substituted_
     fonts via `GetEmboldenLevelForRender` (synthetic bold).

Who takes which path:

| Renderer                   | Platform | Bitmap | Text path                       |
| -------------------------- | -------- | ------ | ------------------------------- |
| Chrome's viewer (Skia off) | macOS    | opaque | CoreGraphics (smoothed)         |
| Preview                    | macOS    | —      | CoreGraphics (smoothed)         |
| Hover (wasm)               | any      | BGRA   | FreeType grayscale              |
| Chrome's viewer            | Win/Linux| opaque | FreeType grayscale (unverified) |

The last row is an inference from the code, not something we tested. If it
holds, Chrome on Windows/Linux should look as thin as Hover does.

Why figures and images look the same in every viewer: only _glyphs_ get the
platform treatment. Paths and images go through ordinary coverage
anti-aliasing everywhere. Body-text stems are also only ~1–1.5 device pixels
wide, so edge coverage dominates how heavy they look. A 3 px figure line or a
photo is mostly solid pixels.

---

## 4. Evidence

Each row renders page 1 of
`marketing/List of Papers/Nature paper example.pdf` at scale 1.5.

- **Ink** is the mean darkness over the whole page, `255 − mean(R,G,B)`. The
  page includes figures, so the text-only difference is larger than the
  totals suggest.
- **Colour px** counts pixels whose channels differ by more than 24. It
  detects LCD (subpixel) fringing.

**Native macOS PDFium** (pypdfium2, PDFium 156.0.8076.0, AGG, no Skia):

| Bitmap | Flags                           | Ink       | Colour px |
| ------ | ------------------------------- | --------- | --------- |
| BGRA   | default (what EmbedPDF does)    | 16.04     | 7,343     |
| BGRA   | `NO_NATIVETEXT`                 | 16.04     | 7,343     |
| BGRx   | default (what Chrome does)      | **17.99** | 7,350     |
| BGRx   | `NO_NATIVETEXT`                 | 16.04     | 7,342     |
| BGRx   | `LCD_TEXT`                      | 17.99     | 7,350     |
| BGRx   | `LCD_TEXT` + `NO_NATIVETEXT`    | 16.00     | 68,756    |

**Our wasm** (`@embedpdf/pdfium` 2.15.0, the same calls through the module):

| Bitmap | Flags      | Ink   | Colour px |
| ------ | ---------- | ----- | --------- |
| BGRA   | default    | 16.03 | 7,336     |
| BGRA   | `LCD_TEXT` | 16.03 | 7,336 (0 bytes differ) |
| BGRx   | `LCD_TEXT` | 15.99 | 68,739    |

Reading the tables:

- **Native text is the whole effect.** On the Mac it adds ~12% ink to the
  page. `NO_NATIVETEXT` removes it exactly, and a BGRA bitmap never gets it.
- **Our wasm matches native PDFium with native text off** (16.03 vs 16.04).
  Nothing is wrong with EmbedPDF's build.
- **`LCD_TEXT` is not a fix.** On BGRA bitmaps PDFium ignores it. On opaque
  bitmaps it switches to ClearType-style subpixel text: colour fringes, slightly
  _less_ ink, and wrong once night mode inverts the canvas or on HiDPI screens.
- **Skia is ruled out by observation.** Chrome's viewer looks equally bold with
  `#pdf-use-skia-renderer` on and off.

A zoomed crop of the BGRA-default and BGRx-default renders, side by side,
shows the difference plainly. Generate it with the script below.

### Reproducing the native measurements

```sh
python3 -m venv venv && ./venv/bin/pip install pypdfium2 pillow
./venv/bin/python -I measure.py "marketing/List of Papers/Nature paper example.pdf" out 1.5
```

```python
# measure.py
import sys, ctypes
import pypdfium2.raw as R
from PIL import Image

pdf, out, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
R.FPDF_InitLibrary()
doc = R.FPDF_LoadDocument(pdf.encode(), None)
page = R.FPDF_LoadPage(doc, 0)
W = round(R.FPDF_GetPageWidthF(page) * scale)
H = round(R.FPDF_GetPageHeightF(page) * scale)

def render(name, fmt, flags):
    bmp = R.FPDFBitmap_CreateEx(W, H, fmt, None, 0)
    R.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xFFFFFFFF)
    R.FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, flags | R.FPDF_REVERSE_BYTE_ORDER)
    stride = R.FPDFBitmap_GetStride(bmp)
    buf = ctypes.string_at(R.FPDFBitmap_GetBuffer(bmp), stride * H)
    img = Image.frombuffer("RGBA", (W, H), buf, "raw", "RGBA", stride, 1).convert("RGB")
    img.save(f"{out}/{name}.png")
    px = img.tobytes()
    ink = sum(255 - (px[i] + px[i + 1] + px[i + 2]) / 3 for i in range(0, len(px), 3)) / (W * H)
    col = sum(1 for i in range(0, len(px), 3) if max(px[i:i + 3]) - min(px[i:i + 3]) > 24)
    print(f"{name:28s} ink {ink:.3f}  colour px {col}")
    R.FPDFBitmap_Destroy(bmp)

BGRx, BGRA = R.FPDFBitmap_BGRx, R.FPDFBitmap_BGRA
render("bgra_default", BGRA, 0)
render("bgra_no_nativetext", BGRA, R.FPDF_NO_NATIVETEXT)
render("bgrx_default", BGRx, 0)
render("bgrx_no_nativetext", BGRx, R.FPDF_NO_NATIVETEXT)
render("bgrx_lcd", BGRx, R.FPDF_LCD_TEXT)
render("bgrx_lcd_no_nativetext", BGRx, R.FPDF_LCD_TEXT | R.FPDF_NO_NATIVETEXT)
```

The native measurements need a Mac. On other platforms the BGRx rows should
match BGRA, since the native-text path is Apple-only (not tested).

---

## 5. Options

| Option                                       | Text only | Same on every OS | Cost                                                       |
| -------------------------------------------- | --------- | ---------------- | ---------------------------------------------------------- |
| A. Gamma/dilation on the page bitmap (#25)   | no        | yes              | Small; darkens figures and images that already match      |
| B. Skia build of PDFium                      | yes       | yes              | Very large, and ruled out: Skia isn't what makes it bold   |
| C. Browser-drawn text (pdf.js style)         | yes       | follows OS       | Rewrite of text rendering                                  |
| **D. Emboldening in PDFium's glyph rasterizer** | **yes** | **yes**          | Small C++ patch to the EmbedPDF fork                       |

### Interim fix: A, until upstream has D

Hover applies option A for now, with no setting (`src/viewer/text_gamma.ts`),
on macOS only. Windows and Linux viewers draw text about as thin as PDFium
does, so the curve would only make Hover heavier than native there. It runs
on page renders and on region captures. #25 proposed γ ≈ 1.6 plus a light
dilation. We fitted the plain curve `v' = 255·(v/255)^γ` and the dilation
against the native-text render above (BGRx default): the text pixels are the
ones native text changes, and the figure pixels are every other non-white
pixel.

| γ   | Dilation k | Text ink vs native | Figure ink change |
| --- | ---------- | ------------------ | ----------------- |
| 1.0 | 0          | −12.7%             | 0                 |
| 1.4 | 0          | −2.2%              | +9.3%             |
| 1.5 | 0          | **−0.1%**          | +11.1%            |
| 1.6 | 0          | +1.8%              | +12.7%            |
| 1.6 | 0.1        | +6.8%              | +14.1%            |

- γ = 1.5 without dilation matches native ink, and has the lowest
  per-pixel error of the variants that match.
- Dilation overshoots, and #25 measured it at ~34 ms a page.
- Applied to the whole raster, the curve also darkened figures and images by
  ~11%. So it is confined to anti-aliased glyph edges inside text boxes (§6).
  An earlier per-channel version also drew darker rectangles over fills behind
  text, such as a pie wedge or a coloured header.
- The pass costs ~7 ms on a 2× page (1.9 Mpx, ~540 word boxes). The boxes
  are read once per page and cached.
- Migrating to EmbedPDF 3.x, with the glyph-level fix below, is the point to
  replace it.

**D is the proposal.** CoreGraphics font smoothing is, in effect, a slight
outline dilation at small sizes. PDFium already has the hook for this:

- `CFX_Face::RenderGlyph` calls `FT_Outline_Embolden` for synthetic bold.
- A size-dependent emboldening (strongest at body-text pixel sizes, fading to
  zero by heading sizes) applied in the same place would approximate the
  native look.
- It would touch only glyphs and behave identically on every platform.
- It would cost almost nothing, since glyph bitmaps are cached.

Exposed as an opt-in render flag or option in `@embedpdf/engines`, this would
help every EmbedPDF user on a Mac, not just Hover. A gamma table on glyph
coverage, which is how Skia darkens text, would be an alternative or a
complement in the same spot.

### Proposed upstream ask (`embedpdf/runtime`)

1. An opt-in render option that applies size-dependent outline emboldening
   (and/or a coverage gamma) to FreeType-rendered glyphs in
   `CFX_Face::RenderGlyph`.
2. A way to pass it through `renderPageRaw` / `renderRectEncoded` in
   `@embedpdf/engines`. Render flags are hard-coded there today.

If upstream declines, we could carry the patch on our own build of the fork.
That means owning a depot_tools/emsdk build and rebuilding the wasm and its
Emscripten JS on every EmbedPDF update. EmbedPDF's main branch is now
3.0.0-next, with the runtime published as `@embedpdf/engine-runtime-wasm32`;
v2 lives on their `v2` branch, which still gets backported fixes (2.15.1). The
3.x runtime package accepts a locally built runtime
(`pdf-runtime-build.local.json`), which would make a carried patch easier to
maintain there than on v2.

---

## 6. The interim text gamma

`src/viewer/text_gamma.ts` implements option A. It is a stopgap until PDFium
can embolden glyphs itself (§5, D).

### When it runs

- Only on macOS (`TEXT_GAMMA_ENABLED`, from `userAgentData.platform`, falling
  back to `navigator.platform`). Windows and Linux viewers draw text about as
  thin as PDFium, so the curve would make Hover heavier than native there.
- On every page render (`PageView.render`), before the raster goes to the
  canvas, and on region captures (`RegionSelectController`), so a capture has
  the same weight as the page on screen.

### Text boxes

`PdfiumPageReader#readVisibleTextBoxes` produces them, and
`PDFDocumentModel#getPageTextBoxes` caches them per page, since they don't
change with zoom. The cache is dropped when the low-level handle closes.

- One box per run of consecutive characters from the same text object.
- Boxes come from `FPDFText_GetLooseCharBox`, which spans the font's ascent to
  descent, so accents and descenders are inside.
- Characters with no text object (spaces and line breaks PDFium generates) are
  skipped.
- Text in render mode 3 (invisible) or 7 (clip only) is skipped. Scanned PDFs
  lay an invisible OCR layer over the page image, and curving it would darken
  the scan.
- Coordinates are fractions of the page as displayed (after `/Rotate` and the
  crop box, top-left origin), packed `[left, top, right, bottom, ...]`.
  `FPDF_PageToDevice` only reports whole device pixels, so the page-space →
  display affine map is fitted once by sampling it on a 2²⁰ px virtual device.

### The curve, per box

1. Map the box into raster px through the page's placement in the raster.
   For a page render that is the whole raster; a region capture passes the
   page's offset and size, so boxes outside the crop are skipped. Each box is
   padded by 1 px for anti-aliasing that bleeds past it.
2. **Background**: the commonest colour on the box's border.
3. **Text colour**: the pixel furthest (RGB distance) from the background. If
   it is less than 32 away, the box has no edge worth darkening and is left
   alone.
4. For each pixel, its **coverage** `t` is its projection onto the
   background → text line. Only pixels with `0 < t < 1` that sit within 12 (RGB
   distance) of that line count as glyph edges. PDFium's greyscale
   anti-aliasing puts edge pixels on the line up to rounding; anything further
   off is something else drawn in the box, like a figure under its label.
5. Edge pixels move along the line to `1 − (1 − t)^γ`, γ = 1.5. On black text
   over white this is exactly `255·(v/255)^γ` per channel.

Fills behind the text, the text colour itself, and figures outside or under the
boxes keep their exact tones. Alpha is never touched.

Boxes overlap, so a per-pixel mark makes each pixel curve once per call. The
mark buffer is shared across calls, grown to the largest raster seen, and only
the marked boxes are reset afterwards.
