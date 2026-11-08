/*
 * Train: a rainy train window. Rain drops run down and back across the pane in stick-slip lurches, each a
 * small lens onto the view; the outside slides past at its own depths. Dark is a city across a river at
 * night, light an overcast countryside. Telegraph poles pass close to the glass in both.
 *
 * The eased level and the bass envelope, smoothed over seconds, set the speed the train wants inside a range
 * the reactivity opens (Calm a steady cruise); the train follows with inertia, and a beat nudges it, eased.
 * The poles, the street lamps (dark) and the fence posts (light) pass in time with the beat through the beat
 * clock, their spacing stretched within TRAIN_LOCK's bounds so nothing jumps. Without beats, or under Calm,
 * they keep their resting spacing.
 *
 * Photosensitivity: brightness follows only the eased level (uRms). Speed, rain, spacing and the beat nudge
 * move and thicken things; none of them adds light.
 */

// -- Local Imports --
import { createBeatClock, stepBeatClock, type BeatClock } from "./beatClock";
import { COZY_PRELUDE, clamp01 } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// Scenery travel per unit of speed, in CSS pixels per second.
const TRAVEL_PX = 150;
// The speed range by reactivity gain: Calm cruises, Balanced swings moderately, Lively widely.
const CRUISE: [number, number] = [1, 1];
const BALANCED: [number, number] = [0.75, 1.3];
const LIVELY: [number, number] = [0.55, 1.7];
// A gain above this reads as Lively.
const LIVELY_DRIVE = 1.3;
// The slow measure of intensity the speed target follows, and its bounds.
const ENERGY_TAU = 4;
const ENERGY_FLOOR = 0.18;
const ENERGY_SPAN = 0.4;
// The speed spring: pull toward the target and damping on the velocity.
const SPEED_PULL = 0.5;
const SPEED_DAMP = 1.3;
const MIN_SPEED = 0.2;
// The beat nudge on the speed: its gain per unit of beat, its decay and the ease into the speed, in seconds.
const SURGE_KICK = 0.07;
const SURGE_DECAY = 1;
const SURGE_TAU = 0.5;
// The rain follows the same energy and the swell, eased.
const RAIN_TAU = 2.5;
// Spacing easing toward its locked target, in seconds.
const SPACING_TAU = 1.2;
// How hard the phase is pulled toward the beat clock while locked.
const PHASE_PULL = 0.6;
// A layer's spacing stays within this factor of its resting spacing, either way.
const MAX_STRETCH = 1.6;
const MAX_N = 32;

/** The beat lock for the passing scenery. Rates mirror the shader's parallax for each layer. */
export const TRAIN_LOCK = {
  POLE_SPACING: 880,
  LAMP_SPACING: 132,
  FENCE_SPACING: 64,
  POLE_RATE: 0.85 * 1.05,
  LAMP_RATE: 0.3 + 0.55 * 0.14,
  FENCE_RATE: 0.3 + 0.55 * (1 - 0.62),
};

/** One passing layer: its resting spacing, its eased spacing, its phase in objects passed and its beat divisor. */
export interface LockLayer {
  rest: number;
  spacing: number;
  phase: number;
  n: number;
}

/** The clock fields the lock reads. */
export type LockClock = Pick<BeatClock, "period" | "beatPos" | "lock">;

/** A layer resting at `rest` CSS pixels between objects. */
export function createLockLayer(rest: number): LockLayer {
  return { rest, spacing: rest, phase: 0, n: 0 };
}

/** The speed range the reactivity gain opens: a fixed cruise at Calm, wider the livelier. */
export function speedRange(drive: number): [number, number] {
  if (drive === 0) return CRUISE;
  return drive > LIVELY_DRIVE ? LIVELY : BALANCED;
}

/**
 * Advances one layer by `dt` seconds at `speedPx` CSS pixels per second and returns its phase and spacing.
 * The layer passes one object every N beats, N a power of two near its resting rhythm. Its spacing eases
 * toward the distance the scenery slides in N beats, scaled by the clock's lock, so it returns to the
 * resting spacing when the lock lets go and never leaves MAX_STRETCH of it.
 */
export function stepLockLayer(L: LockLayer, dt: number, speedPx: number, clock: LockClock): [number, number] {
  const beatPx = Math.max(1, speedPx * clock.period);
  if (L.n === 0) L.n = Math.max(1, 2 ** Math.round(Math.log2(Math.max(1, L.rest / beatPx))));
  const ratio = L.rest / (beatPx * L.n);
  if (ratio > MAX_STRETCH && L.n < MAX_N) L.n *= 2;
  else if (ratio < 1 / MAX_STRETCH && L.n > 1) L.n /= 2;
  const target = L.rest + (beatPx * L.n - L.rest) * clock.lock;
  L.spacing += (target - L.spacing) * (1 - Math.exp(-dt / SPACING_TAU));
  let err = L.phase - clock.beatPos / L.n;
  err -= Math.round(err);
  L.phase += dt * (speedPx / L.spacing - clock.lock * err * PHASE_PULL);
  return [L.phase % 4096, L.spacing];
}

