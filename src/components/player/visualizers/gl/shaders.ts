/*
 * The shader sources every WebGL visualizer shares: the full-screen triangle, the uniform prelude with
 * its band and palette helpers, the readability hush, and the trail, bloom and composite passes.
 */

/** How many text blocks the hush can hold at once: the Player's source line and its title block. */
export const HUSH_SLOTS = 2;

/**
 * The readability hush: 1 over each text block, easing to 0 across a wide feathered ellipse around it,
 * so a visualizer can quiet itself behind the words with no visible edge. Each slot is a rect in GL
 * pixels; an empty slot has zero width. The ellipse passes through the rect's corners, and the falloff
 * runs on its approximate distance so the feather keeps one width all the way round.
 */
export const HUSH = `
uniform vec4 uHush[${HUSH_SLOTS}];
uniform float uHushFeather;
float hushAt(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < ${HUSH_SLOTS}; i++) {
    vec4 r = uHush[i];
    if (r.z <= 0.0) continue;
    vec2 rad = r.zw * 0.7071;
    vec2 q = p - (r.xy + r.zw * 0.5);
    float k1 = length(q / rad);
    float sd = k1 < 1.0 ? (k1 - 1.0) * min(rad.x, rad.y) : k1 * (k1 - 1.0) / length(q / (rad * rad));
    h = max(h, 1.0 - smoothstep(-0.25 * uHushFeather, uHushFeather, sd));
  }
  return h;
}
`;

/** A full-screen triangle; vUv runs 0..1 across the stage. */
export const FS_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** The common uniforms and helpers a full-screen visualizer pass starts from. */
export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uTime;
uniform float uBands[24];
uniform float uRms;
uniform float uPeak;
uniform float uFlux;
uniform float uKick;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform vec3 uPal[3];
uniform vec4 uCover;
uniform float uRadius;
uniform float uAmbient;
uniform float uDpr;
in vec2 vUv;
out vec4 outColor;
const float PI = 3.14159265;
const float TAU = 6.2831853;
float band(float m) {
  float f = clamp(m, 0.0, 1.0) * 23.0;
  int i = int(floor(f));
  int j = min(i + 1, 23);
  float k = f - float(i);
  k = k * k * (3.0 - 2.0 * k);
  return mix(uBands[i], uBands[j], k);
}
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 pal(float x) { x = clamp(x, 0.0, 2.0); return x < 1.0 ? mix(uPal[0], uPal[1], x) : mix(uPal[1], uPal[2], x - 1.0); }
vec2 coverCenter() { return uCover.xy + uCover.zw * 0.5; }
`;

/** Feeds the previous frame back, decayed, zoomed and turned about a centre, for trails. */
export const TRAIL_FS = `${PRELUDE}
uniform sampler2D uPrev;
uniform float uDecay;
uniform vec2 uCenter;
uniform float uZoom;
uniform float uRot;
void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float c = cos(uRot), s = sin(uRot);
  p = mat2(c, -s, s, c) * p / uZoom;
  vec2 uv = (p + uCenter) / uRes;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  outColor = texture(uPrev, uv) * uDecay * inside;
}`;

/** A four-tap downsample with a soft brightness threshold, the first bloom step. */
export const DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 s = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s *= 0.25;
  float l = max(s.r, max(s.g, s.b));
  outColor = vec4(s * (max(0.0, l - uThreshold) / max(l, 1e-4)), 1.0);
}`;

/** A separable nine-tap gaussian on linear taps. */
export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.227027;
  c += (texture(uSrc, vUv + uDir * 1.3846).rgb + texture(uSrc, vUv - uDir * 1.3846).rgb) * 0.3162162;
  c += (texture(uSrc, vUv + uDir * 3.2308).rgb + texture(uSrc, vUv - uDir * 3.2308).rgb) * 0.0702703;
  outColor = vec4(c, 1.0);
}`;

/**
 * Adds the bloom and maps the scene onto the stage: mode 0 is light tone-mapped for a screen blend on a
 * dark ground, mode 1 is ink of the same hue for a multiply blend on a light ground, mode 2 is a straight
 * premultiplied image. The mask feathers the layer off outside a rect; the vignette darkens the corners.
 */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform int uMode;
uniform float uBloomK;
uniform float uExposure;
uniform vec4 uMask;
uniform float uMaskOn;
uniform float uFeather;
uniform float uVignette;
uniform vec2 uRes;
in vec2 vUv;
out vec4 outColor;
float maskAt(vec2 fc) {
  float m = 1.0;
  if (uMaskOn > 0.5) {
    vec2 d = max(uMask.xy - fc, fc - (uMask.xy + uMask.zw));
    m = 1.0 - smoothstep(-uFeather, 0.0, max(d.x, d.y));
  }
  vec2 q = (vUv - 0.5) * vec2(1.0, 1.1);
  return m * mix(1.0, smoothstep(0.85, 0.25, length(q)), uVignette);
}
void main() {
  vec4 s = texture(uScene, vUv);
  vec3 b = texture(uB1, vUv).rgb * 0.7 + texture(uB2, vUv).rgb * 1.0;
  vec3 c = max(s.rgb + b * uBloomK, 0.0);
  float m = maskAt(gl_FragCoord.xy);
  if (uMode == 0) {
    outColor = vec4((1.0 - exp(-c * uExposure)) * m, 1.0);
  } else if (uMode == 1) {
    float mx = max(c.r, max(c.g, c.b));
    float i = 1.0 - exp(-mx * uExposure);
    vec3 hue = c / max(mx, 1e-4);
    vec3 ink = pow(hue, vec3(1.8)) * (0.78 - 0.28 * i);
    // Push the ink's chroma so palette hues stay colored on paper instead of drifting to grey.
    ink = clamp(mix(vec3(dot(ink, vec3(0.299, 0.587, 0.114))), ink, 1.45), 0.0, 1.0);
    outColor = vec4(mix(vec3(1.0), ink, i * 0.92 * m), 1.0);
  } else {
    vec3 col = s.rgb + b * uBloomK * s.a;
    outColor = vec4(min(col, vec3(s.a)) * m, s.a * m);
  }
}`;
