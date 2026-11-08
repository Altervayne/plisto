/*
 * Fireflies: a summer evening at the edge of a meadow, the cover as the sky behind it. Dark is a dusk sky tinted
 * by the cover hue with one afterglow, a far ridge and a near hill, and soft yellow-green lights wandering at
 * three depths. Light is a golden-hour meadow with a low sun, hills, woods and back-lit grass, with dandelion
 * seeds and gold pollen drifting through the light.
 *
 * The mids set how fast the lights wander, the eased level (uRms) sets how bright they glow, and a beat lifts a
 * few of them a fraction of a cell (position only). A beat also starts a group swell: about a third of the
 * lights, in loose clusters, rise together to their normal peak, never above a single light's peak. The group
 * drifts slowly, so it never steps. Calm has no beats, so no swells.
 *
 * Photosensitivity: this is the one scene where a beat changes luminance, through the swell. WCAG 2.3.1 holds:
 * a swell starts only once the last has faded below 0.3, so there is at most one per 2.3 s (under 0.5 per
 * second against the limit of 3); each rises over 0.5 s, eased, so it is not a flash pair; and in the worst
 * case (every light at its blink floor, the group at full swell, the level at maximum) the share of the stage
 * changing by 0.1 relative luminance or more is under 2%, and under 5% in any 341 x 256 window, against the
 * 25% limit. Every other motion is position only, and every blink runs on a cycle of 3.6 s or longer.
 */

// -- Local Imports --
import { COZY_PRELUDE } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

// The swell rises linearly over this many seconds (eased in the output) and decays with this time constant.
const SWELL_RISE = 0.5;
const SWELL_TAU = 1.5;
// A new swell starts only once the last has decayed below this.
const SWELL_REARM = 0.3;

/** The state of the group swell. */
export interface SwellState {
  sync: number;
  rising: boolean;
  amp: number;
}

/** A group swell at rest. */
export function createSwellState(): SwellState {
  return { sync: 0, rising: false, amp: 0 };
}

/**
 * Advances the group swell by `dt` seconds. A beat starts a swell only when none is rising and the last has
 * decayed below SWELL_REARM; its peak scales with `drive`. Returns true on the frame a swell starts.
 */
export function stepSwell(st: SwellState, beat: number, drive: number, dt: number): boolean {
  let started = false;
  if (beat > 0 && !st.rising && st.sync < SWELL_REARM) {
    st.rising = true;
    st.amp = Math.min(1, 0.55 + 0.3 * drive);
    started = true;
  }
  if (st.rising) {
    st.sync = Math.min(1, st.sync + dt / SWELL_RISE);
    if (st.sync >= 1) st.rising = false;
  } else {
    st.sync *= Math.exp(-dt / SWELL_TAU);
  }
  return started;
}

/** The swell as the shader reads it: smoothstep-eased and scaled by the swell's peak. */
export function swellLevel(st: SwellState): number {
  return st.sync * st.sync * (3 - 2 * st.sync) * st.amp;
}

/** The eased motion of the lights. */
export interface FlyState {
  wander: number;
  lift: number;
  seed: number;
  swell: SwellState;
}

/** Lights at rest. */
export function createFlyState(): FlyState {
  return { wander: 0, lift: 0, seed: 0, swell: createSwellState() };
}

/** Advances the lights by `dt` seconds. */
export function stepFlies(st: FlyState, s: VisualSignal, dt: number): void {
  st.wander += dt * (0.45 + 1.5 * s.midMotion + 0.3 * s.level);
  st.lift = Math.min(1, st.lift + s.beat * 0.5);
  st.lift *= Math.exp(-dt / 0.9);
  stepSwell(st.swell, s.beat, s.drive, dt);
  st.seed += dt * 0.12;
}

/** Test hook: pins every light at its blink floor, so the lab can measure the swell's worst case. */
export const fireflyProbe = { floor: false };

