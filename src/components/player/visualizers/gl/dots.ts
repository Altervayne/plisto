/*
 * The shared half of the dot-matrix visualizers (Halftone, Dot spectrum, Dot cover). Each is one or two
 * instanced draws of round dots: the vertex shader places and sizes every dot from its grid cell, the
 * fragment shader draws a soft disc. On a dark stage the dots are light, added up and bloomed; on a light
 * one they are premultiplied ink. Dot cover paints the cover's real colors in both themes.
 *
 * Photosensitivity: dot brightness follows only the eased level. The motion envelopes and the beat waves
 * change dot size and position, never brightness. Both arrive already scaled by the reactivity gain, so
 * under Calm every reactive term is zero and only the slow drift remains.
 */

// -- Local Imports --
import { HUSH } from "./shaders";

// -- Type Imports --
import type { Frame, Kit, Program } from "./kit";

// Beats travelling at once, and how long one lives in seconds before it is dropped.
const BEAT_SLOTS = 4;
const BEAT_LIFE = 3;
// Where the fields rest: this many CSS pixels above the floor element's top edge.
const FLOOR_GAP = 14;

/** The uniforms, palette, beat waves and emit helper every dot vertex shader starts from. */
export const DOT_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aCorner;
uniform vec2 uRes;
uniform float uTime;
// The eased level: the one brightness driver.
uniform float uRms;
uniform float uEnvB;
uniform float uEnvM;
uniform float uEnvH;
// Per beat: its age in seconds and its strength.
uniform vec2 uBeats[${BEAT_SLOTS}];
uniform vec3 uPal[3];
uniform float uLight;
uniform vec4 uCover;
uniform float uRadius;
out vec2 vLocal;
out vec3 vRgb;
out float vAlpha;
out float vHalo;
out float vRpx;
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 pal(float x) { x = clamp(x, 0.0, 2.0); return x < 1.0 ? mix(uPal[0], uPal[1], x) : mix(uPal[1], uPal[2], x - 1.0); }
// A palette color deepened into an ink that holds its hue on a pale ground.
vec3 ink(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return clamp(mix(vec3(l), c, 1.35) * 0.7, 0.0, 1.0); }
vec2 coverCenter() { return uCover.xy + uCover.zw * 0.5; }
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
${HUSH}
// The sum of the beat waves at distance d: each front travels at speed and fades as it ages.
float beatWave(float d, float speed, float width, float fade) {
  float w = 0.0;
  for (int i = 0; i < ${BEAT_SLOTS}; i++) {
    vec2 b = uBeats[i];
    if (b.y <= 0.0) continue;
    float x = (d - b.x * speed) / width;
    w += b.y * exp(-x * x) * exp(-b.x * fade);
  }
  return w;
}
void hide() { vLocal = vec2(0.0); vRgb = vec3(0.0); vAlpha = 0.0; vHalo = 0.0; vRpx = 1.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0); }
void emit(vec2 c, float r, vec3 rgb, float alpha, float halo) {
  float ext = halo > 0.0 ? 2.6 : 1.0 + 1.5 / max(r, 0.5);
  vLocal = aCorner * ext; vRgb = rgb; vAlpha = alpha; vHalo = halo; vRpx = r;
  vec2 p = c + aCorner * ext * r;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** The soft disc every dot draws, premultiplied. */
export const DOT_FS = `#version 300 es
precision highp float;
uniform float uSoft;
in vec2 vLocal;
in vec3 vRgb;
in float vAlpha;
in float vHalo;
in float vRpx;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float e = max(uSoft, 1.4 / max(vRpx, 0.5));
  float core = 1.0 - smoothstep(1.0 - e, 1.0, d);
  float glow = vHalo * exp(-d * d * 0.8) * 0.45;
  if (core <= 0.0 && glow < 0.003) discard;
  float a = core * vAlpha;
  // The halo adds light without coverage, so on the additive dark stage it reads as a soft glow.
  outColor = vec4(vRgb * (a + glow * vAlpha), a);
}`;

/** The instanced quad, the travelling beats and the blend one dot candidate draws with. */
export interface Dots {
  // Ages the beats, takes a new one off the signal, and sets the shared uniforms on `p`.
  begin: (p: Program, f: Frame) => void;
  // Draws `count` dots; `glow` adds light, otherwise coverage stacks as premultiplied color.
  draw: (count: number, glow: boolean) => void;
  // The GL y of the line the fields rest on.
  floorY: () => number;
  dispose: () => void;
}

export function createDots(kit: Kit): Dots {
  const { gl } = kit;
  const corners = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(corners);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Live beats, newest first: age in seconds and strength.
  const beats: { age: number; strength: number }[] = [];
  const packed = new Float32Array(BEAT_SLOTS * 2);

  const begin = (p: Program, f: Frame) => {
    for (const b of beats) b.age += f.dt;
    while (beats.length > 0 && beats[beats.length - 1].age > BEAT_LIFE) beats.pop();
    if (f.sig.beat > 0) {
      beats.unshift({ age: 0, strength: f.sig.beat });
      if (beats.length > BEAT_SLOTS) beats.pop();
    }
    packed.fill(0);
    beats.forEach((b, i) => packed.set([b.age, b.strength], i * 2));

    kit.setCommon(p, f);
    const s = f.sig;
    kit.set1(p, "uEnvB", s.bassMotion);
    kit.set1(p, "uEnvM", s.midMotion);
    kit.set1(p, "uEnvH", s.highMotion);
    gl.uniform2fv(kit.uniform(p, "uBeats"), packed);
    kit.set1(p, "uLight", f.light ? 1 : 0);
    kit.set1(p, "uSoft", f.light ? 0.16 : 0.3);
  };

  const draw = (count: number, glow: boolean) => {
    gl.enable(gl.BLEND);
    if (glow) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(corners);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  };

  const floorY = () => (kit.geo.floor != null ? kit.geo.floor + FLOOR_GAP * kit.size.dpr : 0);

  const dispose = () => {
    gl.deleteVertexArray(corners);
    gl.deleteBuffer(vbo);
  };

  return { begin, draw, floorY, dispose };
}
