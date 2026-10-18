/**
 * Darken anti-aliased edges in a PDFium raster so text reads at the weight
 * Preview and Chrome show on macOS (issue #25).
 *
 * Those viewers hand glyphs to CoreGraphics, whose font smoothing thickens
 * stems. Our wasm PDFium has no CoreGraphics, so every glyph is plain FreeType
 * coverage and looks thin. See docs/text_rendering.md for the measurements.
 *
 * A gamma curve on each channel pulls edge pixels toward the stroke colour and
 * leaves pure white and pure black untouched. γ = 1.5 matched the ink of
 * native-text renders to within 0.1% on body text. The dilation step #25 also
 * proposed overshot that target and costs several times more, so it is left
 * out.
 *
 * This is a stopgap until PDFium can embolden glyphs itself. It applies to
 * the whole raster, so figures and images come out ~10% darker too.
 */

const GAMMA = 1.5;

const LUT = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  LUT[v] = Math.round(255 * (v / 255) ** GAMMA);
}

/** Opaque white, the bulk of a page, which the curve leaves as it is. */
const WHITE = 0xffffffff;

/**
 * Apply the curve in place to RGBA (or BGRA) pixels. Alpha is not touched.
 */
export function applyTextGamma(pixels: Uint8ClampedArray | Uint8Array): void {
  // Skipping white a pixel at a time needs a 32-bit view, which needs the
  // data 4-byte aligned. A raster from PDFium always is.
  if (pixels.byteOffset % 4 === 0 && pixels.byteLength % 4 === 0) {
    const words = new Uint32Array(
      pixels.buffer,
      pixels.byteOffset,
      pixels.byteLength / 4,
    );
    for (let i = 0; i < words.length; i++) {
      if (words[i] === WHITE) continue;
      const o = i * 4;
      pixels[o] = LUT[pixels[o]];
      pixels[o + 1] = LUT[pixels[o + 1]];
      pixels[o + 2] = LUT[pixels[o + 2]];
    }
    return;
  }

  for (let o = 0; o + 3 < pixels.length; o += 4) {
    pixels[o] = LUT[pixels[o]];
    pixels[o + 1] = LUT[pixels[o + 1]];
    pixels[o + 2] = LUT[pixels[o + 2]];
  }
}
