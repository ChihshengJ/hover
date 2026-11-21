# The Gooey Effect

How the file menu's button pill and menu card melt into one shape, why it is
built the way it is, and what to carry over when another component wants the
same look.

Code: `src/ui/controls/file_menu_goo.ts` (`FileMenuGoo`, `traceGoo`), the
contour tracer `fieldContourPath` in
`src/ui/controls/floating_toolbar/liquid_glass/metaball_path.ts` (shared with
the liquid glass toolbar, see `liquid_glass.md`), and the
`.file-menu-goo-layer` rules in `styles/file_menu.css`.

---

## 1. Summary

- The look is the classic **blur-threshold goo**: blur every blob, add the
  blurred alphas, and make everything above a threshold solid.
- We do not ask the browser to do that with an SVG filter. We compute the same
  field **analytically in JS**, trace its threshold contour into a path, and
  **paint it with its shadows into a `<canvas>`** every animation frame.
- The menu content (transform, opacity) is driven by **the same JS clock** as
  the goo, so nothing animates on the compositor.
- Colors and shadows still live in CSS, as custom properties the canvas reads.

---

## 2. What makes it goo

Each blob is Gaussian-blurred, and the blurred alphas **sum**. A pixel is solid
when the sum crosses the threshold. The sum is the whole trick: while the card
fades in, its weak field adds to the button's, so the button swells toward the
card first, and the card then pops in already fused. Two blobs that are close
enough also bridge across the gap between them.

The old SVG filter that produced this:

```xml
<feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
<feColorMatrix in="blur" mode="matrix"
  values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -15" result="goo" />
<feComposite in="SourceGraphic" in2="goo" operator="atop" />
```

The color matrix maps alpha to `20a − 15`. Its half-opaque edge sits at
`a = 0.775`, which is where `GOO_THRESHOLD` comes from.

---

## 3. Why not `filter: url(#goo)`

The first version applied that filter to a wrapper around the button pill and
the card. It broke in Safari.

**Compositor layers escape the filter.** WebKit runs `transform` and `opacity`
transitions on the compositor, which lifts the animating card onto its own
layer. A `url()` filter is rendered on the CPU into the parent's own backing
store, and a separate layer is outside it. So in Safari the card slid in
unfused and only joined the button once the transition ended.

**The filter is re-rasterized every frame on the CPU.** Safari blurs the whole
filter region again on every frame the source changes. An oversized region
(the original `350%`, about 980×1750px) made the open animation lag; tightening
it to `120%` helped but did not fix the fusing.

The rule this leaves for any goo: **nothing inside the goo may animate on the
compositor.** Either everything moves on one JS clock, or the goo is not a
filter.

---

## 4. Why a canvas, not an SVG path

The step between the filter and the canvas was an SVG `<path>`, traced in JS,
under a CSS `drop-shadow()`. The shape was right, but the shadows were not.

When the path changes, WebKit repaints only the path's old and new bounds, not
the filter's outsets around them. The shadow of a shape that has shrunk or
disappeared stays on screen as stale pixels.

A canvas is cleared and redrawn whole every frame, shadows included, so there
is nothing stale to leave behind.

---

## 5. The field, computed instead of blurred

### A blurred edge is a closed form

Blurring a solid half-plane with a Gaussian of radius σ gives, at signed
distance `d` from the edge, an alpha of exactly `Φ(−d / σ)`, where `Φ` is the
standard normal CDF. So we never blur pixels. For each blob we take the signed
distance to its rounded box (`roundedBoxSdf`), and the field at a point is

```
field(p) = Σ  weight_i · Φ(−sdf_i(p) / σ)
inside   ⇔ field(p) ≥ GOO_THRESHOLD
```

`traceGoo` hands `GOO_THRESHOLD − field` to the tracer, so the traced function
is negative inside, the same sign convention as an SDF.

- `weight` is the blob's alpha (0..1), so a fading blob contributes a weaker
  field. This is what produces the swell-then-pop on open.
- `Φ(−d/σ)` is exact for a straight edge. At corners it is an approximation,
  but the boxes' 16px radii are gentle enough next to σ that the error is not
  visible.
- `blurredEdge` short-circuits to 0 or 1 beyond 4σ.
- `normalCdf` uses the Abramowitz–Stegun 7.1.26 approximation of `erf`
  (absolute error below 1.5e-7).

### Tracing

`fieldContourPath` runs marching squares over the field at `CELL` pitch and
returns closed polygon path data. Interpolated edge crossings keep the error
well under `cell / 10`.

- **Scan bounds.** The scanned rectangle is the union of the blob boxes plus
  `PAD`. Outside a box, the summed field cannot reach the threshold further
  than about σ/3 (two full-weight blobs each contributing just under half), so
  `PAD = 3 · CELL + σ` keeps a few spare cells. The traced function must not
  touch the scanned rectangle's border, or the contour is cut open.
- **Early out.** The field can never exceed the sum of the weights. If that sum
  is below the threshold, there is no goo, and `traceGoo` returns `null`
  without scanning.
- **Cost.** The SDF runs roughly 25k times a frame. It uses `Math.sqrt` rather
  than `Math.hypot`, which is far slower in JavaScriptCore.

---

## 6. One clock

Everything that moves is a `Channel`: a value tweened from `from` to `to`
over `ms` on a `cubicBezier` curve that mirrors the CSS timing tokens
(`MOVE_MS`/`bounce` for `--transition-bounce`, `FADE_MS`/`ease` for
`--transition-fast`). The file menu has three:

| Channel | Drives | Timing |
| ------- | ------ | ------ |
| `#pill` | Button pill alpha (hover, menu open) | bounce |
| `#grow` | Card pose, 0 closed to 1 open | bounce |
| `#fade` | Card alpha, for both the goo blob and the menu content | ease |

