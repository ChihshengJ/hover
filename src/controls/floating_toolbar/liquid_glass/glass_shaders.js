/**
 * GLSL sources for the liquid-glass ball. One fullscreen-quad pass.
 *
 * The fragment shader derives everything from a single signed-distance
 * field (two circles combined with a polynomial smooth-min):
 *   - silhouette  → smoothstep over the distance, AA'd with fwidth,
 *   - drop shadow → the same field sampled at a downward offset,
 *   - edge rim    → a thin band at the silhouette, brightest toward the
 *                   fixed top-left light with a dimmer counter-edge —
 *                   the same language as the tool buttons' inset shadows.
 *
 * There is deliberately no dome/specular lighting: the depth cue comes
 * from the backdrop layer (frost everywhere; live rim refraction on
 * Chromium — see refraction_map.js), so this pass only supplies tint,
 * the bright glass edge and the shadow. It needs no backdrop texture —
 * a content-script canvas cannot read the page behind it anyway.
 * Output is premultiplied alpha.
 */

export const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const FRAG_SRC = `#version 300 es
precision highp float;

out vec4 outColor;

uniform vec2  u_size;   // canvas size, CSS px
uniform float u_dpr;
uniform vec3  u_ball;   // center x, y (CSS px, y-down), radius
uniform vec3  u_blob;
uniform float u_k;      // smooth-min radius
uniform vec3  u_tintA;  // ball-style gradient endpoints (linear-ish sRGB)
uniform vec3  u_tintB;
uniform vec2  u_grad;   // unit direction of the tint gradient, y-down
uniform float u_night;  // 0 = day, 1 = night
uniform vec3  u_glow;   // pointer glow: center x, y (CSS px), intensity 0..1

// ── Edge-rim knobs. Tunable. ────────────────────────────────────────
// Width of the lit band inside the silhouette, px.
const float RIM_WIDTH   = 2.5;
// Falloff shaping: > 1 hugs the edge tighter, < 1 bleeds inward.
const float RIM_FALLOFF = 1.2;
// Gains for the light-facing edge, the opposite edge, and everywhere.
const float RIM_MAIN    = 0.95;
const float RIM_COUNTER = 0.55;
const float RIM_AMBIENT = 0.12;
// Unit direction toward the light, y-down (top-left, matching the
// app's shadow language and the tool buttons' inset highlights).
const vec2  RIM_LIGHT   = vec2(-0.5547, -0.8321);

// ── Pointer-glow knobs. Tunable. ────────────────────────────────────
// Gaussian falloff radius, px: wide+faint on hover, tight+bright on press
// (interpolated by u_glow.z, which carries the hover/press intensity).
const float GLOW_HOVER_R = 30.0;
const float GLOW_PRESS_R  = 20.0;
// Additive gains for the glow's color and its contribution to alpha.
const float GLOW_GAIN    = 0.45;
const float GLOW_ALPHA   = 0.25;

/**
 * The field and its exact gradient: vec3(gradient.xy, distance).
 *
 * The two circles are joined by the cubic (C2) polynomial smooth-min
 *   smin(a, b, k) = min(a, b) - h^3 * k / 6,  h = max(k - |a - b|, 0) / k
 * inlined below. The quadratic form this replaces is only C1: its second
 * derivative steps where the clamp releases, so the silhouette's curvature
 * jumped discontinuously at |a - b| = k (measured: 1/35 exactly, then 35%
 * lower one sample later). Shading reads curvature, so a G1-but-not-G2 join
 * is invisible in the outline and shows as a hard crease in the rim — the
 * "glass cone edge" on the stretched bridge. h^3 has zero first *and*
 * second derivative at h = 0, which removes it. Peak correction is k/6
 * against the quadratic's k/4, so u_k carries a matching 1.5x (see
 * GooState.sample) and the silhouette is otherwise unchanged.
 * refraction_map.js's smin() must stay identical to this.
 *
 * The gradient is analytic rather than dFdx/dFdy-derived — screen
 * derivatives are constant across a 2x2 fragment quad, which is enough to
 * stipple the rim on a shape this small. Differentiating the above:
 *   grad = (g1 + g2)/2 + sign(a - b) * (h^2 - 1)/2 * (g1 - g2)
 * The sign() discontinuity at a == b is multiplied by (h^2 - 1), which is
 * exactly 0 there, so the gradient stays continuous across the seam.
 *
 * Note |grad| < 1 wherever the two circles blend (it sags to ~0.78 over a
 * fully stretched bridge): a smooth-min is not a distance field. Callers
 * that spend the distance in px must divide it out.
 */
vec3 fieldAndGrad(vec2 p) {
  vec2 r1 = p - u_ball.xy;
  vec2 r2 = p - u_blob.xy;
  float l1 = max(length(r1), 1e-5);
  float l2 = max(length(r2), 1e-5);
  float a = l1 - u_ball.z;
  float b = l2 - u_blob.z;
  vec2 g1 = r1 / l1;
  vec2 g2 = r2 / l2;

  float u = a - b;
  float h = max(u_k - abs(u), 0.0) / u_k;
  float d = min(a, b) - h * h * h * u_k * (1.0 / 6.0);
  vec2  g = 0.5 * (g1 + g2) + 0.5 * sign(u) * (h * h - 1.0) * (g1 - g2);
  return vec3(g, d);
}

/** Euclidean-corrected distance, px — see fieldAndGrad's |grad| note. */
float fieldDist(vec2 p) {
  vec3 fg = fieldAndGrad(p);
  return fg.z / max(length(fg.xy), 1e-4);
}

void main() {
  // DOM-matched coordinates: CSS px, origin top-left, y-down.
  vec2 p = vec2(gl_FragCoord.x, u_size.y * u_dpr - gl_FragCoord.y) / u_dpr;

  // Distance and outward normal in one evaluation.
  vec3 fg = fieldAndGrad(p);
  float gm = max(length(fg.xy), 1e-4);
  vec2 g = fg.xy / gm;

  // Silhouette AA runs on the *raw* field: fwidth already divides out the
  // field's local scale, and the raw value stays finite at the interior
  // point where the two circles' gradients cancel (|grad| -> 0). The
  // normalized distance blows up there, and fwidth of it with it, which
  // would punch a soft hole through the middle of the bridge.
  float aa = max(fwidth(fg.z), 0.001);
  float body = smoothstep(aa, -aa, fg.z);

  // Everything below spends the distance as an absolute length in px, so it
  // uses the gradient-normalized distance: the raw smooth-min under-reports
  // depth by up to 1.28x over the bridge, which used to fatten the rim band
  // exactly where the blend seam already drew the eye. Near that same
  // interior singularity d -> -inf, which every consumer below saturates on
  // as "deep interior" — the correct answer there.
  float d = fg.z / gm;

  // Soft shadow below the shape, only visible outside the body.
  float ds = fieldDist(p - vec2(0.0, 6.0));
  float shadow = (1.0 - body) * smoothstep(8.0, -12.0, ds) * 0.32;

  // Bimodal rim: a band hugging the edge, bright where it faces the
  // light, half-bright on the opposite edge, faint everywhere else.
  float band = pow(smoothstep(RIM_WIDTH, 0.0, -d), RIM_FALLOFF);
  float dl = dot(g, RIM_LIGHT);
  float rim = band * (RIM_MAIN * smoothstep(0.0, 1.0, dl)
                    + RIM_COUNTER * smoothstep(0.0, 1.0, -dl)
                    + RIM_AMBIENT);

  // Glass body tint from the user's ball gradient, kept translucent.
  float gc = clamp(0.5 + dot(p - u_ball.xy, u_grad) / (2.0 * u_ball.z), 0.0, 1.0);
  vec3 tint = mix(u_tintA, u_tintB, gc);

  float bodyAlpha = mix(0.24, 0.15, u_night);
  vec3 rimColor = mix(vec3(1.0), vec3(0.75, 0.82, 0.95), u_night);
  float rimGain = mix(1.0, 0.72, u_night);

  vec3 col = tint * bodyAlpha + rimColor * rim * rimGain;
  float alpha = bodyAlpha + rim * rimGain;

  // Pointer-tracking specular glow. Follows the cursor over the surface
  // (faint on hover, bright on press); the body multiply at output masks
  // it to the metaball silhouette, so it rides the goo like the rim.
  float gdist = length(p - u_glow.xy);
  float grad  = mix(GLOW_HOVER_R, GLOW_PRESS_R, smoothstep(0.4, 1.0, u_glow.z));
  float glow  = exp(-gdist * gdist / (2.0 * grad * grad)) * u_glow.z;
  vec3 glowColor = mix(vec3(1.0), vec3(0.80, 0.87, 1.0), u_night);
  col += glowColor * glow * GLOW_GAIN;
  alpha = clamp(alpha + glow * GLOW_ALPHA, 0.0, 1.0);

  // Premultiplied output; the shadow is pure black so it only adds alpha.
  outColor = vec4(col * body, alpha * body + shadow);
}
`;
