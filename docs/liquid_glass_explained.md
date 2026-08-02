## The fundamental constraint: nothing can "see" the page except backdrop-filter

Glass is convincing only if it distorts what's behind it. But your toolbar is a content script drawing on top of arbitrary pages, and there is no API that hands you the pixels behind an element — not for a canvas, not for anything. The single exception is CSS backdrop-filter: the browser itself grabs whatever is rendered behind an element, runs it through a filter, and paints the result. You never touch the pixels; you only describe the processing.

That constraint splits the whole feature into two halves that can't be merged:

- Things that need the page pixels (blur, saturation, refraction) → must be expressed as a backdrop-filter on a plain div: .glass-backdrop.
- Things painted on top (the tint, the bright edge, the shadow) → drawn by us on a <canvas>: .glass-canvas.

Both are 200×200px layers stacked under your floating ball. Everything else in the system is about making these two layers agree on what shape the goo is at every instant.

## The shape: one formula instead of geometry

The goo is never stored as an outline. It's stored as) — a function you can ask, for any point on screen:"how far are you from the goo's surface?" Negative answer = you're inside; positive = outside; zero = exactly on the edge.

For one circle that function is trivial: distance-froo is two circles (the ball, and the small "lag blob"

This SDF is the single source of truth. It's written twice — once in GLSL for the canvas, once in JavaScript for the displacement map — but it's the same formula with the same inputs, so the two layers always describe the same shape.

## The canvas half: what a "shader" actually is

Strip away the mystique: a fragment shader is a tiny function that the GPU runs once per pixel, in parallel, for all ~160,000 pixels of our layer. it receives the pixel's coordinates and a handful of shared numbers we pass in each frame (ball position, blob position, radii, your tint colors — these are the "uniforms"), . That's the whole model. No loops over the image, nodrawing commands — just "given this pixel, what color?"

Ours does four cheap things per pixel:

1. Am I inside? Evaluate the SDF. Use smoothstep (a soft threshold) around zero so the edge fades over ~1px instead of stair-stepping — that's the anti-aliasing.
2. Tint. Inside pixels get your ball gradient color at very low opacity, so the glass has a hint of body.
3. Edge rim. Take the SDF's gradient — which direction is "outward" from here. Pixels within ~2.5px of the edge get a white glow: strwhen outward points toward the top-left (the light), om-right, faint elsewhere. same visual language as yourtool buttons' inset shadows. This used to be a fake 3t; we deleted that because the real refraction belownow provides the depth cue, and two competing cues looked odd.
4. Shadow. Re-ask the SDF a few pixels up from the current position; if that shifted point is inside, this pixel is under the ball → darken slightly. that's a drop shadow for free, match

Because everything derives from the SDF, when the blob stretches out, tint, rim and shadow all stretch with it. no shapes to update — the formula's inputs changed, and every pixel re-answers.

## The backdrop half: refraction as an SVG filter

Now the part you have the vocabulary for. Real glass bends light — content near the rim appears shifted. fedisplacementmap is precisely that operation: for each output pixel, it reads a pixtwo of its channels as a "go fetch your color from over there" offset. Red = horizontal shift, green = vertical, 128 = don't move. So if we can paint an image describing how glass bends light, the browser does the bending — and because the filter is attached via backdrop-filter: url(#...), the thing being bent is the live page.

How we paint that image (this is refraction_map.js, the kube.io technique):

Step 1 — physics, done once. Imagine slicing the glass edge and looking at its cross-section: the surface rises from zero at the silhouette to full height toward the interior (your profile/bezelheight/thickness knobs shape this hill). for 128 sample points along that slope, we shoot a ray straight down (your eye looking at the page), bend it at the surface using Snell's law — the "light entering denser medium bends" formula, with your refractiveInde page, noting how far sideways it drifted. Result: alittle table of 128 numbers — "at this depth inside the edge, the page appears shifted by this many pixels." Steep slope near the edge →big shift; flat center → no shift. This table is the changes.

Step 2 — painting, every frame. Walk over a 200×200 canvas. For each pixel, ask the JavaScript copy of the sdf: how deep inside the goo am i? look the shift magnitude up in the table. ask the sdf's gradient: which way is "inward"? multiply the two, encode as red/green around 128, and you have the displacement map for thend taper included, because the smooth-min already putthem inside the field. The canvas becomes a PNG data-mage.

The full filter graph is then plain SVG-filter plumbing you can read top to bottom:

feImage → the map we just painted
feDisplacementMap → bend the page backdrop using map R/G
feGaussianBlur → frost (yours is currently 0)
feColorMatrix → saturation boost
feColorMatrix → pull the map's BLUE channel into alpha…
feComposite "in" → …and use it to cut out the goo shape

Those last two lines are the fix from our final round. The map's blue channel was unused, so while painting the map we also write "is this pixel inside the goo?" into blue (with a soft 1.5px edge). the filter turns that into a mask and clips its own output with it.
Before, the visible outline came from a clip-path buionstruction (Bézier arcs and fillets) that disagreedwith the SDF exactly at the viscous taper — hence your dead delta region. Now the shape that refracts and the shape you see are the same pixels of the same image. They cannot disagree.

## The choreography

At rest, nothing runs — one cached canvas frame, one cached map. When you drag or click, the physics wake a requestAnimationFrame loop, and each frame does three writes: push new uniforms to the shader (the GPU repaints instantly), repaint the displacement map from the moved SDF (~3–4ms, at reduced resolution during motion), and swap it into the feImage. When the spring settles, one final frame re-paints the map at double resolution for a crisp resting ball, and the loop stops.

One asterisk: SVG filters as backdrop-filter only render in Chromium — Safari and Firefox parse the CSS and silently paint nothing. So the whole refraction path is gated behind a Chromium check, and other browsers keep the previous look: plain blur clipped by the Bézier outline, with the shader still providing tint, rim, and shadow.

Your mental model in one paragraph

One math function defines the goo. The GPU canvas asks it per-pixel to paint what's on the glass; a per-frame image asks it per-pixel to tell the browser how to bend and mask what's behind the glass; and the physics just wiggles that function's inputs. Every knob you've been tuning is either reshaping the glass hill (REFRA light (RIM_* in the shader), or changing the fluid'sbehavior (goo_state.js).