Each `requestAnimationFrame` step advances all channels, writes the card's
`transform` and `opacity` inline, builds the blobs, traces, and paints. The
loop stops itself once every channel has reached its target.

Details that matter:

- **Overshoot is clamped where it must be.** The bounce curve overshoots 1.
  That is wanted for the card's scale, but alphas and weights are clamped to
  0..1, as a color channel would be.
- **The first frame runs synchronously** in `#start`, so the frame of the
  triggering event (hover, click) already shows the change.
- **rAF timestamps can predate `t0`.** They are frame start times, so progress
  is computed as `max(0, now − t0) / ms`.
- **Reduced motion** sets `t0 = −Infinity`, so a channel jumps straight to its
  target.
- **Rest boxes are measured once per transition**, not per frame. Sizes only
  change between opens, and `offsetLeft/Top/Width/Height` ignore the transform
  we write, so they always give the untransformed rest box.
- **The card's blob is its rest box under the card's transform.** The card is
  `scale(s) translate(dx, dy)` about its bottom-right corner (CSS
  `transform-origin: bottom right`), so the blob moves the bottom-right corner
  by `s · (dx, dy)` and scales the width, height, and radius by `s` from there.
  The closed pose is `scale(0.85) translate(8px, 16px)` (`CLOSED_*`).

---

## 7. Painting

`#paint` draws the last traced path into the canvas:

- **Bleed.** The canvas overhangs the stage by `BLEED` px on every side, so the
  shadows of blobs touching the stage edge are not clipped. The button sits in
  the stage's corner, so this matters.
- **Device pixels.** The backing store is sized by `devicePixelRatio`, and the
  path is drawn through a `dpr` transform. Canvas shadow offsets and blur
  ignore the transform, so they are multiplied by `dpr` explicitly.
- **Shadow order.** The fill is repeated once per shadow, last-listed shadow
  first, so the first listed sits on top, as in a CSS filter chain. A final fill
  with no shadow draws the shape itself.
- **Empty state.** When there is no goo, the canvas is resized to 0×0, which
  blanks it and releases the backing store.
- **Theme.** Fill and shadows are read from CSS custom properties on the goo
  layer each paint. The night-mode switch lives inside the open menu, so a
  `MutationObserver` on `document.body`'s `class` repaints the cached path
  without retracing.

The CSS contract:

```css
.file-menu-goo-layer {
  --file-menu-goo-fill: var(--bg-secondary);
  --file-menu-goo-shadow-1: 0 0 5px rgba(0, 0, 0, 0.4);    /* on top */
  --file-menu-goo-shadow-2: -1px -1px 1px rgba(255, 255, 255, 0.2);
}
```

Each shadow is `<x> <y> <blur> <color>`, lengths in px. A malformed value is
ignored.

---

## 8. DOM structure

```
.file-menu-stage          positioned box, 280×500, anchored bottom-right
├─ .file-menu-goo-layer   inset: 0, z-index 0, holds the canvas
│  └─ canvas.file-menu-goo-canvas
├─ .file-menu-button
└─ .file-menu-list        the card: transparent background, z-index 1
```

- The **card is a transparent content layer**. It holds only the items and
  text. Its visible background and shadow are the goo behind it. Its
  `border-radius` is still set in CSS, because the blob's radius is read from
  it.
- The goo layer, the button, and the card must **share one `offsetParent`**
  (the stage), because blob boxes are measured with `offset*` and painted in
  the layer's coordinates.
- The card's CSS has no `transition` on `transform` or `opacity`. JS owns both.

---

## 9. Applying it to another component

1. **Make the visible surfaces transparent.** Every element that should look
   like part of the goo gives up its background and shadow. The goo paints them.
2. **Put the goo canvas and the content in one positioned stage**, so all
   measured boxes share an `offsetParent`, and give the canvas enough bleed for
   the largest shadow.
3. **Describe each surface as a `Blob`**: its rest box from `offset*` and
   `border-radius`, a weight equal to its alpha, and whatever transform you
   animate applied to the box in JS.
4. **Move every animated property onto the JS clock.** Remove the CSS
   transitions on transform and opacity from anything that feeds the goo, and
   write them inline in the same frame as the trace. If anything animates on
   the compositor, it will drift from its blob in Safari.
5. **Expose the look as CSS custom properties** (fill, shadows) and repaint on
   theme changes.
6. **Reuse `traceGoo`** if blobs are rounded boxes. For other shapes, swap the
   SDF; the `Φ(−d/σ)` field and the tracer do not care what the shape is, as
   long as the SDF is accurate near the edge.

`FileMenuGoo` is still specific to one button and one card. A second user is
the right time to lift the channel clock, the painter, and `traceGoo` into a
shared module.

---

## 10. Tuning

| Constant | Effect |
| -------- | ------ |
| `GOO_SIGMA` | Blur radius in px. Larger means a fatter bridge that reaches further, so the button swells earlier before the card pops in. Currently 2 (the old filter used 3). |
| `GOO_THRESHOLD` | Where the field turns solid. Lower makes everything fatter and fuse sooner. 0.775 matches the old color matrix. |
| `CELL` | Marching-squares pitch. Smaller is smoother and costs quadratically more. |
| `BLEED` | Canvas overhang. Must cover the largest shadow offset plus blur. |
| `CLOSED_SCALE`, `CLOSED_DX`, `CLOSED_DY` | The card's closed pose. |
| `MOVE_MS`, `FADE_MS`, `bounce`, `ease` | Must stay in sync with `--transition-bounce` and `--transition-fast`. |
