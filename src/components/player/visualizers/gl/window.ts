/*
 * Window: a city at night, or by day, seen through a window with a deep sill and a houseplant. The cover is
 * the sky and its glow; three skyline layers stand in front of it (hazy far towers, mid blocks, near
 * buildings with neon signs on opaque boards), many tiny windows glow and fade, and traffic light trails run
 * along the street beyond a balcony parapet. Day is the same city with a faint glass sheen.
 *
 * The traffic follows an energy measure, the eased level plus the bass envelope eased again over about a
 * second: it sets the flow and the share of lane cells holding a car, and each car dims as they multiply so
 * the street's light stays with the level. A beat lights about 1% of the dark windows, four bursts alive at
 * most, each rising over 0.7 s and fading over about 6 s; a slot is reused only once its glow has faded, so
 * none is cut short. The neon halo breathes wider with the bass envelope at the same total light. The
 * traffic sits behind the frame, the sill and the plant.
 *
 * Photosensitivity: brightness follows only the eased level (uRms). Traffic, beat windows and the neon
 * breath move or redistribute light at the same total; the beat windows are small and slow, so they read as
 * lights coming on, not flashes.
 */

// -- Local Imports --
import { COZY_PRELUDE, clamp01, createRng } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// Beat window slots alive at once.
export const WINDOW_SLOTS = 4;
// A slot is free for a new beat once its glow is below this.
const SLOT_FREE = 0.04;
// A burst rises over this many seconds and then fades with this time constant.
const RISE = 0.7;
const FADE_TAU = 1.8;
// The seed range a burst picks its windows from.
const SEED_SPAN = 50;
// Energy follows level plus bass; the neon breath follows the bass; each eased over this many seconds.
const ENERGY_TAU = 1.2;
const NEON_TAU = 0.8;
// The sway of the view against the frame.
const SWAY_RATE = 0.1;
const RNG_SEED = 20;

/** One lit burst of windows: which windows (seed), its age, its glow now and its peak. */
export interface BeatWindow {
  seed: number;
  age: number;
  glow: number;
  amp: number;
}

