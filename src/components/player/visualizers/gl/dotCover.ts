/*
 * Dot cover: the album cover redrawn as a square matrix of its own sampled colors, each dot sized by its
 * pixel's tone, on a paper or near-black backing that keeps the cover's size and radius. The bass
 * envelope breathes the whole image, every dot swelling as the matrix opens slightly from its centre, and
 * each beat pushes a ring ripple through the dots. The ripple carries on through an echo: a coarse field
 * of the cover's blurred colors across the stage above the seek bar, hushed behind the words.
 *
 * Paints real color in both themes, so it composites straight with no bloom.
 */

// -- Local Imports --
import { createDots, DOT_FS, DOT_PRELUDE } from "./dots";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// Matrix size across the cover, in ambient and in the Player.
const MATRIX_AMBIENT = 46;
const MATRIX_PLAYER = 40;
// The echo's grid pitch in CSS pixels, in ambient and in the Player.
const ECHO_PITCH_AMBIENT = 26;
const ECHO_PITCH_PLAYER = 20;

// Mode 0 draws the cover itself as an N x N matrix; mode 1 draws the echo field.
const VS = `${DOT_PRELUDE}
uniform sampler2D uCoverTex;
uniform int uMode;
uniform int uN;
uniform vec2 uOrigin;
uniform float uPitch;
uniform int uCols;
uniform vec4 uField;
void main() {
  vec2 cc = coverCenter();
  float side = uCover.z;
  if (uMode == 0) {
    int gx = gl_InstanceID % uN, gy = gl_InstanceID / uN;
    vec2 uv = (vec2(float(gx), float(gy)) + 0.5) / float(uN);
    float pitch = side / float(uN);
    vec3 col = textureLod(uCoverTex, uv, 2.6).rgb;
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    vec2 rel = (uv - 0.5) * side;
    // The matrix keeps the cover's rounded corners.
    if (sdRound(rel, vec2(side * 0.5), uRadius) > -pitch * 0.35) { hide(); return; }
    float d = length(rel) / side;
    vec2 c = cc + rel * (1.0 + 0.035 * uEnvB);
    float w = beatWave(d, 0.9, 0.055, 1.6);
    c += normalize(rel + 1e-4) * w * pitch * 0.8;
    float shimmer = uEnvH * (0.5 + 0.5 * sin(d * 46.0 - uTime * 4.0));
    float s = 0.33 + 0.15 * (uLight > 0.5 ? 1.0 - luma : sqrt(luma));
    s += 0.08 * uEnvB + 0.1 * w + 0.035 * shimmer;
    s = clamp(s, 0.12, 0.52);
    if (uLight > 0.5) emit(c, s * pitch, col, 0.94, 0.0);
    else emit(c, s * pitch, col * (0.85 + 0.25 * uRms), 1.0, 0.0);
    return;
  }
  int gx = gl_InstanceID % uCols, gy = gl_InstanceID / uCols;
  vec2 c = uOrigin + vec2(float(gx) + float(gy % 2) * 0.5, float(gy) * 0.8660254) * uPitch;
  if (c.x < uField.x - uPitch || c.x > uField.z + uPitch || c.y > uField.w + uPitch) { hide(); return; }
  vec2 rel = c - cc;
  float d = length(rel) / side;
  vec2 uv = rel / (side * 2.6) + 0.5;
  vec3 col = textureLod(uCoverTex, uv, 6.0).rgb;
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  float w = beatWave(d, 0.9, 0.08, 0.9);
  c += normalize(rel + 1e-4) * w * uPitch * 0.35;
  float near = exp(-d * 0.9);
  float s = 0.1 + 0.12 * (uLight > 0.5 ? 1.0 - luma : sqrt(luma));
  s += 0.1 * uEnvB * near + 0.16 * w;
  s = clamp(s * mix(1.0, 0.45, hushAt(c)), 0.04, 0.45);
  float fade = 0.35 + 0.65 * exp(-d * 0.45);
  if (uLight > 0.5) emit(c, s * uPitch, col, 0.42 * fade, 0.0);
  else emit(c, s * uPitch, col * (0.75 + 0.3 * uRms) * 0.8 * fade, 0.6 * fade, 0.0);
}`;

// The backing under the matrix: the cover's rounded rect in one flat color.
const BACKING_FS = `#version 300 es
precision highp float;
uniform vec4 uCover;
uniform float uRadius;
uniform vec3 uColor;
in vec2 vUv;
out vec4 outColor;
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  float sd = sdRound(gl_FragCoord.xy - (uCover.xy + uCover.zw * 0.5), uCover.zw * 0.5, uRadius);
  float a = clamp(0.5 - sd, 0.0, 1.0);
  outColor = vec4(uColor * a, a);
}`;

export function createDotCover(kit: Kit): Candidate {
  const { gl } = kit;
  const dots = createDots(kit);
  const tex = gl.createTexture();
  if (!tex) throw new Error("texture allocation failed");
  let uploaded: ImageBitmap | null = null;

  // The bitmap arrives flipped for GL, so it uploads as is; mipmaps carry the matrix and echo blurs.
  const upload = (bitmap: ImageBitmap) => {
    uploaded = bitmap;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  };

  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      if (!f.cover) return;
      if (f.cover !== uploaded) upload(f.cover);
      const { w: W, h: H, dpr } = kit.size;
      const { mask, cover } = kit.geo;
      // The echo first, then the backing over it, then the cover's own dots.
      const pitch = (f.ambient ? ECHO_PITCH_AMBIENT : ECHO_PITCH_PLAYER) * dpr;
      const rowH = pitch * 0.8660254;
      const x0 = mask ? mask[0] : 0;
      const x1 = mask ? mask[0] + mask[2] : W;
      const y0 = dots.floorY();
      const cx = cover[0] + cover[2] / 2;
      const ox = cx - pitch * Math.ceil((cx - x0) / pitch + 1);
      const cols = Math.ceil((x1 - ox) / pitch) + 1;
      const rows = Math.max(0, Math.ceil((H - y0) / rowH) + 1);
      const p = kit.program("dotCover", VS, DOT_FS);
      dots.begin(p, f);
      kit.bindTex(p, "uCoverTex", 0, tex);
      kit.seti(p, "uMode", 1);
      kit.set2(p, "uOrigin", ox, y0 + pitch * 0.5);
      kit.set1(p, "uPitch", pitch);
      kit.seti(p, "uCols", cols);
      kit.set4(p, "uField", [x0, y0, x1, H]);
      dots.draw(cols * rows, false);

      const b = kit.program("dotCoverBacking", FS_VS, BACKING_FS);
      gl.useProgram(b.handle);
      kit.set4(b, "uCover", cover);
      kit.set1(b, "uRadius", kit.geo.radius);
      gl.uniform3f(kit.uniform(b, "uColor"), f.backing[0], f.backing[1], f.backing[2]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      kit.drawQuad();
      gl.disable(gl.BLEND);

      const n = f.ambient ? MATRIX_AMBIENT : MATRIX_PLAYER;
      gl.useProgram(p.handle);
      kit.seti(p, "uMode", 0);
      kit.seti(p, "uN", n);
      dots.draw(n * n, false);
    },
    dispose() {
      gl.deleteTexture(tex);
      dots.dispose();
    },
  };
}
