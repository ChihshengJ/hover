# Draft: filled open 4-point rectangles lose thin-rect snapping since b02da6c41c

For issues.chromium.org, component PDFium. Attach `open_rect_fill.pdf`
(in this folder).

---

**Title:** Thin filled rectangle drawn as an open path (`m l l l f`) renders
at fractional coverage since "Stop recognizing open, 3-sided paths as
rectangles"

**Summary**

Since b02da6c41c ("Stop recognizing open, 3-sided paths as rectangles",
Bug 42270691, 572902676), a thin filled rectangle drawn as four points with
no explicit `h` no longer gets PDFium's rectangle handling. A 0.25 pt rule
used to render as one solid device pixel and now renders at about 25%
coverage, so it nearly disappears at 72 dpi. The same rectangle closed with
`h`, or drawn with `re`, still renders solid.

That commit is right for stroking, where an open 3-sided path is not a
rectangle. But filling closes every open subpath implicitly (ISO 32000-1
§8.5.3.1). So for a fill-only path, `m l l l f` describes the same area as
`m l l l h f` and should be treated the same way.

Real documents do this. Elsevier journal first pages draw their header rules
as `x y m … l … l … l f` with a height of about 0.25 pt. Those rules go from
black to light gray.

**Steps to reproduce**

`open_rect_fill.pdf` is a 200×40 pt page with two 0.25 pt black rules:
- top (device row 9 at 72 dpi): `180 30.4 m 20 30.4 l 20 30.65 l 180 30.65 l f`
- bottom (device row 29), control: the same path with `h` before `f`

Render it with `FPDF_RenderPageBitmap` into a 200×40 BGRA bitmap filled
white, flags 0, then read the blue channel at x = 100, rows 8–10 and 28–30.

**Results** (pdfium-binaries wasm builds; AGG, no Skia)

| PDFium build | open `m l l l f`, rows 8–10 | closed `h f`, rows 28–30 |
| ------------ | --------------------------- | ------------------------ |
| chromium/7690 | 255, **0**, 255 | 255, 0, 255 |
| chromium/8100 | 255, **0**, 255 | 255, 0, 255 |
| chromium/8111 | 255, **191**, 255 | 255, 0, 255 |
| chromium/8165 | 255, **191**, 255 | 255, 0, 255 |

`FPDF_RENDER_NO_SMOOTHPATH` doesn't restore the old output. With it, the open
rule isn't drawn at all (255).

**Expected:** the open and closed paths render identically when filled, as
before chromium/8111.

**Suggestion:** keep the stricter check for stroked paths, but for fill-only
paths (no stroke) treat an open 4-point path as implicitly closed before the
rectangle test.

**Range:** chromium/8100 (f51279699c) is good; chromium/8111 (a50f1a5953) is
bad. In that range, b02da6c41c is the only change to open-path rectangle
detection. The neighbouring CFX_Path changes (97ab661d8c, 69efacb11f,
616a2caa41) concern collinear or redundant points. Not bisected to a single
commit by building.
