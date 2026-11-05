/*
 * The shared half of the fluid visualizers (Ink, Mercury, Glass, Silk). Each paints an opaque material
 * across the whole stage around a crisp cover: water, metal, glass or cloth. They share one uniform
 * prelude, the beat-ring stepping and the ambient settle toward the ground at the corners and under the
 * transport.
 *
 * Photosensitivity: brightness follows only the eased level (uRms). The motion envelopes and the beat
 * rings move, bend or stir the material; none of them adds light to the stage. Both arrive already scaled
 * by the reactivity gain, so under Calm only the slow drift remains.
 */

// -- Local Imports --
import { HUSH, PRELUDE } from "./shaders";

// -- Type Imports --
import type { Frame, Kit, Program } from "./kit";

// Beat rings alive at once.
export const RING_SLOTS = 3;

/** The uniforms and helpers every fluid pass starts from. Points are GL pixels unless named otherwise. */
export const FLUID_PRELUDE = `${PRELUDE}
${HUSH}
uniform float uSwell;
uniform float uBassM;
uniform float uMidM;
uniform float uHighM;
uniform float uFlow;
uniform float uLight;
uniform float uFloor;
uniform vec3 uGround;
uniform sampler2D uCoverTex;
// Per beat ring: its age in seconds and its faded height.
uniform vec2 uRings[${RING_SLOTS}];
// Three octaves, 0..1, each turned so the lattice never shows.
float fbm(vec2 p) {
  float s = vnoise(p) * 0.57;
  p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.7;
  s += vnoise(p) * 0.29;
  p = mat2(1.6, 1.2, -1.2, 1.6) * p + 1.3;
  return s + vnoise(p) * 0.14;
}
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// A stage point in cover widths from the cover's centre.
vec2 coverQ(vec2 fc) { return (fc - coverCenter()) / uCover.z; }
// The cover stretched across the stage, the way Liquid lays its backdrop.
vec2 stageUv(vec2 fc) { vec2 su = fc / uRes; return (su - 0.5) * vec2(uRes.x / uRes.y, 1.0) / 1.35 + 0.5; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// The beat rings at distance d in cover widths: a smooth bump per ring, travelling at speed.
float rings(float d, float speed, float width) {
  float h = 0.0;
  for (int i = 0; i < ${RING_SLOTS}; i++) {
    float x = (d - uRings[i].x * speed) / width;
    h += uRings[i].y * exp(-x * x);
  }
  return h;
}
// Ambient only: the stage settles toward the ground at its corners and under the transport.
vec3 settle(vec3 col, vec2 fc) {
  if (uAmbient < 0.5) return col;
  vec2 su = fc / uRes;
  float v = smoothstep(1.12, 0.3, length((su - 0.5) * vec2(1.05, 1.0)));
  float low = smoothstep(uFloor - 40.0 * uDpr, uFloor + 160.0 * uDpr, fc.y);
  return mix(uGround, col, (0.5 + 0.5 * v) * (0.55 + 0.45 * low));
}
`;

/** The live beat rings of one candidate, packed as age and faded height per slot. */
export interface Rings {
  packed: Float32Array;
  step: (dt: number, beat: number) => void;
  clear: () => void;
}

/**
 * Beat rings that live `life` seconds, fade in over `rise` and stand `height` per unit of beat strength.
 * A ring fades in, then falls to nothing at the end of its life, so neither end pops.
 */
export function createRings(life: number, rise: number, height: number): Rings {
  const live: { age: number; strength: number }[] = [];
  const packed = new Float32Array(RING_SLOTS * 2);
  return {
    packed,
    step(dt, beat) {
      for (const ring of live) ring.age += dt;
      while (live.length > 0 && live[0].age >= life) live.shift();
      if (beat > 0) {
        if (live.length === RING_SLOTS) live.shift();
        live.push({ age: 0, strength: Math.min(1.5, beat) });
      }
      packed.fill(0);
      live.forEach((ring, i) => {
        const fadeIn = Math.min(1, ring.age / rise);
        const fadeOut = (1 - ring.age / life) ** 2;
        packed[i * 2] = ring.age;
        packed[i * 2 + 1] = ring.strength * height * fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut;
      });
    },
    clear() {
      live.length = 0;
      packed.fill(0);
    },
  };
}

const NO_RINGS = new Float32Array(RING_SLOTS * 2);

/** Sets the uniforms every fluid pass reads, binding the cover to unit 0 when there is one. */
export function setFluid(
  kit: Kit,
  p: Program,
  f: Frame,
  flow: number,
  rings: Float32Array | null,
  coverTex: WebGLTexture | null,
): void {
  const { gl } = kit;
  const s = f.sig;
  kit.setCommon(p, f);
  kit.set1(p, "uSwell", Math.min(1, s.swell * 1.6));
  kit.set1(p, "uBassM", s.bassMotion);
  kit.set1(p, "uMidM", s.midMotion);
  kit.set1(p, "uHighM", s.highMotion);
  kit.set1(p, "uFlow", flow);
  kit.set1(p, "uLight", f.light ? 1 : 0);
  kit.set1(p, "uFloor", kit.geo.floor ?? 0);
  gl.uniform3f(kit.uniform(p, "uGround"), f.ground[0], f.ground[1], f.ground[2]);
  gl.uniform2fv(kit.uniform(p, "uRings"), rings ?? NO_RINGS);
  if (coverTex) kit.bindTex(p, "uCoverTex", 0, coverTex);
}
