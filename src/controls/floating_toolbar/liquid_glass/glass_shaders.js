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

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float field(vec2 p) {
  float d1 = length(p - u_ball.xy) - u_ball.z;
  float d2 = length(p - u_blob.xy) - u_blob.z;
  return smin(d1, d2, u_k);
}

void main() {
  // DOM-matched coordinates: CSS px, origin top-left, y-down.
  vec2 p = vec2(gl_FragCoord.x, u_size.y * u_dpr - gl_FragCoord.y) / u_dpr;

  float d = field(p);
  float aa = max(fwidth(d), 0.001);
  float body = smoothstep(aa, -aa, d);

  // Soft shadow below the shape, only visible outside the body.
  float ds = field(p - vec2(0.0, 6.0));
  float shadow = (1.0 - body) * smoothstep(8.0, -12.0, ds) * 0.32;

  // Outward silhouette direction from the field's screen-space gradient.
  vec2 g = vec2(dFdx(d), dFdy(d)) * u_dpr;
  float gl2 = length(g);
  g = gl2 > 1e-5 ? g / gl2 : vec2(0.0);

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
  float alpha = clamp(bodyAlpha + rim * rimGain, 0.0, 1.0);

  // Premultiplied output; the shadow is pure black so it only adds alpha.
  outColor = vec4(col * body, alpha * body + shadow);
}
`;
