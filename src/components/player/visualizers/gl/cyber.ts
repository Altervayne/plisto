/*
 * The shared kit of the cyber visualizers: GLSL helpers spliced into each scene shader after the scene
 * prelude, and the motion easing the scene steps share. A scene's gain is the reactivity drive while the
 * track plays and 0 when paused, so a paused scene holds its flat silence look.
 *
 * Photosensitivity: nothing here raises brightness. The eased bands and the beat envelope feed shape only
 * (heights, radii, travel), and both are held at zero under Calm and while paused.
 */

// -- Local Imports --
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

// Time constants of the band easing (attack, release) and of the beat envelope (rise, fall, target decay), in s.
const BAND_UP_TAU = 0.05;
const BAND_DOWN_TAU = 0.3;
const BEAT_UP_TAU = 0.07;
const BEAT_DOWN_TAU = 0.5;
const BEAT_TARGET_TAU = 0.22;

/** The GLSL helpers every cyber scene uses. Reads `luma`, `hash21`, `uPal`, `uGround` and `uCoverTex` from the prelude. */
export const CYBER_KIT = `
// Smooth inside mask from a signed distance (negative inside), s in css px.
float soft(float sd, float s) { return 1.0 - smoothstep(-s, s, sd); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
vec3 sat(vec3 c, float k) { return mix(vec3(luma(c)), c, k); }
// The cover texture at a unit-square uv, at a chosen blur level.
vec3 coverAt(vec2 uv, float lod) { return textureLod(uCoverTex, clamp(uv, 0.0, 1.0), lod).rgb; }
// A cover palette colour pushed toward neon: more saturated, lifted, capped per channel.
vec3 neon(int i) { vec3 c = uPal[i]; return min(sat(c, 1.45) * 0.95 + 0.07, vec3(0.95)); }
// Tiny silkscreen text: 3x5 glyphs on a 4 px advance, random bits per glyph, n characters from origin o.
float silkText(vec2 p, vec2 o, float n, float seed) {
  vec2 l = p - o;
  if (l.x < 0.0 || l.y < 0.0 || l.y >= 5.0 || l.x >= n * 4.0) return 0.0;
  float ch = floor(l.x / 4.0);
  vec2 g = vec2(floor(mod(l.x, 4.0)), floor(l.y));
  if (g.x > 2.5) return 0.0;
  return step(0.48, hash21(vec2(ch + seed, g.x * 5.0 + g.y + seed * 3.0)));
}
// Eased glitch: rows are cut into slices of varied height and a few slide sideways by amt px, then return. amt is an
// eased envelope, so slices glide; nothing is inverted or flashed.
float sliceShift(float y, float amt, float seed) {
  float band = floor(y / (12.0 + 46.0 * hash11(floor(y / 96.0) + seed)) + seed);
  float on = step(0.70, hash11(band * 1.7 + seed));
  return (hash11(band * 3.1 + seed) - 0.5) * 2.0 * on * amt;
}
// Quiets a colour toward the stage ground behind the text zones.
vec3 hushed(vec3 col, float hu, float k) { return mix(col, uGround, hu * k); }
`;

/** The motion gain of a frame: the reactivity drive while playing (0 under Calm, 1.6 at Lively), 0 when paused. */
export function cyberGain(sig: VisualSignal, playing: boolean): number {
  return playing ? sig.drive : 0;
}

/**
 * Eases the 24 bands into `eased` in place (fast attack, slow release), scaled by the gain and capped at 1,
 * and returns it. Packed in band order, it fills a `vec4[6]` uniform.
 */
export function cyberBands(eased: Float32Array, sig: VisualSignal, gain: number, dt: number): Float32Array {
  for (let i = 0; i < eased.length; i++) {
    const target = gain > 0 ? Math.min(1, sig.bands[i] * Math.min(1.6, gain)) : 0;
    eased[i] = easeEnvelope(eased[i], target, dt, target > eased[i] ? BAND_UP_TAU : BAND_DOWN_TAU);
  }
  return eased;
}

/** The beat envelope's state: its value, the target it eases toward, and the glitch slice seed. */
export interface CyberBeatState {
  be: number;
  tgt: number;
  seed: number;
}

/** A beat envelope at rest. */
export function createCyberBeat(): CyberBeatState {
  return { be: 0, tgt: 0, seed: 1 };
}

/**
 * Steps the eased beat envelope, 0 to about 1.3, and returns it: it rises over 70 ms on a beat, falls over
 * 0.5 s, and is held at zero when the gain is 0. It drives positions and sizes only. The seed picks the glitch
 * slices and changes only while the envelope is low, so a slice never jumps.
 */
export function cyberBeat(st: CyberBeatState, sig: VisualSignal, gain: number, dt: number, rng: () => number): number {
  st.tgt *= Math.exp(-dt / BEAT_TARGET_TAU);
  if (gain > 0 && sig.beat > 0) {
    if (st.be < 0.2) st.seed = 1 + rng() * 50;
    st.tgt = Math.max(st.tgt, Math.min(1, 0.45 + sig.beat * 0.6) * Math.min(1.3, gain));
  }
  if (gain === 0) st.tgt = 0;
  st.be = easeEnvelope(st.be, st.tgt, dt, st.tgt > st.be ? BEAT_UP_TAU : BEAT_DOWN_TAU);
  return st.be;
}

/** The mean of bands lo..hi-1. */
export function cyberBandMean(bands: ArrayLike<number>, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += bands[i];
  return s / (hi - lo);
}