const FS = `${COZY_PRELUDE}
uniform float uTravel;
uniform float uRain;
uniform vec2 uPoles;      // telegraph poles: phase (poles passed) and spacing, css px; beat-locked at Balanced and Lively
uniform vec2 uLamps;      // street lamps along the road: phase and spacing, css px; beat-locked the same way
uniform vec2 uFence;      // the light theme's farm fence along the line: phase and spacing, css px; beat-locked too
// -- Backdrop tunables (the scenery: sky, city, road, hills, trees, fields, poles, sill) --
const float HORIZON = 0.36;          // horizon height, share of the stage
const float PAR_FAR = 0.10;          // parallax of each depth layer, share of the travel
const float PAR_MID = 0.30;          // the city and the tree line; the ground slides faster toward the stage bottom
const float PAR_NEAR = 0.85;
const float POLE_SPACING = 880.0;    // css px, at rest; the step stretches it to lock the passing to the beat
const float LAMP_SPACING = 132.0;    // street lamps along the road, css px, at rest; beat-locked like the poles
const float SIGNAL_SPACING = 2600.0; // railway signals beside the track, css px
const float FARM_SPACING = 1500.0;   // farmhouses along the tree line, css px
const float FENCE_Y = 0.62;          // the farm fence along the line, share of the horizon height; its rate is set on the CPU side
const float CITY_LIGHT = 1.0;
// -- Effect tunables (the glass: running drops, beads, the milky film) --
const float ROW_A = 54.0;            // running-drop rows, css px
const float ROW_B = 36.0;
const vec2 RUN_DIR = vec2(-0.94, -0.342);   // back along the travel and down with gravity
const float LENS_PX = 30.0;          // how far a drop shifts the view it shows
const float BEAD_SHARE = 0.55;
const float HAZE_DARK = 0.10;        // milky film on the pane
const float HAZE_LIGHT = 0.20;

// ===== BACKDROP: the scenery, drawn by scene() and frame(). =====
vec3 coverTint(vec2 p, float lod) {
  return textureLod(uCoverTex, stageUv(p * uDpr) + vec2(uTravel * 0.00003, 0.0), lod).rgb;
}
// Ground-plane coordinates below the horizon: x along the track, y the depth (1 at the stage bottom, growing toward
// the horizon). The ground slides at PAR_NEAR at the bottom and slower with depth; lines across the track meet at a
// fixed vanishing point mid-window. Near the horizon the mist hides that the tree line moves at PAR_MID.
vec2 groundAt(vec2 p, vec2 sz, float hy) {
  float z = hy / max(hy - p.y, 0.5);
  return vec2((p.x - sz.x * 0.5) * z + uTravel * PAR_NEAR, z);
}
// The slide rate of a ground strip seen at height y: PAR_MID where it meets the city, PAR_NEAR at the bottom.
float groundRate(float y, float hy) { return PAR_MID + (PAR_NEAR - PAR_MID) * clamp((hy - y) / hy, 0.0, 1.0); }
// One row of buildings, one per cell with a gap between neighbours. The windows sit in a centred grid with a margin
// on every side, inside the walls. x coverage, y lit window, z dark window, w the building's hash.
// beacon: the red light on the antenna of the tallest ones.
vec4 blocks(vec2 q, float cellw, float seed, float baseY, float maxH, vec2 pitch, float share, float soft, out float beacon) {
  float c = floor(q.x / cellw);
  vec4 r = vec4(hash21(vec2(c, seed)), hash21(vec2(c, seed + 3.1)), hash21(vec2(c, seed + 6.7)), hash21(vec2(c, seed + 8.9)));
  float w = cellw * (0.58 + 0.34 * r.y);
  float lx = q.x - c * cellw - (cellw - w) * r.z;
  float h = maxH * (0.22 + 0.78 * r.x * r.x);
  float ly = q.y - baseY;
  float body = smoothstep(-soft, soft, min(lx, w - lx)) * smoothstep(-soft, soft, h - ly);
  float cx = abs(lx - w * 0.5);
  float topH = h + pitch.y * (1.0 + r.w);
  float top = step(0.5, r.w) * smoothstep(-soft, soft, w * (0.16 + 0.12 * r.y) - cx) * smoothstep(-soft, soft, topH - ly);
  float tall = step(0.86, r.x);
  float antH = (r.w > 0.5 ? topH : h) + maxH * 0.14;
  float ant = tall * smoothstep(0.9, 0.3, cx) * smoothstep(-soft, soft, antH - ly);
  vec2 bd = vec2(cx, ly - antH);
  beacon = tall * exp(-dot(bd, bd) / 4.0);
  vec2 win = pitch * vec2(0.48, 0.55);
  float n = max(floor((w - 1.6 * pitch.x - win.x) / pitch.x) + 1.0, 0.0);
  float gx = lx - (w - (n - 1.0) * pitch.x - win.x) * 0.5;
  float col = floor(gx / pitch.x), fx = gx - col * pitch.x;
  float gy = h - pitch.y * 0.9 - ly;
  float row = floor(gy / pitch.y), fy = gy - row * pitch.y;
  float wm = step(0.0, col) * step(col, n - 1.0) * step(0.0, row);
  wm *= smoothstep(0.0, 0.7, min(fx, win.x - fx)) * smoothstep(0.0, 0.7, min(fy, win.y - fy)) * body;
  float lit = step(hash21(vec2(c * 17.0 + col, row + seed * 31.0)), share * (0.35 + 1.3 * r.y) * (0.4 + hash21(vec2(c, row + seed))));
  return vec4(max(max(body, top), ant), wm * lit, wm * (1.0 - lit), r.y);
}
// Window light: mostly warm rooms, now and then a cool office floor, tinted a little by the cover.
vec3 windowLight(float tone) {
  vec3 warm = mix(vec3(1.0, 0.70, 0.38), uPal[0] * 1.2 + 0.15, 0.25);
  return tone > 0.84 ? vec3(0.62, 0.78, 1.0) : warm * (0.8 + 0.3 * tone);
}
// The embankment beside the track: the nearest ground, a soft rise streaked by the speed.
float embankment(vec2 p, float hy, out float xs, out float top) {
  xs = p.x + uTravel * PAR_NEAR;
  top = hy * 0.2 + 7.0 * vnoise(vec2(xs * 0.006, 4.0)) + 3.0 * vnoise(vec2(xs * 0.02, 1.0));
  return smoothstep(top + 2.0, top - 2.0, p.y);
}
vec3 sceneDark(vec2 p, vec2 sz) {
  float hy = sz.y * HORIZON;
  vec3 cv = coverTint(p, 4.5);
  float t = p.y / sz.y;
  vec3 sky = mix(vec3(0.012, 0.02, 0.045), cv * vec3(0.48, 0.52, 0.66), smoothstep(1.0, 0.25, t));
  float haze = exp(-pow((p.y - hy) / (0.2 * sz.y), 2.0));
  sky += uPal[0] * 0.34 * haze + uPal[2] * 0.08 * haze * haze;
  // A few faint stars, high up where the city glow fades. They are far enough not to move.
  vec2 sc = floor(p / 43.0);
  vec2 sr = vec2(hash21(sc + 3.3), hash21(sc + 8.1));
  float star = step(0.8, hash21(sc)) * smoothstep(1.4, 0.2, length(p - (sc + 0.2 + 0.6 * sr) * 43.0));
  sky += star * smoothstep(0.55, 0.9, t) * (0.1 + 0.22 * sr.x) * vec3(0.8, 0.86, 1.0);
  vec3 col = sky;
  // The city in three rows, back to front: hazy towers, the mid blocks, the low front blocks.
  float bF, bM, bN;
  vec4 far = blocks(vec2(p.x + uTravel * PAR_FAR, p.y), 30.0, 2.0, hy - 8.0, 0.2 * sz.y, vec2(4.0, 6.0), 0.18, 1.1, bF);
  col = mix(col, mix(sky, vec3(0.03, 0.045, 0.085) + uPal[1] * 0.03, 0.72), far.x);
  col += far.y * windowLight(far.w) * 0.3;
  vec4 mid = blocks(vec2(p.x + uTravel * PAR_MID * 0.8, p.y), 52.0, 7.0, hy - 8.0, 0.23 * sz.y, vec2(6.0, 8.5), 0.24, 0.8, bM);
  col = mix(col, vec3(0.02, 0.028, 0.05) + uPal[1] * 0.02 + uPal[0] * 0.03 * haze, mid.x);
  col += mid.y * windowLight(mid.w) * 0.6 + mid.z * sky * 0.12;
  vec4 front = blocks(vec2(p.x + uTravel * PAR_MID, p.y), 78.0, 13.0, hy - 8.0, 0.12 * sz.y, vec2(8.0, 11.0), 0.3, 0.7, bN);
  col = mix(col, vec3(0.012, 0.016, 0.03), front.x);
  col += front.y * windowLight(front.w) * 0.8 + front.z * sky * 0.1;
  float glow = CITY_LIGHT * (0.62 + 0.5 * uRms);
  col += (bF * 0.5 + bM) * vec3(1.0, 0.2, 0.14) * 0.9 * glow;
  // Haze glowing at the foot of the city.
  float landTop = hy - 4.0;
  vec3 baseGlow = uPal[0] * 0.3 + vec3(0.05, 0.045, 0.06);
  col = mix(col, baseGlow, 0.28 * exp(-max(p.y - landTop, 0.0) / 20.0) * step(landTop, p.y));
  // The far bank: a strip of land, then a riverside road with street lamps, a pool of light under each.
  vec3 land = vec3(0.012, 0.015, 0.026) + uPal[0] * 0.06;
  col = mix(col, land, smoothstep(landTop + 0.8, landTop - 0.8, p.y));
  float rFar = hy * 0.9, rNear = hy * 0.86, yw = rNear - 3.0;
  float road = smoothstep(rNear - 0.6, rNear + 0.6, p.y) * smoothstep(rFar + 0.6, rFar - 0.6, p.y);
  col = mix(col, vec3(0.03, 0.032, 0.042) + uPal[0] * 0.02, road);
  float rRate = groundRate(rNear, hy);
  float lxp = p.x + uTravel * rRate;
  float lq = (p.x - sz.x * 0.5) / uLamps.y + uLamps.x;
  float post = smoothstep(0.7, 0.2, abs(fract(lxp / 9.0) - 0.5) * 9.0) * step(rNear - 0.5, p.y) * step(p.y, rNear + 2.2);
  float rail = clamp(smoothstep(0.9, 0.2, abs(p.y - rNear - 2.2)) + post, 0.0, 1.0);
  col = mix(col, vec3(0.05, 0.05, 0.06) + uPal[0] * 0.04, rail * 0.8);
  float quay = smoothstep(rNear + 0.5, rNear - 0.5, p.y) * smoothstep(yw - 0.6, yw + 0.6, p.y);
  col = mix(col, vec3(0.018, 0.02, 0.03), quay);
  float dx = (lq - floor(lq + 0.5)) * uLamps.y;
  float poleTop = rNear + 0.15 * hy;
  float pole = smoothstep(1.0, 0.35, abs(dx)) * step(rNear - 1.0, p.y) * smoothstep(poleTop + 0.5, poleTop - 0.5, p.y);
  float arm = smoothstep(-0.5, 0.2, dx) * smoothstep(6.5, 5.5, dx) * smoothstep(1.0, 0.3, abs(p.y - poleTop));
  col = mix(col, vec3(0.012, 0.014, 0.022), max(pole, arm));
  vec2 hd = vec2(dx - 5.0, p.y - poleTop + 1.6);
  vec3 sodium = mix(vec3(1.0, 0.66, 0.32), uPal[0] * 1.3 + 0.1, 0.3);
  float bulb = smoothstep(2.0, 0.7, length(hd * vec2(0.75, 1.5)));
  float halo = exp(-dot(hd, hd) / 120.0);
  float pool = exp(-hd.x * hd.x / 420.0) * (road * 0.7 + 0.3 * exp(-pow((p.y - rNear) / 5.0, 2.0)));
  col += sodium * (bulb * 1.1 + halo * 0.4 + pool * 0.35) * glow;
  // The river: dark water holding the city glow near the far bank, the lamps and the lit windows broken into
  // ripples below them.
  float water = smoothstep(yw + 0.5, yw - 0.5, p.y);
  float fade = exp((p.y - yw) / 70.0);
  float rp = smoothstep(0.42, 0.78, vnoise(vec2(lxp * 0.06, p.y * 0.55)));
  vec3 wcol = vec3(0.008, 0.012, 0.026) + cv * 0.03 + uPal[0] * 0.1 * exp((p.y - yw) / 26.0);
  float bR;
  vec4 refl = blocks(vec2(p.x + uTravel * PAR_MID, 2.0 * yw - p.y), 78.0, 13.0, hy - 8.0, 0.12 * sz.y, vec2(8.0, 11.0), 0.3, 1.5, bR);
  wcol = mix(wcol, wcol * 0.6, refl.x * 0.5);
  wcol += refl.y * windowLight(refl.w) * 0.45 * (0.25 + 0.75 * rp) * fade;
  wcol += sodium * exp(-(dx - 5.0) * (dx - 5.0) / 14.0) * (0.15 + 0.85 * rp) * exp((p.y - yw) / 45.0) * 0.75 * glow;
  wcol += uPal[0] * 0.05 * rp * fade;
  col = mix(col, wcol, water);
  // The embankment beside the track, and now and then a railway signal on it, out of focus.
  float xs, eTop;
  float emb = embankment(p, hy, xs, eTop);
  vec3 embCol = vec3(0.006, 0.008, 0.014) + cv * 0.025 * vnoise(vec2(xs * 0.01, p.y * 0.35));
  embCol += (uPal[0] * 0.5 + 0.06) * 0.12 * smoothstep(5.0, 0.0, eTop - p.y);
  col = mix(col, embCol, emb);
  float sx = p.x - 130.0 + uTravel * PAR_NEAR * 0.92;
  float sid = floor(sx / SIGNAL_SPACING + 0.5);
  float sdx = sx - sid * SIGNAL_SPACING;
  float sTop = hy + 0.06 * sz.y;
  float mast = smoothstep(6.0, 2.0, abs(sdx)) * smoothstep(sTop + 2.0, sTop - 4.0, p.y);
  float head = 1.0 - smoothstep(-2.5, 2.5, sdRound(vec2(sdx, p.y - sTop - 18.0), vec2(11.0, 24.0), 9.0));
  col = mix(col, vec3(0.006, 0.008, 0.013), max(mast, head));
  float green = step(0.5, hash21(vec2(sid, 3.7)));
  vec2 ld = vec2(sdx, p.y - sTop - (green > 0.5 ? 8.0 : 28.0));
  vec3 aspect = green > 0.5 ? vec3(0.35, 1.0, 0.7) : vec3(1.0, 0.25, 0.18);
  col += aspect * (smoothstep(7.0, 3.0, length(ld)) * 0.9 + exp(-dot(ld, ld) / 380.0) * 0.26) * glow;
  return col;
}
// Field colours under an overcast sky: grass, young wheat, stubble, ploughed earth, a touch of the cover.
vec3 cropCol(float k) {
  vec3 c = k < 0.36 ? vec3(0.45, 0.53, 0.38) : k < 0.6 ? vec3(0.54, 0.57, 0.41) : k < 0.78 ? vec3(0.61, 0.58, 0.47) : vec3(0.49, 0.44, 0.38);
  return mix(c, mix(uPal[2], uPal[0], 0.3) * 0.7, 0.1);
}
vec3 sceneLight(vec2 p, vec2 sz) {
  float hy = sz.y * HORIZON;
  vec3 cv = coverTint(p, 6.0);
  float t = p.y / sz.y;
  // Overcast: brightest just above the horizon, heavier rain cloud overhead, the cover a faint cast.
  vec3 sky = mix(vec3(0.86, 0.88, 0.90), vec3(0.69, 0.73, 0.78), smoothstep(0.38, 1.0, t));
  sky = mix(sky, mix(vec3(luma(cv)), cv, 0.6) * 1.15 + 0.12, 0.2);
  float cl = fbm(vec2((p.x + uTravel * 0.03) * 0.0021, p.y * 0.0058 + 1.7));
  sky *= 0.93 + 0.12 * smoothstep(0.3, 0.7, cl) - 0.07 * smoothstep(0.55, 0.8, cl) * smoothstep(0.5, 0.9, t);
  vec3 col = sky;
  vec3 mist = mix(vec3(0.85, 0.87, 0.89), sky, 0.4);
  // Two ranges of far hills, paler with distance, mist settling at their feet.
  float x1 = p.x + uTravel * PAR_FAR * 0.5, x2 = p.x + uTravel * PAR_FAR;
  float h1 = hy + sz.y * (0.03 + 0.08 * vnoise(vec2(x1 * 0.0021, 1.3)) + 0.015 * vnoise(vec2(x1 * 0.0068, 2.1)));
  col = mix(col, mix(sky, vec3(0.50, 0.56, 0.63), 0.45), smoothstep(1.2, -1.2, p.y - h1));
  float h2 = hy + sz.y * (0.008 + 0.045 * vnoise(vec2(x2 * 0.0037, 5.3)) + 0.01 * vnoise(vec2(x2 * 0.012, 4.1)));
  vec3 hill2 = mix(mix(sky, vec3(0.38, 0.46, 0.46), 0.62), mist, 0.32 * (1.0 - clamp((p.y - hy) / max(h2 - hy, 1.0), 0.0, 1.0)));
  col = mix(col, hill2, smoothstep(1.0, -1.0, p.y - h2));
  // The tree line: overlapping crowns in groves with lumpy outlines, a poplar now and then, low woods and
  // hedges along their feet so no crown floats. Lit from above.
  float xm = p.x + uTravel * PAR_MID;
  float tb = hy + 1.0;
  float ts = clamp(sz.y / 720.0, 0.9, 1.4);
  float tree = 0.0, tshade = 0.0;
  float cid = floor(xm / (16.0 * ts));
  float lump = vnoise(vec2(xm, p.y) * 0.32) - 0.5;
  for (int i = -1; i <= 1; i++) {
    float id = cid + float(i);
    vec3 r = vec3(hash21(vec2(id, 4.4)), hash21(vec2(id, 7.2)), hash21(vec2(id, 1.9)));
    float grove = smoothstep(0.3, 0.65, vnoise(vec2(id * 0.07, 9.1)));
    float poplar = step(0.93, r.z) * step(0.3, grove);
    float rx = (8.0 + 7.0 * r.x) * ts * (0.45 + 0.55 * grove) * (1.0 - 0.5 * poplar);
    float ry = rx * (0.85 + 2.4 * poplar);
    vec2 c = vec2((id + 0.3 + 0.4 * r.y) * 16.0 * ts, tb + 4.0 * ts + ry * 0.55 + 9.0 * ts * grove * r.x);
    vec2 d = (vec2(xm, p.y) - c) / vec2(rx, ry);
    float m = smoothstep(1.0, 0.88, length(d) + lump * 0.22) * step(0.08, grove);
    tshade = m > tree ? 0.5 + 0.5 * d.y : tshade;
    tree = max(tree, m);
  }
  float wood = smoothstep(0.2, 0.6, vnoise(vec2(xm * 0.012, 9.1 + 0.0)));
  float hedgeTop = tb + (4.0 + 5.0 * wood) * ts + 2.0 * vnoise(vec2(xm * 0.09, 3.0)) + 1.5 * vnoise(vec2(xm * 0.25, 5.0));
  float hedge = smoothstep(0.8, -0.8, p.y - hedgeTop);
  tshade = hedge > tree ? 0.35 + 0.3 * clamp((p.y - tb) / 10.0, 0.0, 1.0) : tshade;
  vec3 treeCol = mix(vec3(0.20, 0.28, 0.23), cv * 0.3 + 0.05, 0.12) * (0.7 + 0.42 * tshade) * (0.92 + 0.16 * vnoise(vec2(xm, p.y) * 0.45));
  col = mix(col, mix(treeCol, mist, 0.24), max(tree, hedge));
  // A farmhouse and its barn now and then along the tree line, a lamp lit in one window.
  float fc = floor(xm / FARM_SPACING);
  float fr = hash21(vec2(fc, 2.7));
  float fx = xm - (fc + 0.25 + 0.5 * fr) * FARM_SPACING;
  if (fr < 0.8 && abs(fx + 20.0) < 70.0) {
    float fy = p.y - tb + 1.0;
    float wall = step(abs(fx), 16.0) * step(fy, 17.0);
    float roof = step(abs(fx), 19.0) * step(16.0, fy) * step(fy, 17.0 + 12.0 * (1.0 - abs(fx) / 19.0));
    float chim = step(abs(fx - 9.0), 1.6) * step(fy, 31.0);
    float bx = fx + 44.0;
    float barn = step(abs(bx), 19.0) * step(fy, 15.0);
    float broof = step(abs(bx), 21.0) * step(14.0, fy) * step(fy, 16.0 + 9.0 * (1.0 - abs(bx) / 21.0));
    vec3 house = col;
    house = mix(house, mix(vec3(0.50, 0.33, 0.28), mist, 0.25), barn);
    house = mix(house, mix(vec3(0.27, 0.29, 0.32), mist, 0.2), broof);
    house = mix(house, mix(vec3(0.80, 0.79, 0.76) * (0.92 + 0.08 * step(0.0, fx)), mist, 0.15), wall);
    house = mix(house, mix(vec3(0.30, 0.32, 0.35), mist, 0.15), max(roof, chim));
    float lit = step(abs(fx + 7.5), 2.5) * step(abs(fy - 9.0), 3.0);
    float dark = clamp(step(abs(fx - 7.5), 2.5) * step(abs(fy - 9.0), 3.0) + step(abs(fx), 2.0) * step(fy, 7.0), 0.0, 1.0);
    house = mix(house, vec3(0.32, 0.33, 0.36), dark);
    house = mix(house, vec3(1.0, 0.80, 0.5), lit);
    house += vec3(1.0, 0.7, 0.4) * 0.12 * exp(-((fx + 7.5) * (fx + 7.5) + (fy - 9.0) * (fy - 9.0)) / 30.0);
    col = mix(col, house, smoothstep(hy - 1.0, hy + 1.0, p.y));
  }
  // The fields: strips along the track, each parcel its own crop, hedges between the farther strips. Rows and
  // tractor tracks run away from the train and meet at the vanishing point; the nearest strip, behind the seek
  // row, is one calm meadow.
  vec2 g = groundAt(p, sz, hy);
  float sid = floor(g.y / 0.85);
  float pu = (g.x + 290.0) / 560.0;
  float pb = floor(pu + 0.5);
  float ka = hash21(vec2(pb - 1.0, sid)), kb = hash21(vec2(pb, sid));
  float edge = (pu - pb) * 560.0;
  float side = smoothstep(-30.0, 30.0, edge);
  float k = side > 0.5 ? kb : ka;
  vec3 crop = mix(cropCol(ka), cropCol(kb), side);
  float rc = g.x * (k < 0.78 ? 0.034 : 0.06);
  float rowFade = smoothstep(0.3, 0.08, fwidth(rc));
  crop *= 1.0 - (k < 0.78 ? 0.07 : 0.12) * smoothstep(0.55, 0.9, 0.5 + 0.5 * sin(rc * 6.2831)) * rowFade;
  crop *= 0.94 + 0.1 * vnoise(vec2(g.x * 0.004, g.y * 0.7));
  float aw = max(fwidth(edge), 0.001);
  float track = smoothstep(aw, -aw, abs(edge) - 5.0) * smoothstep(14.0, 4.0, aw) * step(0.4, hash21(vec2(pb, sid + 7.0)));
  crop = mix(crop, vec3(0.62, 0.59, 0.52), track * 0.7);
  float zn = max(sid, 1.0) * 0.85;
  float yb = hy - hy / zn;
  float hh = 0.07 * hy / zn * (0.55 + 0.45 * vnoise(vec2(g.x * 0.011, sid)) + 0.35 * vnoise(vec2(g.x * 0.03, sid + 0.5)));
  float hedgeRow = step(3.0, sid) * step(0.45, hash21(vec2(floor(g.x / 1100.0), sid + 3.0))) * smoothstep(0.9, -0.9, p.y - yb - hh);
  crop = mix(crop, vec3(0.25, 0.32, 0.26) * (0.8 + 0.3 * clamp((p.y - yb) / max(hh, 0.5), 0.0, 1.0)), hedgeRow);
  vec3 meadow = vec3(0.47, 0.54, 0.41) * (0.95 + 0.06 * vnoise(vec2(g.x * 0.003, 2.0)));
  crop = mix(crop, meadow, smoothstep(hy * 0.55, hy * 0.35, p.y));
  vec3 fieldFar = mix(vec3(0.42, 0.48, 0.42), mist, 0.3);
  crop = mix(crop, fieldFar, 1.0 - exp(-g.y * 0.08));
  col = mix(col, crop, smoothstep(hy + 0.5, hy - 0.5, p.y));
  // A post-and-rail farm fence running along the line across the near fields: its posts pass with the beat, the way
  // the street lamps do at night. Weathered grey wood, a little lost in the rain.
  float fy = hy * FENCE_Y;
  float fq = (p.x - sz.x * 0.5) / uFence.y + uFence.x;
  float fdx = (fq - floor(fq + 0.5)) * uFence.y;
  float fpost = smoothstep(1.9, 1.0, abs(fdx)) * smoothstep(fy - 1.0, fy, p.y) * smoothstep(fy + 17.0, fy + 16.0, p.y);
  float frail = (smoothstep(1.1, 0.4, abs(p.y - fy - 6.5)) + smoothstep(1.1, 0.4, abs(p.y - fy - 13.0))) * step(fy, p.y);
  col = mix(col, mix(vec3(0.26, 0.25, 0.23), mist, 0.12), clamp(max(fpost, frail * 0.85), 0.0, 1.0));
  // The embankment beside the track: wet grass rushing past.
  float xs, eTop;
  float emb = embankment(p, hy, xs, eTop);
  vec3 grass = vec3(0.41, 0.49, 0.37) * (0.9 + 0.12 * vnoise(vec2(xs * 0.006, 1.0)));
  col = mix(col, grass, emb);
  float mistBand = exp(-pow((p.y - hy) / (0.1 * sz.y), 2.0));
  return mix(col, mist, 0.16 * mistBand);
}
// Telegraph poles passing close to the glass, soft and fast: cross arms, and the wires sagging between them. Their
// phase and spacing come from the step, which locks their passing to the beat.
float poles(vec2 p, vec2 sz) {
  float u = fract((p.x - sz.x * 0.5) / uPoles.y + uPoles.x);
  float dx = min(u, 1.0 - u) * uPoles.y;
  float top = sz.y * 0.86;
  float pole = smoothstep(10.0, 4.0, dx) * smoothstep(top + 3.0, top - 3.0, p.y);
  float arm = 0.0, w = 0.0;
  for (int k = 0; k < 3; k++) {
    float ya = top - 16.0 - float(k) * 19.0;
    float reach = k == 2 ? 16.0 : 30.0;
    arm = max(arm, smoothstep(reach, reach - 5.0, dx) * smoothstep(4.0, 1.5, abs(p.y - ya)));
    float yw = ya + 3.5 - 34.0 * 4.0 * u * (1.0 - u);
    w += smoothstep(1.7, 0.2, abs(p.y - yw));
  }
  return clamp(max(pole * 0.8, arm * 0.75) + w * 0.38, 0.0, 1.0);
}
vec3 scene(vec2 p, vec2 sz) {
  vec3 c = uLight > 0.5 ? sceneLight(p, sz) : sceneDark(p, sz);
  float po = poles(p, sz);
  return uLight > 0.5 ? mix(c, vec3(0.16, 0.18, 0.2), po * 0.55) : mix(c, vec3(0.004, 0.006, 0.012), po * 0.7);
}
// The sill and the cabin lamp ghost: window furniture drawn over the scenery and the drops.
vec3 frame(vec3 col, vec2 p, vec2 sz) {
  float sill = smoothstep(26.0, 24.0, p.y);
  vec3 sillCol = uLight > 0.5 ? vec3(0.80, 0.78, 0.74) * (0.9 + 0.1 * smoothstep(0.0, 24.0, p.y)) : vec3(0.035, 0.04, 0.05) + vec3(0.5, 0.32, 0.18) * 0.09 * smoothstep(20.0, 24.0, p.y);
  col = mix(col, sillCol, sill);
  float ghost = disc(p - sz * vec2(0.22, 0.8), 160.0, 0.9);
  return col + (uLight > 0.5 ? vec3(0.0) : vec3(1.0, 0.8, 0.5) * 0.035) * ghost;
}
vec3 backdrop(vec2 p, vec2 sz) { return frame(scene(p, sz), p, sz); }

// ===== EFFECTS: rain on the glass, layered over the backdrop. =====
// Running drops on the diagonal rows: x,y lens offset, z drop mask, w clear trail.
vec4 runners(vec2 p, float rowH, float seed, float sz) {
  vec2 nrm = vec2(-RUN_DIR.y, RUN_DIR.x);
  float u = dot(p, RUN_DIR), v = dot(p, nrm);
  float row = floor(v / rowH);
  float r1 = hash21(vec2(row, seed)), r2 = hash21(vec2(row, seed + 5.3)), r3 = hash21(vec2(row, seed + 2.1));
  float period = 7.0 + 8.0 * r1;
  float cyc = floor(uFlow / period + r2), ph = fract(uFlow / period + r2);
  float rc = hash21(vec2(row + cyc * 7.0, seed + 1.7));
  float present = step(rc, 0.34 + 0.5 * uRain);
  float k = 6.0 + floor(r3 * 5.0);
  float prog = ph - sin(ph * 6.2831 * k) / (6.2831 * k) * 0.9;
  float span = uRes.x / uDpr * abs(RUN_DIR.x) + uRes.y / uDpr * abs(RUN_DIR.y) + 320.0;
  float uh = prog * span - span + 160.0;
  float wob = sin(u * 0.016 + r1 * 6.0) * 2.5;
  float vc = (row + 0.2 + 0.6 * hash21(vec2(row + cyc * 3.0, seed + 8.0))) * rowH + wob;
  float rad = (6.0 + 6.0 * r2) * sz;
  vec2 d = vec2((u - uh) / (rad * 1.5), (v - vc) / rad);
  float m = smoothstep(1.0, 0.8, length(d)) * present;
  vec4 res = vec4(d * m, m, 0.0);
  float behind = uh - u;
  if (behind > 0.0 && behind < 380.0 && present > 0.5) {
    res.w = smoothstep(rad * 0.95, rad * 0.25, abs(v - vc)) * smoothstep(380.0, 70.0, behind);
    res.xy = vec2(0.0, clamp((v - vc) / rad, -1.0, 1.0)) * 0.9;
    float cell = 22.0;
    float cu = (floor(behind / cell) + 0.5) * cell;
    float br = rad * 0.34 * smoothstep(380.0, 0.0, cu) * step(0.4, hash21(vec2(row + cyc * 5.0, floor(behind / cell) + seed)));
    vec2 bd = vec2((behind - cu) / max(br * 1.4, 0.01), (v - vc) / max(br, 0.01));
    float bm = smoothstep(1.0, 0.7, length(bd)) * step(0.5, br);
    if (bm > res.z) res = vec4(bd * bm, bm, res.w);
  }
  return res;
}
// Small beads clinging to the glass, each fading in and out on its own cycle.
vec3 beads(vec2 p) {
  float cell = 24.0;
  vec2 id = floor(p / cell);
  vec2 rnd = vec2(hash21(id), hash21(id + 7.7));
  vec2 c = (id + 0.25 + rnd * 0.5) * cell;
  float life = fract(uTime / (10.0 + 9.0 * rnd.x) + rnd.y);
  float rad = (1.5 + 2.8 * rnd.y) * smoothstep(0.0, 0.3, life) * smoothstep(1.0, 0.7, life) * step(1.0 - BEAD_SHARE * (0.5 + 0.7 * uRain), hash21(id + 3.3));
  vec2 d = (p - c) / max(rad, 0.01);
  d.x /= 1.25;
  float m = smoothstep(1.0, 0.7, length(d)) * step(0.4, rad);
  return vec3(d * m, m);
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, sz = uRes / uDpr;
  float hu = hushAt(fc);
  vec4 ra = runners(p, ROW_A, 1.0, 1.0), rb = runners(p, ROW_B, 7.0, 0.7);
  vec4 run = ra.z >= rb.z ? ra : rb;
  float trail = max(ra.w, rb.w);
  vec3 bd = beads(p);
  float mask = max(run.z, bd.z * 0.7) * (1.0 - 0.9 * hu);
  trail *= 1.0 - 0.9 * hu;
  vec2 lens = run.z > bd.z ? run.xy : bd.xy;
  vec2 tl = (ra.w >= rb.w ? ra.xy : rb.xy);
  vec3 col = scene(p, sz);
  vec3 haze = uLight > 0.5 ? vec3(0.9, 0.92, 0.94) : vec3(0.05, 0.06, 0.09) + uPal[1] * 0.04;
  col = mix(col, haze, (uLight > 0.5 ? HAZE_LIGHT : HAZE_DARK) * (1.0 - trail * 0.8));
  if (trail > 0.02 && mask < 0.05) col = mix(col, scene(p - tl * 14.0, sz) * (uLight > 0.5 ? 1.0 : 1.25), trail * 0.6);
  if (mask > 0.01) {
    vec3 inner = scene(p - lens * (run.z > bd.z ? LENS_PX : 12.0), sz);
    float rim = smoothstep(0.55, 1.0, length(lens)) * mask;
    float under = smoothstep(0.0, 0.9, -lens.y) * rim;
    float glint = smoothstep(0.5, 0.0, length(lens - vec2(-0.3, 0.45))) * mask;
    if (uLight > 0.5) col = mix(col, inner * 1.1 + 0.03, mask * 0.9) * (1.0 - rim * 0.3 - under * 0.3) + glint * 0.6;
    else col = mix(col, inner * 1.35 + 0.03 + uPal[1] * 0.03, mask * 0.9) * (1.0 - rim * 0.3) + glint * 0.16 + under * 0.05;
  }
  col = frame(col, p, sz);
  col = mix(col, uGround, hu * (uLight > 0.5 ? 0.45 : 0.5));
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createTrain(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const clock = createBeatClock();
  const poles = createLockLayer(TRAIN_LOCK.POLE_SPACING);
  const lamps = createLockLayer(TRAIN_LOCK.LAMP_SPACING);
  const fence = createLockLayer(TRAIN_LOCK.FENCE_SPACING);
  let flow = 0;
  let travel = 0;
  let speed = 1;
  let vel = 0;
  let energy = 0.3;
  let rain = 0.4;
  let surgeTarget = 0;
  let surge = 0;

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
      const ease = (tau: number) => 1 - Math.exp(-f.dt / tau);
      energy += (s.level + 0.35 * s.bassMotion - energy) * ease(ENERGY_TAU);
      const norm = clamp01((energy - ENERGY_FLOOR) / ENERGY_SPAN);
      const [lo, hi] = speedRange(s.drive);
      surgeTarget = (surgeTarget + s.beat * SURGE_KICK) * Math.exp(-f.dt / SURGE_DECAY);
      surge += (surgeTarget - surge) * ease(SURGE_TAU);
      vel += ((lo + (hi - lo) * norm - speed) * SPEED_PULL - vel * SPEED_DAMP) * f.dt;
      speed = Math.max(MIN_SPEED, speed + vel * f.dt);
      const v = speed + surge;
      rain += (clamp01(0.18 + 0.8 * norm + 0.2 * Math.min(1, s.swell * 1.6)) - rain) * ease(RAIN_TAU);
      flow += f.dt * v;
      travel += f.dt * v * TRAVEL_PX;
      stepBeatClock(clock, f.dt, s.beat, s.drive);
      const px = v * TRAVEL_PX;
      const [polePhase, poleGap] = stepLockLayer(poles, f.dt, px * TRAIN_LOCK.POLE_RATE, clock);
      const [lampPhase, lampGap] = stepLockLayer(lamps, f.dt, px * TRAIN_LOCK.LAMP_RATE, clock);
      const [fencePhase, fenceGap] = stepLockLayer(fence, f.dt, px * TRAIN_LOCK.FENCE_RATE, clock);
      const p = kit.program("train", FS_VS, FS);
      setFluid(kit, p, f, flow, null, art.tex);
      kit.set1(p, "uTravel", travel);
      kit.set1(p, "uRain", rain);
      kit.set2(p, "uPoles", polePhase, poleGap);
      kit.set2(p, "uLamps", lampPhase, lampGap);
      kit.set2(p, "uFence", fencePhase, fenceGap);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