const FS = `${COZY_PRELUDE}
uniform float uWander;
uniform float uLift;
uniform float uPin;               // 1 pins every light at its blink floor, for the flash check
uniform float uSync;               // the group swell, 0..1, eased in over 0.5 s and out over about 1.5 s
uniform float uSyncSeed;           // drifts slowly, so the group changes gradually, never in a step
// -- Tunables --
const float CELL_FAR = 150.0;      // grid cells, CSS px
const float CELL_MID = 108.0;
const float CELL_NEAR = 78.0;
const float RAD_FAR = 1.5;         // core radius, CSS px
const float RAD_MID = 2.3;
const float RAD_NEAR = 3.4;
const float PRESENT = 0.50;        // share of cells holding a light
const float ORBIT = 0.32;          // wander radius, in cells
const float BLINK_FLOOR = 0.30;    // dimmest a light gets
const float BLINK_PERIOD = 3.6;    // seconds, shortest blink cycle
const float BLINK_SPAN = 4.4;      // plus up to this much
const float LIFT_SHARE = 0.35;     // share of lights a beat lifts
const float LIFT_CELLS = 0.30;
const float SYNC_CUT = 0.57;       // noise cut for the swelling group: about a third of the fireflies, in loose clusters
const float SEED_MID = 4.5;        // dandelion seed radius, CSS px
const float SEED_NEAR = 7.5;
const float SEED_SPOKES = 7.0;
const vec3 FLY_A = vec3(0.80, 1.0, 0.38);
const vec3 FLY_B = vec3(1.0, 0.82, 0.40);
const vec3 POLLEN = vec3(1.0, 0.84, 0.42);
// How brightly the lights glow: the eased level.
float glowLevel() { return clamp(uRms * 1.5, 0.0, 1.0); }
// Where one cell's point sits now: its seeded rest spot plus a slow wander, lifted by a beat for a few.
bool cellPoint(vec2 id, float seed, out vec3 r, out vec2 c) {
  r = vec3(hash21(id + seed), hash21(id + seed + 11.3), hash21(id + seed + 23.7));
  if (hash21(id + seed + 37.1) > PRESENT) return false;
  float t = uWander * (0.35 + 0.5 * r.z) + r.x * 40.0;
  c = id + 0.2 + 0.6 * r.xy + ORBIT * vec2(sin(t), cos(t * 0.77 + 1.7));
  c.y += uLift * LIFT_CELLS * step(hash21(id + seed + 51.9), LIFT_SHARE);
  return true;
}
vec3 flyLayer(vec2 p, float cs, float seed, float rad, vec2 wind, float depth) {
  vec2 g = p / cs + wind;
  vec2 base = floor(g);
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 r; vec2 c;
      vec2 cid = base + vec2(float(i), float(j));
      if (!cellPoint(cid, seed, r, c)) continue;
      float d = length(g - c) * cs;
      if (d > rad * 30.0) continue;
      float b = 0.5 + 0.5 * sin(uTime * 6.2831 / (BLINK_PERIOD + BLINK_SPAN * r.y) + r.x * 60.0);
      b = mix(BLINK_FLOOR, 1.0, b * b * (3.0 - 2.0 * b));
      if (uPin > 0.5) b = BLINK_FLOOR;
      // Synchronous fireflies: the current group rises to full together, never above a single light's peak.
      b = mix(b, 1.0, uSync * smoothstep(SYNC_CUT - 0.05, SYNC_CUT + 0.05, vnoise(cid * 0.37 + vec2(seed * 3.1, uSyncSeed))));
      float core = exp(-pow(d / rad, 2.0));
      float halo = 0.30 * exp(-pow(d / (rad * 4.5), 2.0)) + 0.10 * exp(-pow(d / (rad * 11.0), 2.0));
      acc += mix(FLY_A, FLY_B, r.z * r.z) * (core * 1.4 + halo) * b * depth;
    }
  }
  return acc;
}
// A dandelion seed: a fan of fibres above a short stalk, turned a little by its own slow spin.
float seedShape(vec2 dv, float rad, float ang) {
  float cs = cos(ang), sn = sin(ang);
  vec2 q = vec2(cs * dv.x + sn * dv.y, -sn * dv.x + cs * dv.y);
  float rr = length(q);
  float a = atan(q.y, q.x);
  float up = smoothstep(-0.35, 0.45, q.y / max(rr, 0.01));
  float fibres = pow(abs(cos(a * SEED_SPOKES)), 16.0) * up * (1.0 - smoothstep(rad * 1.0, rad * 3.4, rr)) * smoothstep(rad * 0.3, rad * 0.9, rr);
  float core = exp(-pow(rr / (rad * 0.6), 2.0));
  float stalk = (1.0 - smoothstep(rad * 0.07, rad * 0.17, abs(q.x))) * step(-rad * 3.6, q.y) * step(q.y, 0.0) * 0.5;
  return clamp(fibres * 0.9 + core + stalk, 0.0, 1.0);
}
// Returns the seed body in x and its soft shadow, cast down and right, in y.
vec2 seedLayer(vec2 p, float cs, float seed, float rad, vec2 wind) {
  vec2 g = p / cs + wind;
  vec2 base = floor(g);
  vec2 acc = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 r; vec2 c;
      if (!cellPoint(base + vec2(float(i), float(j)), seed, r, c)) continue;
      vec2 dv = (g - c) * cs;
      if (length(dv) > rad * 5.0) continue;
      float spin = r.x * 6.28 + uWander * 0.18 * (r.y - 0.5);
      acc.x = max(acc.x, seedShape(dv, rad * (0.8 + 0.4 * r.z), spin));
      acc.y = max(acc.y, seedShape(dv + vec2(-rad * 0.5, rad * 0.7), rad * (0.8 + 0.4 * r.z), spin));
    }
  }
  return acc;
}
float pollenLayer(vec2 p, float cs, float seed, float rad, vec2 wind) {
  vec2 g = p / cs + wind;
  vec2 base = floor(g);
  float acc = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 r; vec2 c;
      if (!cellPoint(base + vec2(float(i), float(j)), seed, r, c)) continue;
      float d = length(g - c) * cs;
      acc += (exp(-pow(d / rad, 2.0)) + 0.25 * exp(-pow(d / (rad * 3.0), 2.0))) * (0.6 + 0.4 * r.z);
    }
  }
  return acc;
}
// -- Backdrop tunables (the scenery; the effects above are separate) --
const vec2 SUN_AT = vec2(0.80, 0.34);     // stage fractions
const float HILL_FAR_Y = 0.31;            // ridge heights, in stage heights
const float HILL_MID_Y = 0.245;
const float MEADOW_Y = 0.165;
const float TREE_CELL = 21.0;             // crown spacing in the woods, CSS px
const float TREE_R = 12.0;                // crown radius, CSS px
const float GRASS_FAR_W = 5.0;            // blade spacing, CSS px
const float GRASS_NEAR_W = 8.0;
const float GRASS_NEAR_H = 0.14;          // tallest near blade, in stage heights
const float STALK_W = 34.0;               // seed stalk spacing, CSS px
const float GRASS_SWAY = 0.12;            // tip lean in the wind, in blade heights
const float DUSK_HILL_Y = 0.20;           // dark mode far ridge
const float DUSK_GRASS_Y = 0.11;          // dark mode grass line
const vec3 DUSK_GRASS = vec3(0.006, 0.010, 0.016);
const vec3 HAZE = vec3(0.93, 0.80, 0.66); // the warm air near the horizon
const vec2 QUIET_X = vec2(0.20, 0.74);    // stage band kept low and light behind the seek row and controls
const vec2 AFTERGLOW = vec2(0.78, 0.12);  // where the dusk light sits, stage fractions
float midRidge(float x) { return HILL_MID_Y + 0.05 * sin(x * 4.6 + 2.2) + 0.035 * vnoise(vec2(x * 5.0, 4.0)); }
float duskRidge(float x) { return DUSK_HILL_Y + 0.06 * sin(x * 2.7 + 4.0) + 0.05 * vnoise(vec2(x * 5.0, 9.0)); }
// 1 across the middle of the stage, where the seek row and the controls sit, 0 toward the side edges.
float quietAt(float x) { float u = x / (uRes.x / uDpr); return 1.0 - smoothstep(0.0, 0.10, max(QUIET_X.x - u, u - QUIET_X.y)); }
// The tree line on the dusk ridge: round crowns in patches, rooted below the ridge. Returns the canopy mask.
float duskTrees(vec2 p, vec2 sz) {
  float gy0 = duskRidge(p.x / sz.x) * sz.y;
  if (p.y < gy0 - 12.0 || p.y > gy0 + 26.0) return 0.0;
  float cell = floor(p.x / 11.0);
  float m = 0.0;
  for (int i = -1; i <= 1; i++) {
    float c = cell + float(i);
    if (vnoise(vec2(c * 0.09, 6.0)) < 0.42) continue;
    vec3 r = vec3(hash21(vec2(c, 1.3)), hash21(vec2(c, 2.9)), hash21(vec2(c, 4.4)));
    float xc = (c + 0.2 + 0.6 * r.x) * 11.0;
    float rc = 4.0 + 4.0 * r.y;
    vec2 cc = vec2(xc, duskRidge(xc / sz.x) * sz.y + rc * (0.4 + 0.8 * r.z));
    m = max(m, 1.0 - smoothstep(-0.7, 0.7, length((p - cc) / vec2(1.0, 1.55)) - rc));
  }
  return m;
}
// The woods behind the mid hill: patches of overlapping round crowns and a few lone trees on trunks, all rooted
// below the crest so the hill hides their feet. Returns the distance to the canopy edge in x (CSS px, negative
// inside), how much the nearest crown faces the sun in y and the height within that crown (-1 to 1) in z.
vec3 woods(vec2 p, vec2 sz, vec2 sun) {
  vec3 best = vec3(1e3, 0.0, 0.0);
  if (p.y < (HILL_MID_Y - 0.065) * sz.y || p.y > (HILL_MID_Y + 0.09) * sz.y + 4.0 * TREE_R) return best;
  float cell = floor(p.x / TREE_CELL);
  for (int i = -1; i <= 1; i++) {
    float c = cell + float(i);
    float wood = vnoise(vec2(c * 0.13, 2.3));
    bool lone = wood < 0.36 && hash21(vec2(c, 3.9)) > 0.86;
    if (wood < 0.36 && !lone) continue;
    vec3 r = vec3(hash21(vec2(c, 7.1)), hash21(vec2(c, 5.5)), hash21(vec2(c, 9.3)));
    float xc = (c + 0.25 + 0.5 * r.x) * TREE_CELL;
    float gy = midRidge(xc / sz.x) * sz.y;
    float rc = TREE_R * (0.75 + 0.55 * r.y) * (lone ? 0.85 : 0.8 + 0.7 * smoothstep(0.36, 0.75, wood));
    vec2 cc = vec2(xc, gy + (lone ? 6.0 + 6.0 * r.z + rc : rc * (0.2 + 0.5 * r.z)));
    float d = length((p - cc) / vec2(1.0, 1.12)) - rc;
    d -= rc * 0.24 * (vnoise(p * 0.21 + c * 7.0) - 0.5);
    if (lone) d = min(d, max(abs(p.x - xc) - 1.2, max(gy - 8.0 - p.y, p.y - cc.y)));
    else {
      // A second, smaller crown behind and above, so the woods read as a mass and not a row.
      vec2 cb = cc + vec2((r.z - 0.5) * TREE_CELL, rc * 0.75);
      float db = length((p - cb) / vec2(1.0, 1.12)) - rc * 0.72 - rc * 0.18 * (vnoise(p * 0.21 + c * 3.0) - 0.5);
      if (db < d) { d = db; cc = cb; }
    }
    if (d < best.x) best = vec3(d, dot(normalize(p - cc + 1e-3), normalize(sun - cc)), clamp((p.y - cc.y) / rc, -1.0, 1.0));
  }
  return best;
}
// One row of grass: a blade per cell, curved toward its tip and tapered, with neighbours grouped into tufts by a
// shared height. Returns coverage in x, the height along the blade (0 root, 1 tip) in y, the closeness to its
// edge in z and a per-blade tone in w. windT sways the tips by up to amp blade heights; quiet (0 or 1) lowers
// and thins the blades across the middle band.
vec4 grassRow(vec2 p, float cw, float hLo, float hHi, float seed, float windT, float amp, float quiet) {
  vec4 g = vec4(0.0);
  if (p.y > hHi) return g;
  float cell = floor(p.x / cw);
  for (int i = -2; i <= 2; i++) {
    float c = cell + float(i);
    vec3 r = vec3(hash21(vec2(c, seed)), hash21(vec2(c, seed + 1.7)), hash21(vec2(c, seed + 3.9)));
    float qa = quiet * quietAt((c + 0.5) * cw);
    if (qa > 0.5 && r.y < 0.4) continue;
    float h = mix(hLo, hHi, r.x * (0.2 + 0.8 * vnoise(vec2(c * 0.23, seed)))) * (1.0 - 0.55 * qa);
    float t = p.y / h;
    if (t > 1.0) continue;
    float lean = ((r.z - 0.5) * 0.55 + amp * sin(windT * 0.5 + c * 0.21)) * (0.6 + 0.8 * r.x);
    float cx = (c + 0.2 + 0.6 * r.y) * cw + lean * h * t * t;
    float w = cw * (0.30 + 0.25 * r.y) * pow(max(1.0 - t, 0.0), 0.7);
    float d = abs(p.x - cx);
    float aa = 0.6 + 0.5 * t;
    float m = 1.0 - smoothstep(w - aa, w + aa, d);
    if (m > g.x) g = vec4(m, t, d / max(w, 0.6), r.z);
  }
  return g;
}
// Tall seed stalks above the near grass, toward the side edges only: a thin curved stem under a soft oat head.
// Returns stem in x, head in y.
vec2 stalks(vec2 p, float hLo, float hHi, float windT, float amp) {
  vec2 s = vec2(0.0);
  if (p.y > hHi) return s;
  float cell = floor(p.x / STALK_W);
  for (int i = -1; i <= 1; i++) {
    float c = cell + float(i);
    vec3 r = vec3(hash21(vec2(c, 21.0)), hash21(vec2(c, 22.7)), hash21(vec2(c, 24.1)));
    if (r.x > 0.55 || quietAt((c + 0.5) * STALK_W) > 0.3) continue;
    float h = mix(hLo, hHi, r.y);
    float t = p.y / h;
    float lean = (r.z - 0.5) * 0.20 + amp * sin(windT * 0.5 + c * 0.6);
    float cx = (c + 0.2 + 0.6 * r.z) * STALK_W + lean * h * t * t;
    s.x = max(s.x, (1.0 - smoothstep(0.35, 1.1, abs(p.x - cx))) * step(t, 0.87));
    s.y = max(s.y, 1.0 - smoothstep(0.5, 1.1, length(vec2(p.x - cx, p.y - h * 0.90) / vec2(2.0, h * 0.11))));
  }
  return s;
}
// The scenery behind the effects. Day: sky, low sun, hazy far hills, woods behind a sunlit hill, a golden
// meadow. Night: dusk sky and a far ridge.
vec3 backdrop(vec2 p, vec2 su, vec3 blur, float hu) {
  vec3 col;
  vec2 sz = uRes / uDpr;
  if (uLight > 0.5) {
    vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
    float sd = length((su - SUN_AT) * aspect);
    float sunX = exp(-pow((su.x - SUN_AT.x) * aspect.x / 0.40, 2.0));
    float hz = smoothstep(0.80, 0.22, su.y);
    col = mix(vec3(0.58, 0.77, 0.95), vec3(1.0, 0.80, 0.52), hz);
    // The cover tints the sky by hue only, so a bright spot in the cover cannot read as a second sun.
    vec3 hueT = clamp(blur / max(luma(blur), 0.06), 0.75, 1.3);
    col = mix(col, luma(col) * hueT * vec3(1.05, 1.0, 0.95), 0.25);
    col += vec3(1.0, 0.74, 0.40) * (0.50 * exp(-sd * sd * 10.0) + 0.22 * exp(-sd * sd * 1.6));
    float streak = smoothstep(0.52, 0.80, fbm(vec2(p.x * 0.004, p.y * 0.016))) * smoothstep(0.30, 0.65, su.y);
    col = mix(col, vec3(1.0, 0.86, 0.68), streak * 0.40);
    // Far hills: a smooth hazy ridge, close to the colour of the air, with patches of a fine, distant tree line.
    float h1 = HILL_FAR_Y + 0.05 * sin(su.x * 3.1 + 0.6) + 0.04 * fbm(vec2(su.x * 3.0, 1.0));
    vec3 farC = mix(vec3(0.74, 0.67, 0.66), HAZE, 0.40 + 0.40 * sunX);
    farC = mix(farC, HAZE * 1.04, 0.35 * smoothstep(h1 - 0.01, h1 - 0.07, su.y));
    float tl = smoothstep(0.45, 0.62, vnoise(vec2(p.x * 0.012, 5.0))) * (1.5 + 2.5 * vnoise(vec2(p.x * 0.55, 2.0)));
    col = mix(col, farC * vec3(0.93, 0.95, 0.92), 1.0 - smoothstep(-0.6, 0.6, p.y - h1 * sz.y - tl));
    col = mix(col, farC, smoothstep(h1 + 0.0015, h1 - 0.0015, su.y));
    // The woods, back-lit: hazed green bodies with a gold rim on the side toward the sun.
    vec3 wd = woods(p, sz, SUN_AT * sz);
    vec3 treeC = mix(vec3(0.19, 0.25, 0.13), HAZE, 0.26 + 0.14 * sunX) * (0.84 + 0.20 * wd.z) * (0.92 + 0.16 * vnoise(p * 0.3));
    treeC += vec3(1.0, 0.72, 0.34) * 0.50 * smoothstep(-3.5, -0.3, wd.x) * smoothstep(0.0, 0.8, wd.y) * (0.4 + 0.6 * sunX);
    col = mix(col, treeC, 1.0 - smoothstep(-0.7, 0.7, wd.x));
    // The mid hill in front of the woods, its crest catching the low sun.
    float h2 = midRidge(su.x);
    vec3 hill2 = mix(mix(vec3(0.48, 0.52, 0.27), vec3(0.76, 0.65, 0.34), 0.30 + 0.50 * sunX), HAZE, 0.16);
    hill2 *= 0.90 + 0.10 * smoothstep(h2 - 0.07, h2, su.y);
    hill2 += vec3(1.0, 0.76, 0.40) * 0.32 * exp(-pow((h2 - su.y) * sz.y / 2.2, 2.0)) * (0.4 + 0.6 * sunX);
    col = mix(col, hill2, smoothstep(h2 + 0.0025, h2 - 0.0025, su.y));
    // The meadow: rows of grass that tighten toward its far edge, darker toward the viewer.
    float h3 = MEADOW_Y + 0.035 * sin(su.x * 5.5 + 0.4) + 0.03 * fbm(vec2(su.x * 6.0, 8.0));
    float fy = clamp((h3 - su.y) / h3, 0.0, 1.0);
    float fr = pow(fy, 0.55);
    float rows = 0.65 * vnoise(vec2(p.x * 0.008, fr * 26.0)) + 0.35 * vnoise(vec2(p.x * 0.03, fr * 70.0));
    vec3 meadow = mix(vec3(0.60, 0.50, 0.19), vec3(0.96, 0.78, 0.36), 0.15 + 0.75 * rows);
    meadow = mix(meadow, HAZE, 0.28 * (1.0 - fy)) * (1.0 - 0.32 * fy);
    meadow = mix(meadow, vec3(1.0, 0.84, 0.48), 0.30 * exp(-sd * sd * 5.0) * (1.0 - fy));
    meadow += vec3(1.0, 0.78, 0.40) * 0.18 * exp(-pow((h3 - su.y) * sz.y / 2.0, 2.0)) * (0.4 + 0.6 * sunX);
    col = mix(col, meadow, smoothstep(h3 + 0.0025, h3 - 0.0025, su.y));
    col = mix(col, uGround, hu * 0.30);
  } else {
    // One light: the afterglow low on the right. The cover tints the dusk by hue, its bright spots flattened, so
    // nothing in the sky blooms without a source.
    vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
    float glowD = length((su - AFTERGLOW) * aspect * vec2(0.55, 1.0));
    float glow = exp(-glowD * glowD / 0.09);
    vec3 dusk = mix(vec3(0.020, 0.030, 0.070), vec3(0.075, 0.060, 0.105), smoothstep(0.7, 0.0, su.y));
    vec3 hueT = clamp(blur / max(luma(blur), 0.04), 0.5, 1.6);
    col = dusk + hueT * mix(luma(blur), 0.30, 0.92) * vec3(0.62, 0.72, 1.0) * (0.27 + 0.08 * glowLevel());
    col += vec3(0.20, 0.11, 0.10) * 0.24 * exp(-pow((su.y - 0.15) / 0.20, 2.0)) + vec3(0.30, 0.13, 0.11) * 0.30 * glow;
    // The far ridge with its tree line, a faint warm rim along the top on the afterglow side.
    float far = duskRidge(su.x);
    float ridgeM = max(smoothstep(far + 0.003, far - 0.003, su.y), duskTrees(p, sz));
    vec3 hillC = vec3(0.030, 0.028, 0.050) + vec3(0.05, 0.03, 0.04) * glow;
    col += vec3(0.45, 0.24, 0.20) * 0.22 * exp(-pow((su.y - far) * sz.y / 1.6, 2.0)) * (0.3 + glow);
    col = mix(col, hillC, ridgeM);
  }
  return col;
}
// The scenery in front of the effects: two rows of back-lit grass and tall seed stalks by day, the black grass
// line by night. windT sways the blades and is 0 when the scenery is shown alone.
vec3 foreground(vec3 col, vec2 p, vec2 su, float hu, float windT) {
  vec2 sz = uRes / uDpr;
  if (uLight > 0.5) {
    float sunX = 0.4 + 0.6 * exp(-pow((su.x - SUN_AT.x) * (uRes.x / uRes.y) / 0.45, 2.0));
    float keep = 1.0 - 0.35 * hu;
    float qz = quietAt(p.x);
    vec4 gf = grassRow(p, GRASS_FAR_W, 0.022 * sz.y, 0.065 * sz.y, 3.3, windT, GRASS_SWAY * 0.8, 0.0);
    vec3 farG = mix(vec3(0.36, 0.30, 0.10), vec3(0.88, 0.68, 0.30), gf.y) * (0.92 + 0.16 * gf.w);
    farG += vec3(1.0, 0.76, 0.38) * 0.30 * smoothstep(0.45, 1.0, gf.z) * gf.y * sunX;
    col = mix(col, farG, gf.x * keep);
    vec4 gn = grassRow(p, GRASS_NEAR_W, 0.04 * sz.y, GRASS_NEAR_H * sz.y, 4.3, windT, GRASS_SWAY, 1.0);
    vec3 nearG = mix(mix(vec3(0.15, 0.14, 0.05), vec3(0.42, 0.34, 0.13), qz), vec3(0.44, 0.35, 0.11), smoothstep(0.0, 0.7, gn.y));
    nearG = mix(nearG, vec3(0.80, 0.60, 0.24), smoothstep(0.55, 1.0, gn.y)) * (0.88 + 0.24 * gn.w);
    nearG += vec3(1.0, 0.74, 0.36) * (0.45 * smoothstep(0.5, 1.0, gn.z) * smoothstep(0.2, 0.9, gn.y) + 0.22 * pow(gn.y, 3.0)) * sunX;
    col = mix(col, nearG, gn.x * keep);
    vec2 st = stalks(p, 0.10 * sz.y, 0.17 * sz.y, windT, GRASS_SWAY);
    col = mix(col, vec3(0.50, 0.40, 0.16), st.x * (1.0 - 0.5 * hu));
    col = mix(col, vec3(0.90, 0.70, 0.36) * (0.85 + 0.30 * sunX), st.y * 0.85 * (1.0 - hu));
    col = mix(col, vec3(0.12, 0.11, 0.04), smoothstep(0.03 * sz.y, 0.0, p.y) * mix(0.8, 0.35, qz));
  } else {
    float ridge = (DUSK_GRASS_Y + 0.04 * sin(su.x * 4.2 + 1.3) + 0.03 * vnoise(vec2(su.x * 7.0, 3.0))) * sz.y;
    vec4 gd = grassRow(vec2(p.x, p.y - ridge + 3.0), 6.0, 0.012 * sz.y, 0.06 * sz.y, 5.1, windT, GRASS_SWAY * 0.5, 0.0);
    float m = max(gd.x, 1.0 - smoothstep(ridge - 4.0, ridge - 2.0, p.y));
    // The near hill is ground, not a void: a little lift toward its crest and blade tips caught by the afterglow.
    float glow = exp(-pow((su.x - AFTERGLOW.x) / 0.30, 2.0));
    vec3 ground = DUSK_GRASS + vec3(0.028, 0.024, 0.042) * smoothstep(ridge - 0.14 * sz.y, ridge, p.y);
    ground += vec3(0.30, 0.15, 0.12) * 0.22 * pow(clamp(gd.y, 0.0, 1.0), 3.0) * gd.x * (0.3 + glow);
    ground += vec3(0.30, 0.15, 0.12) * 0.12 * exp(-pow((p.y - ridge + 3.0) / 2.0, 2.0)) * (0.3 + glow);
    col = mix(col, ground, m * 0.96);
    col = mix(col, uGround, hu * 0.3);
  }
  return col;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  vec2 su = fc / uRes;
  float hu = hushAt(fc);
  float calm = 1.0 - 0.9 * hu;
  vec3 blur = textureLod(uCoverTex, stageUv(fc), 3.4).rgb;
  vec3 col = backdrop(p, su, blur, hu);
  // -- Effects: everything that moves --
  vec2 wFar = vec2(0.008, -0.010) * uWander;
  vec2 wMid = vec2(-0.012, -0.016) * uWander;
  vec2 wNear = vec2(0.018, -0.022) * uWander;
  if (uLight > 0.5) {
    float sd = length((su - SUN_AT) * vec2(uRes.x / uRes.y, 1.0));
    float pollen = pollenLayer(p, CELL_FAR, 3.1, RAD_FAR * 1.6, wFar);
    vec2 sm = seedLayer(p, CELL_MID, 8.4, SEED_MID, wMid);
    vec2 sn = seedLayer(p, CELL_NEAR, 15.9, SEED_NEAR, wNear);
    float white = max(sm.x, sn.x), shadow = max(sm.y, sn.y);
    float sunHit = exp(-sd * sd * 2.2);
    col += vec3(1.0, 0.80, 0.45) * pollen * (0.45 + 0.5 * sunHit) * calm;
    col *= 1.0 - 0.12 * shadow * (1.0 - white) * calm;
    col = mix(col, mix(vec3(1.0, 0.99, 0.95), vec3(1.0, 0.92, 0.78), sunHit), white * 0.96 * calm);
  } else {
    vec3 fl = flyLayer(p, CELL_FAR, 3.1, RAD_FAR, wFar, 0.55);
    fl += flyLayer(p, CELL_MID, 8.4, RAD_MID, wMid, 0.8);
    fl += flyLayer(p, CELL_NEAR, 15.9, RAD_NEAR, wNear, 1.0);
    col += (1.0 - exp(-fl * 1.5 * (0.7 + 0.5 * glowLevel()))) * calm;
  }
  col = foreground(col, p, su, hu, uWander);
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createFireflies(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const st = createFlyState();

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
      stepFlies(st, f.sig, f.dt);
      const p = kit.program("fireflies", FS_VS, FS);
      setFluid(kit, p, f, st.wander, null, art.tex);
      kit.set1(p, "uWander", st.wander);
      kit.set1(p, "uLift", st.lift);
      kit.set1(p, "uSync", swellLevel(st.swell));
      kit.set1(p, "uSyncSeed", st.seed);
      kit.set1(p, "uPin", fireflyProbe.floor ? 1 : 0);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