const FS = `${COZY_PRELUDE}
uniform vec2 uSway;
uniform float uTraffic;            // traffic phase, advanced faster as the music's energy rises
uniform float uDensity;            // share of lane cells holding a car, eased from the same energy
uniform float uTwinkle;
uniform float uNeonB;              // the slow bass breath of the neon glow, 0..1
uniform vec2 uBeatWin[4];          // beat windows: a seed and an eased glow each
// -- Backdrop tunables (traffic and flicker are effects driven by uTraffic and uTwinkle) --
const vec2 LAMP = vec2(0.105, 0.60);  // the room lamp, off to the left, that warms the frame at night
const float BEAT_WIN_SHARE = 0.010;   // share of dark windows that answer one beat
const float FRAME_PX = 16.0;
const float SILL_PX = 46.0;
const float FAR_W = 34.0;             // skyline column widths, CSS px
const float MID_W = 58.0;
const float NEAR_W = 96.0;
const float WIN_LIT = 0.55;           // share of windows lit at night
const float VIEW_LOD = 4.2;           // mip level of the cover view
const float VIEW_TAP = 0.035;         // blur tap offset, in cover uv
const float PARALLAX = 0.12;          // how far the outside answers the sway
const vec3 LAMP_COL = vec3(1.0, 0.72, 0.40);
const float NEON_CAP = 0.85;          // brightest a neon slit gets, per channel
const float CALM_DIM = 0.62;          // how far the city dims behind the title and seek row at night
const float SILL_DEPTH = 18.0;        // visible depth of the sill top, CSS px
const float PLANT_X = 0.805;          // pot centre, in stage widths: clear of the transport controls
const float POT_H = 44.0;             // pot height, CSS px
const float POT_W = 25.0;             // pot half width at the rim
// The leaves, back to front: angle from upright (rad), length and half width (CSS px), droop (share of length).
const float LEAF_A[9] = float[9](-0.14, 0.24, -0.52, 0.59, -0.91, 0.98, -0.07, -1.26, 1.29);
const float LEAF_L[9] = float[9](118.0, 108.0, 100.0, 96.0, 88.0, 86.0, 80.0, 70.0, 66.0);
const float LEAF_W[9] = float[9](17.0, 16.0, 17.0, 17.0, 16.0, 16.0, 16.0, 14.0, 14.0);
const float LEAF_D[9] = float[9](0.10, 0.14, 0.22, 0.26, 0.32, 0.34, 0.18, 0.38, 0.40);
// The eased level as a 0..1 glow; the one value that sets how bright the city is.
float glow() { return clamp(uRms * 1.5, 0.0, 1.0); }
float soft(float sd, float s) { return 1.0 - smoothstep(-s, s, sd); }
// One skyline layer. Returns the body colour in rgb and its coverage in a; add gets neon and window glow. pulse
// (0 or 1) lets a few dark windows answer the beat windows; the neon halo breathes wider with uNeonB at the same
// total light.
vec4 skyline(vec2 p, float top0, float cw, float base, float vary, float seed, vec2 win, float lit, vec3 body, vec3 winCol, float neon, float yBase, float pulse, out vec3 add) {
  add = vec3(0.0);
  float cell = floor(p.x / cw);
  vec3 r = vec3(hash21(vec2(cell, seed)), hash21(vec2(cell, seed + 3.1)), hash21(vec2(cell, seed + 7.7)));
  float top = yBase + (base + vary * r.x * r.x) * top0;
  float lx = p.x - cell * cw;
  float inB = smoothstep(top + 1.0, top - 1.0, p.y) * step(yBase, p.y) * step(0.06 * cw, lx) * step(lx, cw * 0.94);
  // A neon sign on the facade: an opaque dark backing board held to the wall by a bracket above and below, a
  // tube along its edge and a column of short glyph strokes inside, all glowing in a cover colour.
  float board = 0.0;
  vec3 boardC = vec3(0.0);
  if (neon > 0.0 && r.y > 0.72) {
    vec2 sc = vec2((cell + 0.5) * cw, top - 40.0 - 30.0 * r.z);
    vec2 lp = p - sc;
    vec2 sd = lp / vec2(7.0, 26.0);
    vec3 nc = uPal[int(r.z * 2.99)];
    nc = min(mix(vec3(luma(nc)), nc, 1.5) * 0.95 + 0.08, vec3(NEON_CAP));
    float brk = soft(sdRound(vec2(lp.x, abs(lp.y) - 29.5), vec2(3.5, 2.5), 0.8), 0.6);
    board = max(soft(sdRound(lp, vec2(8.5, 27.5), 2.5), 0.7), brk);
    boardC = mix(vec3(0.016, 0.015, 0.022) + nc * 0.05 * neon, vec3(0.05, 0.05, 0.06), brk);
    float tube = 1.0 - smoothstep(0.5, 1.3, abs(sdRound(lp, vec2(6.0, 25.0), 2.0)));
    float gy = clamp(floor((lp.y + 20.0) / 8.0), 0.0, 4.0);
    float gc = gy * 8.0 - 16.0;
    float gh = hash21(vec2(cell * 3.1 + gy, seed));
    float hs = (1.0 - smoothstep(0.4, 1.1, abs(lp.y - gc - (gh - 0.5) * 3.0))) * step(abs(lp.x), 2.6);
    float vs = (1.0 - smoothstep(0.4, 1.1, abs(lp.x - (fract(gh * 7.0) > 0.5 ? 2.2 : -2.2)))) * step(abs(lp.y - gc), 2.8);
    float glyph = max(hs * step(0.25, gh), vs * step(0.45, fract(gh * 13.0))) * step(abs(lp.y), 21.0);
    float spread = 1.0 + 0.45 * uNeonB;
    add += nc * neon * (tube * 0.95 + glyph * 0.8 + 0.55 / (spread * spread) * exp(-dot(sd, sd) * 0.9 / (spread * spread))) * (0.7 + 0.3 * sin(uTwinkle / (5.0 + 4.0 * r.x) + r.z * 40.0));
  }
  if (inB <= 0.0) return vec4(0.0);
  vec2 wg = vec2(lx, p.y) / win;
  vec2 wid = floor(wg), wf = fract(wg);
  float inset = step(0.22, wf.x) * step(wf.x, 0.78) * step(0.2, wf.y) * step(wf.y, 0.72) * step(p.y, top - 4.0) * step(0.1 * cw, lx) * step(lx, cw * 0.9);
  float h = hash21(wid + cell * 13.7 + seed);
  float on = step(h, lit * (0.35 + 1.0 * r.y));
  float tw = 0.78 + 0.22 * sin(uTwinkle / (5.0 + 8.0 * hash21(wid + cell)) + h * 30.0);
  vec3 wc = mix(winCol, vec3(0.65, 0.85, 1.0) * length(winCol), step(0.84, hash21(wid + seed + 1.0)));
  vec3 col = body * (0.8 + 0.4 * r.z);
  col += wc * on * inset * tw;
  if (pulse > 0.0) {
    float bw = 0.0;
    for (int k = 0; k < 4; k++) bw = max(bw, uBeatWin[k].y * step(fract(h * 37.13 + uBeatWin[k].x), BEAT_WIN_SHARE));
    col += wc * inset * bw * (1.0 - on);
  }
  add += wc * on * inset * 0.05 * (1.0 - board);
  col = mix(col, boardC, board);
  return vec4(col, inB);
}
// A line of traffic: streaks moving along x at one lane height.
float lane(vec2 p, float y0, float dir, float speed, float cw, float seed, float th) {
  float x = p.x * dir - uTraffic * speed;
  float cell = floor(x / cw);
  vec3 r = vec3(hash21(vec2(cell, seed)), hash21(vec2(cell, seed + 4.4)), hash21(vec2(cell, seed + 8.8)));
  if (r.x > uDensity) return 0.0;
  float len = 50.0 + 100.0 * r.z;
  float d = x - (cell + 0.1 + 0.5 * r.y) * cw;
  float along = smoothstep(0.0, len, d) * (1.0 - smoothstep(len * 0.92, len, d));
  float head = exp(-pow((d - len) / 6.0, 2.0));
  return (along * 0.55 + head) * exp(-pow((p.y - y0) / th, 2.0));
}
// One arching leaf of the houseplant, blended into o over its stem and blade. q is relative to the pot base.
void leaf(inout vec4 o, vec2 q, int i, float night) {
  float a = LEAF_A[i], L = LEAF_L[i];
  vec2 dir = vec2(sin(a), cos(a));
  float side = a < 0.0 ? -1.0 : 1.0;
  vec2 d = q - vec2(0.0, POT_H - 2.0);
  float u = dot(d, dir) / L;
  if (u < 0.0 || u > 1.0) return;
  float drift = sin(uTwinkle * 0.1 + float(i)) * 1.5;
  float across = dot(d, side * vec2(cos(a), -sin(a))) - (LEAF_D[i] * L + drift) * u * u;
  float bu = (u - 0.30) / 0.70;
  float hw = bu > 0.0 ? LEAF_W[i] * pow(sin(3.14159 * pow(bu, 0.75)), 0.65) : 0.0;
  float blade = 1.0 - smoothstep(hw - 0.7, hw + 0.7, abs(across));
  float stem = (1.0 - smoothstep(0.6, 1.4, abs(across))) * step(u, 0.34);
  float m = max(blade, stem);
  if (m <= 0.0) return;
  float h = hash21(vec2(float(i), 4.2));
  float back = 0.70 + 0.30 * float(i) / 8.0;
  float fold = mix(1.0, 0.74, smoothstep(-0.8, 0.8, across));
  float rib = (1.0 - smoothstep(0.3, 1.0, abs(across))) * step(0.0, bu);
  float edge = smoothstep(hw * 0.55, hw, abs(across)) * blade;
  float gloss = exp(-pow((across + hw * 0.45) / (hw * 0.22 + 0.5), 2.0)) * exp(-pow((bu - 0.42) / 0.22, 2.0));
  vec3 day = mix(vec3(0.15, 0.36, 0.17), vec3(0.28, 0.52, 0.22), h) * fold * back;
  day += vec3(0.50, 0.68, 0.22) * 0.38 * edge + vec3(0.9, 1.0, 0.85) * 0.18 * gloss;
  day = mix(day, vec3(0.58, 0.76, 0.42), rib * 0.45);
  vec3 dark = vec3(0.022, 0.044, 0.030) * fold * back + vec3(0.16, 0.18, 0.32) * 0.85 * edge + LAMP_COL * 0.10 * gloss;
  dark = mix(dark, vec3(0.05, 0.07, 0.05), rib * 0.4);
  vec3 c = mix(day, dark, night);
  c = mix(c, mix(vec3(0.30, 0.42, 0.17), vec3(0.025, 0.035, 0.022), night), stem * (1.0 - blade));
  o = vec4(mix(o.rgb, c, m), max(o.a, m));
}
// The houseplant on the sill: nine glossy arching leaves on thin stems out of a terracotta pot with a rolled
// rim and soil. Day light comes through the window behind it, so the leaf edges glow; at night the lamp at the
// left lights the pot. Returns colour in rgb and coverage in a.
vec4 plant(vec2 p, vec2 sz, float night) {
  vec2 q = p - vec2(PLANT_X * sz.x, SILL_PX - 8.0 - SILL_DEPTH * 0.55);
  vec4 o = vec4(0.0);
  if (abs(q.x) > 125.0 || q.y < -2.0 || q.y > POT_H + 125.0) return o;
  for (int i = 0; i < 6; i++) leaf(o, q, i, night);
  // The pot: a tapered body, a rolled rim and the lit top of the rim around the soil.
  float t = clamp(q.y / (POT_H * 0.80), 0.0, 1.0);
  float hwB = mix(POT_W * 0.74, POT_W * 0.92, t);
  float body = (1.0 - smoothstep(hwB - 0.7, hwB + 0.7, abs(q.x))) * smoothstep(-0.5, 1.0, q.y) * step(q.y, POT_H * 0.82);
  float rimB = soft(sdRound(q - vec2(0.0, POT_H * 0.91), vec2(POT_W, POT_H * 0.09 + 0.5), 2.5), 0.8);
  float topE = 1.0 - smoothstep(0.92, 1.06, length((q - vec2(0.0, POT_H)) / vec2(POT_W, 5.0)));
  float soil = 1.0 - smoothstep(0.82, 0.96, length((q - vec2(0.0, POT_H + 0.4)) / vec2(POT_W - 3.5, 3.4)));
  float potM = max(max(body, rimB), topE);
  if (potM > 0.0) {
    float s = clamp(q.x / (rimB > 0.5 ? POT_W : hwB), -1.0, 1.0);
    float underRim = 1.0 - 0.22 * smoothstep(POT_H * 0.62, POT_H * 0.80, q.y) * (1.0 - rimB);
    float dayL = (0.74 + 0.18 * (1.0 - s * s) + 0.30 * pow(abs(s), 6.0)) * underRim;
    float nightL = (0.30 + 0.70 * max(0.0, 1.0 - pow((s + 0.55) / 1.1, 2.0))) * underRim;
    vec3 terra = mix(vec3(0.80, 0.47, 0.33) * dayL, vec3(0.20, 0.10, 0.06) * nightL + vec3(0.14, 0.15, 0.26) * pow(abs(s), 5.0), night);
    terra *= 1.0 + 0.12 * rimB * smoothstep(POT_H * 0.84, POT_H * 0.98, q.y);
    terra *= 1.0 - 0.30 * exp(-pow((q.y - POT_H * 0.82) / 1.2, 2.0)) - 0.35 * exp(-pow(q.y / 1.5, 2.0));
    vec3 lip = mix(vec3(0.92, 0.62, 0.47), vec3(0.24, 0.13, 0.08), night);
    vec3 dirt = mix(vec3(0.24, 0.16, 0.11), vec3(0.03, 0.02, 0.015), night);
    vec3 pc = mix(terra, lip, topE * (1.0 - soil));
    pc = mix(pc, dirt, soil);
    o = vec4(mix(o.rgb, pc, potM), max(o.a, potM));
  }
  for (int i = 6; i < 9; i++) leaf(o, q, i, night);
  return o;
}
// The balcony parapet outside, below the street: a sunlit concrete coping over a face in its own shade, with
// panel joints. Returns colour in rgb and coverage in a.
vec4 parapet(vec2 p, float yBase, float night) {
  if (p.y > yBase + 1.0) return vec4(0.0);
  float m = 1.0 - smoothstep(yBase - 0.7, yBase + 0.7, p.y);
  float cope = smoothstep(yBase - 9.0, yBase - 8.0, p.y);
  float lip = exp(-pow((p.y - yBase + 1.5) / 1.3, 2.0));
  float under = exp(-pow((p.y - yBase + 11.0) / 3.0, 2.0)) * (1.0 - cope);
  float joint = smoothstep(73.6, 74.6, abs(mod(p.x + 40.0, 150.0) - 75.0)) * (1.0 - cope);
  float n = 0.5 * vnoise(p * 0.08) + 0.5 * vnoise(p * 0.35);
  vec3 face = mix(vec3(0.47, 0.50, 0.58), vec3(0.56, 0.59, 0.67), smoothstep(yBase - 70.0, yBase - 10.0, p.y)) * (0.96 + 0.07 * n);
  vec3 top = vec3(0.76, 0.77, 0.80) * (0.97 + 0.05 * n) + 0.06 * lip;
  vec3 day = mix(face * (1.0 - 0.18 * under) * (1.0 - 0.12 * joint), top, cope);
  vec3 nface = vec3(0.012, 0.014, 0.026) + vec3(0.020, 0.020, 0.036) * smoothstep(yBase - 60.0, yBase - 10.0, p.y);
  vec3 ntop = vec3(0.030, 0.032, 0.052) + vec3(0.16, 0.14, 0.16) * lip;
  vec3 dark = mix(nface * (1.0 - 0.4 * under) * (1.0 - 0.3 * joint), ntop, cope);
  return vec4(mix(day, dark, night), m);
}
// The scenery: sky, three skylines with their windows and neon, the street, the parapet, a faint glass sheen,
// the frame, the sill and the plant. sway shifts the view a little against the frame.
vec3 backdrop(vec2 fc, vec2 p, vec2 sz, vec2 su, float hu, vec2 sway, out float front) {
  vec3 col, a1, a2, a3;
  vec4 fa, mi, ne;
  float yBase = uFloor / uDpr;
  float tall = sz.y * 0.62;
  float night = 1.0 - uLight;
  vec2 po = p - sway * PARALLAX;
  vec2 rip = vec2(vnoise(p * 0.004 + 1.7), vnoise(p * 0.004 + 6.1)) - 0.5;
  // The cover is a defocused view: a high mip with a small ring of taps hides the mip steps.
  vec2 vuv = stageUv(fc - sway * PARALLAX * 0.5 * uDpr) + rip * 0.006;
  vec3 view = textureLod(uCoverTex, vuv, VIEW_LOD).rgb * 0.4;
  view += (textureLod(uCoverTex, vuv + vec2(VIEW_TAP, VIEW_TAP), VIEW_LOD).rgb + textureLod(uCoverTex, vuv + vec2(-VIEW_TAP, VIEW_TAP), VIEW_LOD).rgb
    + textureLod(uCoverTex, vuv + vec2(VIEW_TAP, -VIEW_TAP), VIEW_LOD).rgb + textureLod(uCoverTex, vuv + vec2(-VIEW_TAP, -VIEW_TAP), VIEW_LOD).rgb) * 0.15;
  float smudge = smoothstep(0.55, 0.85, fbm(p * 0.012 + 3.0));
  float sheen = exp(-pow(dot(su - vec2(0.15, 0.40), normalize(vec2(1.0, -0.6))) / 0.05, 2.0));
  float roadTop = yBase + 56.0;
  vec4 wall = parapet(po, yBase, night);
  // The street: a curb under the buildings and dashed lane lines.
  float marks = exp(-pow((p.y - roadTop + 2.5) / 1.6, 2.0)) * 0.8;
  marks += exp(-pow((p.y - yBase - 37.0) / 0.9, 2.0)) * step(0.55, fract(po.x / 46.0)) * 0.7;
  if (uLight > 0.5) {
    vec3 sky = mix(vec3(0.93, 0.95, 0.98), vec3(0.70, 0.82, 0.94), su.y);
    col = mix(sky, view, 0.32);
    fa = skyline(po, tall, FAR_W, 0.20, 0.55, 3.0, vec2(5.0, 8.0), 0.30, vec3(0.74, 0.80, 0.88), vec3(1.0, 0.95, 0.82) * 0.3, 0.0, roadTop, 0.0, a1);
    col = mix(col, fa.rgb, fa.a);
    mi = skyline(po, tall, MID_W, 0.17, 0.42, 9.0, vec2(8.0, 12.0), 0.30, vec3(0.58, 0.66, 0.78), vec3(1.0, 0.95, 0.82) * 0.35, 0.0, roadTop, 1.0, a2);
    col = mix(col, mi.rgb, mi.a);
    ne = skyline(po, tall, NEAR_W, 0.12, 0.30, 15.0, vec2(11.0, 16.0), 0.30, vec3(0.40, 0.48, 0.62), vec3(1.0, 0.95, 0.85) * 0.35, 0.0, roadTop, 1.0, a3);
    col = mix(col, ne.rgb, ne.a);
    float road = smoothstep(roadTop + 1.0, roadTop - 1.0, p.y) * step(yBase - 2.0, p.y);
    col = mix(col, vec3(0.48, 0.52, 0.60), road);
    col = mix(col, vec3(0.62, 0.65, 0.72), road * marks);
    col = mix(col, wall.rgb, wall.a);
    col += vec3(1.0, 0.97, 0.90) * (0.04 + 0.03 * smudge) + sheen * 0.03;
    col = mix(col, uGround, hu * 0.3);
  } else {
    float glowH = exp(-pow((su.y - 0.30) / 0.28, 2.0));
    col = view * vec3(0.85, 0.95, 1.15) * (0.34 + 0.12 * glow()) + vec3(0.006, 0.008, 0.016) + vec3(0.20, 0.10, 0.14) * 0.35 * glowH;
    fa = skyline(po, tall, FAR_W, 0.20, 0.55, 3.0, vec2(5.0, 8.0), WIN_LIT * 0.7, mix(vec3(0.035, 0.04, 0.085), col, 0.35), vec3(1.0, 0.78, 0.45) * 0.55, 0.0, roadTop, 0.0, a1);
    col = mix(col, fa.rgb, fa.a);
    mi = skyline(po, tall, MID_W, 0.17, 0.42, 9.0, vec2(8.0, 12.0), WIN_LIT, vec3(0.022, 0.026, 0.058), vec3(1.0, 0.78, 0.45) * (0.65 + 0.3 * glow()), 0.7, roadTop, 1.0, a2);
    col = mix(col, mi.rgb, mi.a);
    ne = skyline(po, tall, NEAR_W, 0.12, 0.30, 15.0, vec2(11.0, 16.0), WIN_LIT * 0.8, vec3(0.010, 0.012, 0.028), vec3(1.0, 0.80, 0.50) * (0.75 + 0.3 * glow()), 1.0, roadTop, 1.0, a3);
    col = mix(col, ne.rgb, ne.a);
    // The band behind the title and the seek row, from the floor line to just above the cover's foot, keeps
    // its windows and neon low so the text sits on a quiet city.
    vec2 cc = coverCenter() / uDpr;
    float calm = (1.0 - smoothstep(1.05, 1.35, abs(p.x - cc.x) / (uCover.z / uDpr))) * smoothstep(yBase - 40.0, yBase, p.y)
      * (1.0 - smoothstep(uCover.y / uDpr + 20.0, uCover.y / uDpr + 90.0, p.y));
    col = mix(col, col * (1.0 - CALM_DIM), calm);
    col += (a1 * (1.0 - mi.a) * (1.0 - ne.a) + a2 * (1.0 - ne.a) + a3) * (0.7 + 0.5 * glow()) * (1.0 - 0.6 * hu) * (1.0 - 0.7 * calm);
    col = mix(col, col * 0.30, hu * 0.85);
    float road = smoothstep(roadTop + 1.0, roadTop - 1.0, p.y) * step(yBase - 2.0, p.y);
    col = mix(col, vec3(0.012, 0.014, 0.026), road);
    col = mix(col, vec3(0.05, 0.05, 0.07), road * marks);
    col = mix(col, wall.rgb, wall.a);
    col += LAMP_COL * (0.006 * smudge + 0.012 * sheen);
    col = mix(col, uGround, hu * 0.3);
  }
  // The frame, the sill and the plant sit in front of the pane, so they carry no reflection. The grain runs
  // along each member; the sill shows its rail, its lit top, a rounded nosing and the shaded apron below.
  float mx = coverCenter().x / uDpr - uCover.z / uDpr * 1.1;
  float ed = min(min(p.x, sz.x - p.x), sz.y - p.y);
  float fm = 1.0 - smoothstep(FRAME_PX - 1.0, FRAME_PX + 1.0, ed);
  float mull = 1.0 - smoothstep(6.0, 8.0, abs(p.x - mx));
  float sill = 1.0 - smoothstep(SILL_PX - 0.7, SILL_PX + 0.7, p.y);
  float inner = (exp(-pow((ed - FRAME_PX) / 1.4, 2.0)) + exp(-pow((abs(p.x - mx) - 7.0) / 1.4, 2.0)) * 0.7) * (1.0 - sill);
  inner += exp(-pow((p.y - SILL_PX) / 1.4, 2.0)) * step(p.y, SILL_PX);
  bool upright = min(p.x, sz.x - p.x) < FRAME_PX + 1.0 || abs(p.x - mx) < 9.0;
  vec2 gp = upright && sill < 0.5 ? p.yx : p;
  float grain = vnoise(vec2(gp.x * 0.03, gp.y * 0.5));
  float frameM = max(max(fm, mull), sill);
  float yTop = SILL_PX - 8.0, yFront = yTop - SILL_DEPTH, yNose = yFront - 5.0;
  float zTop = step(yFront, p.y) * step(p.y, yTop);
  float sillL = 1.0;
  sillL = mix(sillL, 1.03 + 0.03 * smoothstep(yFront, yTop, p.y), zTop);
  sillL = mix(sillL, mix(0.84, 1.06, smoothstep(yNose, yFront, p.y)), step(yNose, p.y) * step(p.y, yFront));
  sillL = mix(sillL, 0.76 + 0.06 * smoothstep(0.0, yNose, p.y), step(p.y, yNose));
  sillL *= 1.0 - 0.10 * exp(-pow((p.y - yTop) / 1.0, 2.0)) * sill;
  // The pot's shadow on the sill top: cast toward the viewer by day, to the right by the lamp at night.
  vec2 sq = p - vec2(PLANT_X * sz.x + 14.0 * night, SILL_PX - 8.0 - SILL_DEPTH * 0.55 - 2.5 + 1.5 * night);
  float potShade = exp(-pow(sq.x / (POT_W * (1.05 + 0.4 * night)), 2.0) - pow(sq.y / (8.0 - 3.0 * night), 2.0)) * zTop;
  sillL *= 1.0 - 0.35 * potShade * sill;
  if (uLight > 0.5) {
    vec3 paint = vec3(0.96, 0.95, 0.93) * (0.97 + 0.05 * grain) * (1.0 - 0.22 * inner);
    paint *= mix(vec3(1.0), vec3(1.0, 0.99, 0.96), zTop * sill);
    col = mix(col, paint * mix(1.0, sillL, sill), frameM);
  } else {
    float lampLit = exp(-pow((p.x - LAMP.x * sz.x) / (0.30 * sz.x), 2.0));
    vec3 wood = vec3(0.050, 0.032, 0.025) * (0.85 + 0.30 * grain) + LAMP_COL * 0.06 * inner * lampLit;
    wood += LAMP_COL * 0.05 * (0.3 + lampLit) * zTop * sill;
    col = mix(col, wood * mix(1.0, sillL, sill), frameM);
  }
  vec4 pl = plant(p, sz, night);
  col = mix(col, pl.rgb, pl.a);
  // The hush calms the plant by tinting its colour, never by thinning its coverage.
  col = mix(col, uGround, hu * 0.6 * pl.a);
  front = max(frameM, pl.a);
  return col;
}
// The moving layer: traffic light trails along the street, behind the frame, the sill and the plant (front). More cars come with more energy, each a little
// dimmer, so the street's total light stays with the level.
vec3 effects(vec3 col, vec2 p, vec2 sz, float hu, vec2 sway, float front) {
  float dens = clamp(0.62 / uDensity, 0.8, 1.25);
  float yBase = uFloor / uDpr;
  float roadTop = yBase + 56.0;
  vec2 po = p - sway * PARALLAX;
  float mx = coverCenter().x / uDpr - uCover.z / uDpr * 1.1;
  float road = smoothstep(roadTop + 1.0, roadTop - 1.0, p.y) * step(yBase - 2.0, p.y) * (1.0 - front);
  if (uLight > 0.5) {
    float cars = lane(po, yBase + 14.0, 1.0, 40.0, 220.0, 2.0, 2.5) + lane(po, yBase + 30.0, -1.0, 55.0, 260.0, 5.0, 2.2) + lane(po, yBase + 44.0, 1.0, 30.0, 300.0, 8.0, 1.8);
    col = mix(col, vec3(0.95, 0.35, 0.30), clamp(cars * dens, 0.0, 1.0) * 0.5 * road);
  } else {
    float red = lane(po, yBase + 14.0, 1.0, 40.0, 220.0, 2.0, 2.5) + lane(po, yBase + 44.0, 1.0, 30.0, 300.0, 8.0, 1.8);
    float wht = lane(po, yBase + 30.0, -1.0, 55.0, 260.0, 5.0, 2.2) + lane(po, yBase + 22.0, -1.0, 70.0, 340.0, 11.0, 1.8);
    col += (vec3(1.0, 0.18, 0.12) * red + vec3(1.0, 0.92, 0.75) * wht) * dens * road * (0.55 + 0.35 * glow()) * (1.0 - 0.5 * hu);
  }
  return col;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  vec2 sz = uRes / uDpr;
  vec2 su = fc / uRes;
  float hu = hushAt(fc);
  vec2 sway = uSway;
  float front;
  vec3 col = backdrop(fc, p, sz, su, hu, sway, front);
  col = effects(col, p, sz, hu, sway, front);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/**
 * Advances the beat windows by `dt` and packs each slot's seed and glow into `packed`. A beat takes a free
 * slot (never one still glowing), so a burst always runs its full rise and fade.
 */
export function stepBeatWindows(
  wins: (BeatWindow | undefined)[],
  dt: number,
  beat: number,
  drive: number,
  rng: () => number,
  packed: Float32Array,
): void {
  if (beat > 0) {
    let free = -1;
    for (let i = 0; i < WINDOW_SLOTS && free < 0; i++) if (!wins[i] || wins[i]!.glow < SLOT_FREE) free = i;
    if (free >= 0) wins[free] = { seed: rng() * SEED_SPAN, age: 0, glow: 0, amp: Math.min(1, 0.6 + 0.25 * drive) };
  }
  packed.fill(0);
  wins.forEach((w, i) => {
    if (!w) return;
    w.age += dt;
    const r = Math.min(1, w.age / RISE);
    w.glow = w.amp * r * r * (3 - 2 * r) * Math.exp(-Math.max(0, w.age - RISE) / FADE_TAU);
    packed[i * 2] = w.seed;
    packed[i * 2 + 1] = w.glow;
  });
}

export function createWindow(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const rng = createRng(RNG_SEED);
  const wins: (BeatWindow | undefined)[] = [];
  const packed = new Float32Array(WINDOW_SLOTS * 2);
  let phase = 0;
  let traffic = 0;
  let twinkle = 0;
  let energy = 0.3;
  let neon = 0;

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
      energy += (clamp01(s.level * 1.1 + s.bassMotion * 0.5) - energy) * ease(ENERGY_TAU);
      neon += (clamp01(s.bassMotion) - neon) * ease(NEON_TAU);
      phase += f.dt * SWAY_RATE;
      traffic += f.dt * (0.45 + 1.7 * energy);
      twinkle += f.dt;
      stepBeatWindows(wins, f.dt, s.beat, s.drive, rng, packed);
      const p = kit.program("window", FS_VS, FS);
      setFluid(kit, p, f, 0, null, art.tex);
      kit.set2(p, "uSway", Math.sin(phase) * 10, Math.cos(phase * 0.7) * 5);
      kit.set1(p, "uTraffic", traffic);
      kit.set1(p, "uDensity", 0.35 + 0.45 * energy);
      kit.set1(p, "uTwinkle", twinkle);
      kit.set1(p, "uNeonB", neon);
      kit.gl.uniform2fv(kit.uniform(p, "uBeatWin"), packed);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
