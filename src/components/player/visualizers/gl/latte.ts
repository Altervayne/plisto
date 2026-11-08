/*
 * Latte, a cover scene: a cup and saucer seen from above on a table, the cover sitting in the heart of the
 * cup. The milk is microfoam with feathered edges bleeding into the espresso, tinted by the cover hue sampled
 * through the turning pattern. Dark is a lamp-lit walnut table, light a pale marble slab. Behind the text
 * zones the hush melts the pattern into one calm tone.
 *
 * The mids ease into the speed the art sways and turns at, the bass envelope breathes its scale, a beat raises
 * a target the angle glides toward, and a slow cycle winds the foam into a swirl and unwinds it. A beat while
 * the bass is up sends a ring across the surface that bends the art and shades its own slope. Every driver is
 * eased, so nothing steps.
 *
 * Photosensitivity: brightness follows only the eased level (uRms). The rings, the sway, the turn, the breath
 * and the swirl move the art and never add light; Calm keeps the slow turn and drops the rings.
 */

// -- Local Imports --
import { clamp01, COZY_PRELUDE } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { createRings, setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** The eased pose of the milk art. */
export interface LatteState {
  phase: number;
  cycle: number;
  nudgeT: number;
  nudge: number;
  breath: number;
  mid: number;
}

/** A fresh pose at rest. */
export function createLatteState(): LatteState {
  return { phase: 0, cycle: 0, nudgeT: 0, nudge: 0, breath: 0, mid: 0 };
}

/** The uniforms the pose drives. */
export interface LattePose {
  rot: number;
  breath: number;
  twist: number;
}

const ease = (prev: number, target: number, dt: number, tau: number) =>
  prev + (target - prev) * (1 - Math.exp(-dt / tau));

/**
 * Advances the pose by `dt` seconds and returns the uniforms. The mid envelope is eased before it sets any
 * speed, a beat raises a target the angle glides toward, and the swirl follows a smoothed cosine cycle.
 */
export function stepLatte(st: LatteState, s: VisualSignal, dt: number): LattePose {
  st.mid = ease(st.mid, s.midMotion, dt, 1.0);
  st.nudgeT = Math.min(0.12, st.nudgeT + s.beat * 0.04);
  st.nudgeT *= Math.exp(-dt / 1.4);
  st.nudge = ease(st.nudge, st.nudgeT, dt, 0.5);
  st.phase += dt * (0.12 + 0.5 * st.mid);
  st.breath = ease(st.breath, clamp01(s.bassMotion * 0.8 + s.swell * 0.5), dt, 0.7);
  st.cycle += dt * (0.07 + 0.08 * st.mid + 0.04 * s.level);
  const w = 0.5 - 0.5 * Math.cos(st.cycle);
  const twist = clamp01((w - 0.12) / 0.76);
  return {
    rot: 0.3 * Math.sin(st.phase) + 0.12 * Math.sin(st.phase * 0.43 + 1.0) + st.nudge,
    breath: st.breath,
    twist: twist * twist * (3 - 2 * twist),
  };
}

/** The strength of the ring a beat starts: only while the bass envelope is up, scaled by it. */
export function latteRingBeat(s: VisualSignal): number {
  return s.beat > 0 && s.bassMotion > 0.25 ? Math.min(1.5, s.beat * (0.4 + 0.7 * s.bassMotion)) : 0;
}

const FS = `${COZY_PRELUDE}
uniform float uRot;
uniform float uBreath;
uniform float uTwist;
// -- Backdrop tunables (the pose uniforms uRot, uBreath and uTwist move the art) --
const float CUP_SIZE = 0.44;       // coffee radius, in stage heights
const float TWIST_MAX = 3.4;       // winding at the centre, rad
const float PETALS = 9.0;
const float LEAVES = 5.5;
const float CHEVRON = 1.1;
const float BLEED = 0.045;         // how far the milk edge wanders into the coffee
const float BUBBLES = 0.55;        // strength of the fine bubble texture
const float TINT = 0.22;           // share of the cover hue in the milk
const float CALM = 0.92;           // how far the art melts to one tone behind the text
const float RIPPLE_SPEED = 190.0;  // bass ring speed out from the centre, CSS px per second
const float RIPPLE_W = 11.0;       // ring width, CSS px
const float RIPPLE_PX = 12.0;      // refraction of the art under a ring, CSS px per unit slope
const vec3 CREAM = vec3(0.96, 0.91, 0.82);
const vec3 ESPRESSO = vec3(0.19, 0.09, 0.045);
const vec3 CARAMEL = vec3(0.66, 0.40, 0.19);
const vec2 LIGHT_DIR = vec2(-0.6, 0.8);  // toward the window or lamp, top left
const vec2 HANDLE_DIR = vec2(0.82, -0.57); // the cup handle points to the lower right
const float PLANK_PX = 130.0;      // walnut board width at night, CSS px
const vec2 LAMP_AT = vec2(0.22, 1.10); // the night lamp's pool centre, above and left of the cup, stage fractions
const float SAUCER = 1.70;         // saucer radius, in cup radii
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
// The rosette: a ring of feathered petals around the heart, each a stack of chevrons with a stem. soft widens
// every edge. 1 is milk, 0 is coffee.
float foam(vec2 q, float soft) {
  float r = length(q);
  float a = atan(q.y, q.x);
  float t = abs(fract(a * PETALS / 6.28318 + 0.5) - 0.5) * 2.0;
  float body = smoothstep(0.38 - 0.08 * soft, 0.46 + 0.10 * soft, r) * smoothstep(0.90 + 0.04 * soft, 0.78 - 0.08 * soft, r);
  float edge = smoothstep(1.0 + 0.3 * soft, 0.62 - 0.1 * soft, t + 0.12 * sin(r * 13.0));
  float w = 1.0 + 3.0 * soft;
  float s = (r - 0.40) * LEAVES + t * CHEVRON;
  float line = 1.0 - smoothstep(0.02 * w, 0.10 * w, abs(fract(s + 0.5) - 0.5));
  float stem = 1.0 - smoothstep(0.015 * w, 0.06 * w, t);
  float haze = 0.22 * (1.0 - smoothstep(0.3, 0.9, r));
  return max(body * edge * (1.0 - 0.60 * max(line, stem * 0.8)), haze);
}
// The cup, saucer and table with the milk art in the given pose. At rest (all zero) it is the still scenery.
// One light from the top left (the window by day, the lamp at night): shadows fall to the lower right, the
// rims catch a highlight on the light side and the inside of the cup is lit on the far side.
vec3 backdrop(vec2 fc, vec2 p, vec2 sz, float hu, float rotA, float breath, float twistA, float drift) {
  vec2 cc = coverCenter() / uDpr;
  float R = sz.y * CUP_SIZE;
  vec2 q = (p - cc) / R;
  float r = length(q);
  float lit = dot(q / max(r, 1e-4), LIGHT_DIR);
  float px = 1.0 / R;
  vec3 table, ceramic;
  float expo;
  if (uLight > 0.5) {
    // Marble: a warm white slab with thin grey veins, a little brighter toward the window.
    vec2 mv = mat2(0.8, 0.6, -0.6, 0.8) * p * vec2(0.0028, 0.0065);
    float w = fbm(p * 0.003 + 7.0) - 0.5;
    float v1 = 1.0 - abs(fbm(mv + w * 1.6 + 2.0) * 2.0 - 1.0);
    float v2 = 1.0 - abs(fbm(mv * 2.3 + w * 0.8 + 9.0) * 2.0 - 1.0);
    table = vec3(0.93, 0.92, 0.90) - vec3(0.08, 0.08, 0.075) * pow(v1, 30.0) - vec3(0.03, 0.03, 0.026) * pow(v2, 20.0);
    table -= vec3(0.015, 0.014, 0.012) * smoothstep(0.75, 1.0, v1);
    table *= 0.96 + 0.05 * clamp(0.5 + 0.25 * dot(q, LIGHT_DIR), 0.0, 1.0);
    ceramic = vec3(0.98, 0.97, 0.95);
    expo = 1.0;
  } else {
    // Walnut planks: grain that flows along each board, fine growth lines, a tone per board, crisp seams with a
    // lit bevel on the edge toward the lamp, all in the lamp's pool, which falls off away from the top left.
    float plank = floor(p.y / PLANK_PX);
    float ph = hash21(vec2(plank, 3.0));
    float warp = fbm(vec2(p.x * 0.002, p.y * 0.02) + plank * 3.1);
    float grain = fbm(vec2(p.x * 0.006 + ph * 9.0, p.y * 0.09 + warp * 3.0));
    float lines = 0.5 + 0.5 * sin(p.y * 0.85 + warp * 40.0 + ph * 30.0 + grain * 6.0);
    table = mix(vec3(0.060, 0.035, 0.021), vec3(0.165, 0.100, 0.058), smoothstep(0.25, 0.75, grain)) * (0.85 + 0.30 * ph);
    table *= 0.80 + 0.20 * lines * lines;
    float fy = fract(p.y / PLANK_PX);
    table *= 1.0 - 0.80 * (1.0 - smoothstep(0.5, 1.3, min(fy, 1.0 - fy) * PLANK_PX));
    table += vec3(1.0, 0.7, 0.4) * 0.035 * exp(-pow(((1.0 - fy) * PLANK_PX - 2.2) / 1.0, 2.0));
    float fall = exp(-pow(length(p - LAMP_AT * sz) / (1.05 * sz.y), 2.0));
    table = table * (0.55 + 0.80 * fall) + vec3(1.0, 0.7, 0.4) * 0.035 * fall;
    ceramic = vec3(0.80, 0.74, 0.66);
    expo = 0.60 + 0.28 * clamp(uRms * 1.5, 0.0, 1.0);
  }
  vec3 col = table;
  // The saucer's shadow on the table, on the side away from the light: a wide soft one and a tight one where
  // it meets the table.
  float away = smoothstep(-0.3, 0.7, -lit);
  float rs = r * 1.62 / SAUCER;
  col *= 1.0 - 0.40 * away * (1.0 - smoothstep(1.50, 1.95, length(q * 1.62 / SAUCER - vec2(0.07, -0.10))));
  col *= 1.0 - 0.25 * (0.4 + 0.6 * away) * (1.0 - smoothstep(1.60, 1.70, length(q * 1.62 / SAUCER - vec2(0.02, -0.03))));
  // The saucer: a step where the cup stands, a flat ring and a raised rim with a highlight along its crest.
  float saucerM = 1.0 - smoothstep(SAUCER - px, SAUCER + px, r);
  float sl = 0.91 + 0.06 * lit;
  sl += 0.10 * smoothstep(1.38, 1.50, rs) * (1.0 - smoothstep(1.50, 1.56, rs)) * -lit;
  sl += 0.10 * smoothstep(1.53, 1.58, rs) * lit;
  sl += 0.22 * exp(-pow((rs - 1.555) / 0.012, 2.0)) * smoothstep(0.2, 0.9, lit);
  sl -= 0.07 * exp(-pow((r - 1.12) / 0.04, 2.0));
  col = mix(col, ceramic * sl * expo, saucerM);
  // The handle, seen from above as a rounded bar out of the wall, and its shadow with the cup's on the saucer.
  vec2 hv = vec2(HANDLE_DIR.x, HANDLE_DIR.y);
  vec2 hn = vec2(-hv.y, hv.x);
  vec2 qs = q - vec2(0.06, -0.08);
  float hand = sdRound(vec2(dot(q, hv) - 1.15, dot(q, hn)), vec2(0.17, 0.095), 0.09);
  float handSh = sdRound(vec2(dot(qs, hv) - 1.15, dot(qs, hn)), vec2(0.17, 0.095), 0.09);
  float cupSh = (1.0 - smoothstep(1.0, 1.22, length(qs))) + (1.0 - smoothstep(-0.02, 0.10, handSh)) * 0.8;
  col *= 1.0 - 0.28 * clamp(cupSh, 0.0, 1.0) * saucerM;
  float handM = 1.0 - smoothstep(-px, px, hand);
  float across = clamp(dot(q, hn) / 0.095, -1.0, 1.0);
  float hl = 0.88 + 0.12 * across * dot(hn, LIGHT_DIR) + 0.25 * exp(-pow((across * sign(dot(hn, LIGHT_DIR)) - 0.55) / 0.2, 2.0));
  col = mix(col, ceramic * hl * expo, handM);
  // The cup: a rounded lip, lit on its outer half toward the light and its inner half on the far side, then
  // the inside wall, in shade near the light and lit across from it.
  float lipT = clamp((r - 0.965) / 0.095, 0.0, 1.0);
  float lipL = 0.92 + 0.10 * (lipT * 2.0 - 1.0) * lit + 0.30 * exp(-pow((lipT - 0.62) / 0.13, 2.0)) * smoothstep(0.3, 0.95, lit);
  col = mix(col, ceramic * lipL * expo, 1.0 - smoothstep(1.06 - px, 1.06 + px, r));
  float wallL = 0.72 - 0.20 * lit + 0.10 * smoothstep(0.89, 0.965, r);
  col = mix(col, ceramic * wallL * expo, 1.0 - smoothstep(0.965 - px, 0.965 + px, r));
  // The milk. The art turns and breathes as one piece; a slow wind swirls it.
  float ang = twistA * TWIST_MAX * exp(-r * r * 1.8) + rotA;
  // Bass rings run out from the centre across the surface: each bends the art a few pixels and shades its own
  // slope toward and away from the light, so it moves the picture without adding light.
  float rd = r * R;
  float slope = (rings(rd + 2.0, RIPPLE_SPEED, RIPPLE_W) - rings(rd - 2.0, RIPPLE_SPEED, RIPPLE_W)) * (1.0 - 0.7 * hu);
  vec2 rn = q / max(r, 1e-4);
  q -= rn * slope * RIPPLE_PX / R;
  vec2 pw = rot(ang) * (q / (1.0 + 0.045 * breath));
  vec2 bleed = vec2(fbm(pw * 4.5 + vec2(drift, 0.0)), fbm(pw * 4.5 + vec2(9.1, 2.3))) - 0.5;
  vec2 pb = pw + bleed * (BLEED + 0.05 * twistA);
  float calm = hu * CALM;
  float f = mix(foam(pb, 0.55), 0.52, calm);
  float fw = mix(foam(pb * 0.98, 3.2), 0.52, calm);
  f *= 0.92 + 0.12 * fbm(pw * 6.0 + 4.0);
  vec3 cvr = textureLod(uCoverTex, 0.5 + pw * 0.5, 2.6).rgb;
  vec3 sat = mix(vec3(luma(cvr)), cvr, 1.4);
  vec3 hue = clamp(sat / max(luma(sat), 0.05), 0.0, 1.9);
  vec3 foamC = CREAM * mix(vec3(1.0), hue * 0.85, TINT);
  // Bubbles: fine pale specks and darker pits in the milk, gone behind the text.
  float bub = vnoise(p * 0.55) * 0.6 + vnoise(p * 1.3 + 7.0) * 0.4 - 0.5;
  float speck = smoothstep(0.78, 0.95, hash21(floor(p / 3.0))) * smoothstep(0.5, 0.2, length(fract(p / 3.0) - 0.5));
  foamC *= 1.0 + BUBBLES * 0.18 * bub * (1.0 - hu);
  foamC += 0.07 * BUBBLES * speck * (1.0 - hu);
  // Crema: dark espresso in the middle, caramel where the milk bleeds in and toward the rim.
  vec3 coffeeC = mix(ESPRESSO, CARAMEL, clamp(fw * 1.15, 0.0, 1.0) * 0.85);
  coffeeC = mix(coffeeC, CARAMEL * 0.85, smoothstep(0.50, 0.90, r) * 0.55);
  coffeeC = mix(coffeeC, coffeeC * (0.6 + 1.3 * sat), 0.35);
  vec3 liquid = mix(coffeeC, foamC, smoothstep(0.0, 1.0, f));
  float sheen = exp(-pow(length(q - vec2(-0.35, 0.42)) / 0.55, 2.0));
  liquid += vec3(1.0, 0.92, 0.78) * (0.05 + 0.10 * f) * sheen;
  liquid *= 1.0 - 0.22 * smoothstep(0.78, 0.89, r);
  liquid *= 1.0 + 0.35 * slope * dot(rn, LIGHT_DIR);
  col = mix(col, liquid * expo * (uLight > 0.5 ? 1.0 : 1.25), 1.0 - smoothstep(0.88, 0.90, r));
  col = mix(col, uGround, hu * (uLight > 0.5 ? 0.10 : 0.25));
  return col;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  vec2 sz = uRes / uDpr;
  float hu = hushAt(fc);
  vec3 col = backdrop(fc, p, sz, hu, uRot, uBreath, uTwist, uTime * 0.012);
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createLatte(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const st = createLatteState();
  const rings = createRings(2.2, 0.12, 1);

  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      if (!f.cover) return;
      art.sync(f.cover);
      const pose = stepLatte(st, f.sig, f.dt);
      rings.step(f.dt, latteRingBeat(f.sig));
      const p = kit.program("latte", FS_VS, FS);
      setFluid(kit, p, f, 0, rings.packed, art.tex);
      kit.set1(p, "uRot", pose.rot);
      kit.set1(p, "uBreath", pose.breath);
      kit.set1(p, "uTwist", pose.twist);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
