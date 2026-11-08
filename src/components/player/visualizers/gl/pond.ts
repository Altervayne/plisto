/*
 * Pond: the cover under still, clear water. Slow rain rings expand from random points on two cell grids and
 * bend the view of the cover, and a slow caustic net drifts across it. Each beat adds one ring at a new
 * spot on a golden-ratio walk, and the eased swell and the bass envelope deepen the refraction. The rings
 * are an analytic sum of damped waves, so the slope costs nothing extra. Light is bright clear water; dark
 * is deep tinted water that darkens toward the edges.
 *
 * Photosensitivity: brightness follows only the eased level (uRms). Beats and the motion envelopes bend the
 * view and move the rings; none of them adds light to the stage.
 */

// -- Local Imports --
import { createCoverTexture } from "./coverTexture";
import { FLUID_PRELUDE, RING_SLOTS, createRings, setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// How long a beat ring lives and how fast it fades in, in seconds, and its height per unit of beat.
const BEAT_LIFE = 5.2;
const BEAT_RISE = 0.3;
const BEAT_HEIGHT = 0.9;

const FS = `${FLUID_PRELUDE}
// Per beat ring: its spot on the stage as a share of width and height.
uniform vec2 uSpot[${RING_SLOTS}];
uniform float uRefr;
// -- Tunables --
const float CELL_A = 230.0;        // rain grid cell, CSS px
const float CELL_B = 150.0;
const float SPEED_A = 36.0;        // ring speed, px per flow second
const float SPEED_B = 28.0;
const float K_A = 0.19;            // ring wave number, rad per px
const float K_B = 0.30;
const float WIDTH_A = 30.0;        // ring envelope width, px
const float WIDTH_B = 18.0;
const float AMP_A = 1.0;
const float AMP_B = 0.55;
const float RAIN_SHARE = 0.72;     // share of cells that rain in a cycle
const float PERIOD = 7.0;          // seconds between drops in a cell, shortest
const float PERIOD_SPAN = 8.0;
const float BEAT_SPEED = 54.0;
const float BEAT_K = 0.17;
const float BEAT_WIDTH = 34.0;
const float BUMP = 0.016;          // view shift per unit of slope
const float CAUSTIC_LIGHT = 0.15;
const float CAUSTIC_DARK = 0.14;
// Returns the wave height in x and its slope in yz, for a ring of radius R.
vec3 ringWave(float d, vec2 dv, float R, float k, float w, float a) {
  float x = (d - R) / w;
  float env = exp(-x * x);
  float s = sin(k * (d - R));
  float dh = k * cos(k * (d - R)) * env - s * env * 2.0 * x / w;
  return a * vec3(s * env, dh * dv / max(d, 1.0));
}
vec3 rain(vec2 p, float cs, float seed, float speed, float k, float w, float amp) {
  vec2 base = floor(p / cs);
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = base + vec2(float(i), float(j));
      float r1 = hash21(id + seed), r2 = hash21(id + seed + 9.1);
      float period = PERIOD + PERIOD_SPAN * r1;
      float t = uFlow / period + r2;
      float cyc = floor(t), age = fract(t) * period;
      vec2 q = id + seed + cyc * 2.37;
      vec2 c = (id + 0.15 + 0.7 * vec2(hash21(q + 3.3), hash21(q + 8.8))) * cs;
      float on = step(hash21(q + 14.1), RAIN_SHARE);
      vec2 dv = p - c;
      float R = age * speed;
      float fade = (1.0 - smoothstep(0.5 * cs, 0.95 * cs, R)) * smoothstep(0.0, 0.5, age);
      acc += ringWave(length(dv), dv, R, k, w, amp * on * fade);
    }
  }
  return acc;
}
// A slow net of bright lines, the light caught by the water's surface.
float caustic(vec2 p, vec2 slope) {
  vec2 q = p * 0.012 + slope * 0.6 + vec2(uFlow * 0.02, -uFlow * 0.015);
  vec2 w = vec2(fbm(q + vec2(0.0, uFlow * 0.03)), fbm(q + vec2(5.2, 1.3) - uFlow * 0.025)) - 0.5;
  float c1 = 1.0 - abs(fbm(q * 1.6 + w * 1.2) * 2.0 - 1.0);
  float c2 = 1.0 - abs(fbm(q * 2.3 + w * 1.6 + 7.1) * 2.0 - 1.0);
  return pow(c1, 5.0) * 0.8 + pow(c2, 6.0) * 0.6;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  vec2 sz = uRes / uDpr;
  float hu = hushAt(fc);
  vec3 w = rain(p, CELL_A, 1.0, SPEED_A, K_A, WIDTH_A, AMP_A) + rain(p, CELL_B, 5.0, SPEED_B, K_B, WIDTH_B, AMP_B);
  for (int i = 0; i < ${RING_SLOTS}; i++) {
    vec2 rg = uRings[i];
    if (rg.y <= 0.0) continue;
    vec2 dv = p - uSpot[i] * sz;
    w += ringWave(length(dv), dv, rg.x * BEAT_SPEED, BEAT_K, BEAT_WIDTH, rg.y);
  }
  vec2 slope = w.yz * (1.0 - 0.85 * hu);
  vec2 uv = stageUv(fc);
  vec2 off = slope * BUMP * uRefr;
  vec3 view = vec3(textureLod(uCoverTex, uv + off * 1.07, 1.8).r,
                   textureLod(uCoverTex, uv + off, 1.8).g,
                   textureLod(uCoverTex, uv + off * 0.93, 1.8).b);
  vec3 n = normalize(vec3(-slope * 0.9, 1.0));
  vec3 L = normalize(vec3(-0.4, 0.6, 0.7));
  float shade = dot(n, L) - L.z;
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
  float caus = caustic(p, slope) * (1.0 - 0.6 * hu);
  vec3 col;
  if (uLight > 0.5) {
    col = mix(vec3(0.985), view, 0.8) * vec3(0.965, 0.99, 1.0);
    col *= 1.0 + shade * 0.5;
    col = mix(col, vec3(1.0), caus * CAUSTIC_LIGHT);
    col += spec * 0.16;
    col = mix(col, uGround, hu * 0.3);
  } else {
    vec2 su = fc / uRes;
    float depth = mix(0.55, 1.0, smoothstep(1.1, 0.2, length((su - 0.5) * vec2(1.1, 1.0))));
    col = view * vec3(0.5, 0.78, 0.95) * (0.54 + 0.16 * uRms) * depth;
    col *= 1.0 + shade * 0.4;
    col += caus * vec3(0.5, 0.85, 1.0) * CAUSTIC_DARK * (0.55 + 0.55 * uRms);
    col += spec * vec3(0.8, 0.95, 1.0) * 0.2;
    col = mix(col, uGround, hu * 0.4);
  }
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** The stage spot of the nth beat ring as shares of width and height; golden steps never repeat a spot. */
export function beatSpot(n: number): [number, number] {
  return [0.1 + 0.8 * ((n * 0.618034) % 1), 0.12 + 0.76 * ((n * 0.754878) % 1)];
}

export function createPond(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const rings = createRings(BEAT_LIFE, BEAT_RISE, BEAT_HEIGHT);
  // Each live ring's spot and age, kept in step with the rings so slot i matches rings.packed slot i.
  const live: { spot: [number, number]; age: number }[] = [];
  const spots = new Float32Array(RING_SLOTS * 2);
  let flow = 0;
  let n = 0;

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
      const s = f.sig;
      flow += f.dt * (0.8 + s.level * 0.3 + s.midMotion * 0.4);
      for (const d of live) d.age += f.dt;
      while (live.length > 0 && live[0].age >= BEAT_LIFE) live.shift();
      if (s.beat > 0) {
        if (live.length === RING_SLOTS) live.shift();
        n++;
        live.push({ spot: beatSpot(n), age: 0 });
      }
      rings.step(f.dt, s.beat);
      spots.fill(0);
      live.forEach((d, i) => spots.set(d.spot, i * 2));
      const p = kit.program("pond", FS_VS, FS);
      setFluid(kit, p, f, flow, rings.packed, art.tex);
      kit.gl.uniform2fv(kit.uniform(p, "uSpot"), spots);
      kit.set1(p, "uRefr", 0.7 + Math.min(1, s.swell * 1.6) * 0.55 + s.bassMotion * 0.7);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
      rings.clear();
    },
  };
}
