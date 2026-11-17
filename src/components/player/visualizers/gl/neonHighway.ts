/*
 * Neon Highway: a night drive down an endless neon highway into a striped retro sun, or the same drive at
 * golden hour by day. The camera is a true pinhole over a flat road, so every repeating thing (grid, dashes,
 * lamp posts, gates, light trails) sits at a world depth and slides toward the viewer: near things rush, far
 * things crawl, and the sun and the skyline, at infinity, never move. Speed is the scene's own logic: the
 * music's intensity against its own 17 s mean, sprung, with the lamp posts held on the beat by nudges of at
 * most 8%.
 *
 * Bass opens the sun's stripes and surges the speed, mids raise the skyline, highs lengthen the trails and run
 * glints along the grid; beats send a gate down the road and a ripple through the skyline. When the intensity
 * first reaches the top of its range, a launch glitch slides a few horizon slices with a small red and blue
 * split, at most once per 24 s; HIGHWAY.GLITCH_EVERY lists everything it touches.
 *
 * Photosensitivity: overall brightness follows only uGlow (the eased level). Every reaction moves or resizes
 * something, eased; the only light a beat adds is the gate's thin tubes, which travel. Paused or under Calm the
 * motion gain is 0: a steady cruise with no reaction.
 */

// -- Local Imports --
import { clamp01, createRng } from "./cozy";
import { CYBER_KIT, cyberBands, cyberGain } from "./cyber";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit, ProgramSource } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** The speed and the reactions. */
export const HIGHWAY = {
  // World units per second at speed 1.
  TRAVEL: 9,
  // Quick and slow measures of the intensity, and the gap between them that reaches the end of the range.
  FAST_TAU: 1,
  SLOW_TAU: 17,
  REL_SPAN: 0.25,
  // Calm holds one steady cruise; the ranges by reactivity: Balanced swings, Lively launches.
  CALM_SPEED: 0.85,
  RANGE_BALANCED: [0.7, 1.9],
  RANGE_LIVELY: [0.5, 2.8],
  // The speed spring: quick to speed up, slower to coast.
  PULL_UP: 1.5,
  DAMP_UP: 2.45,
  PULL_DOWN: 0.5,
  DAMP_DOWN: 1.4,
  MIN_SPEED: 0.3,
  // Extra speed per unit of bass envelope, eased.
  SURGE: 0.22,
  SURGE_TAU: 0.3,
  // Lamp post spacing (the shader's LAMP_GAP) and the beat lock: largest nudge, phase pull, ease.
  LAMP_GAP: 7,
  MAX_NUDGE: 0.08,
  PHASE_GAIN: 0.12,
  NUDGE_TAU: 0.7,
  // A gate is sent this many beats ahead, at most one per this many seconds (Balanced, Lively).
  GATE_LEAD: 4,
  GATE_GAP_BALANCED: 3.6,
  GATE_GAP_LIVELY: 1.9,
  // Wrap of the travel passed to the shader, a multiple of every repeat on the road.
  WRAP: 840,
  // Trail rates relative to the travel: oncoming cars close fast, cars ahead slowly.
  ONCOMING: 1.7,
  AHEAD: 0.35,
  // The launch glitch is made of: launchSlice, uGlitch and the slice shift and colour split in main(); the glitch*,
  // lastGlitch and wasHigh state; GLITCH_*, RNG_SEED and the step's rng; and the relative energy stepSpeed returns.
  // A rare launch glitch: when the intensity crosses into the top of its range, at most once per this many seconds.
  GLITCH_EVERY: 24,
  GLITCH_LIFE: 0.9,
} as const;

// Gates alive on the road at once, and the trail offsets' wrap (64 repeats of the shader's TRAIL_SEG).
const GATE_SLOTS = 3;
const TRAIL_WRAP = 6 * 64;
const RNG_SEED = 31;

const FS = `${SCENE_PRELUDE}${CYBER_KIT}
uniform vec4 uBandsE[6];
uniform float uTravel;    // world units travelled, wrapped
uniform vec2 uTrail;      // oncoming and same-way trail offsets, wrapped
uniform float uSpeed;     // 1 at cruise
uniform float uGlow;      // eased level: the only brightness input
uniform float uSlow;      // seconds, for slow drifts
uniform float uGap;       // bass: the sun's stripe gaps opening
uniform float uMidE;      // mids: the skyline rising
uniform float uHighE;     // highs: trail length and grid glints
uniform vec2 uPulse;      // beat ripple through the skyline: age, strength
uniform vec4 uGates[3];   // gates on the road: depth from the camera, strength, hue, unused
uniform vec2 uGlitch;     // launch glitch: amount in px, seed
// -- Tunables --
const float HORIZON = 0.28;   // horizon below the cover centre, cover widths
const float SUN_R = 1.12;     // sun radius, cover widths
const float SUN_R_AMB = 0.98; // in ambient, where the cover is larger, so the disc keeps its top
const float FOCAL = 1.25;     // focal length, cover widths
const float CAM_H = 1.0;      // eye height above the road
const float ROAD_W = 1.45;    // road half width
const float LANE = 0.72;      // lane lines either side of the centre
const float DASH = 2.4;       // dash repeat along the road
const float GRID = 2.0;       // grid cell beside the road
const float LAMP_X = 3.2;     // lamp posts from the centre line
const float LAMP_H = 3.0;     // post height
const float LAMP_GAP = 7.0;   // post spacing; HIGHWAY.LAMP_GAP must match
const float ARM = 1.3;        // lamp arm reach over the road
const float GATE_W = 3.4;     // gate half width
const float GATE_H = 3.4;     // gate height
const float TRAIL_SEG = 6.0;  // trail repeat; the step wraps the offsets on 64 of these
const float CITY_W = 2.4;     // skyline half width, cover widths
const float CITY_H = 0.24;    // tallest resting tower, cover widths
const float CITY_LIFT = 0.30; // height the mids add, cover widths
float band(int i) { return uBandsE[i >> 2][i & 3]; }

// Distance in px to the nearest line of a repeating world coordinate v, given the world size of one px.
float lineDist(float v, float period, float pxW) { return abs(fract(v / period - 0.5) - 0.5) * period / pxW; }
// A neon line: a crisp core of half width w px and a soft halo of h px.
vec2 neonLine(float dPx, float w, float h) { return vec2(1.0 - smoothstep(w - 0.6, w + 0.6, dPx), exp(-dPx / h)); }

vec3 sunColor(float v, bool dk) {
  vec3 top = dk ? vec3(1.00, 0.88, 0.22) : vec3(1.00, 0.93, 0.40);
  vec3 mid = dk ? vec3(1.00, 0.42, 0.16) : vec3(1.00, 0.58, 0.22);
  vec3 bot = dk ? vec3(1.00, 0.08, 0.52) : vec3(1.00, 0.26, 0.48);
  vec3 c = mix(bot, mid, smoothstep(0.0, 0.45, v));
  return mix(c, top, smoothstep(0.4, 0.95, v));
}

// The sky, the sun, the far mountains and the skyline above the horizon.
vec3 skyside(vec2 p, vec2 cc, float yH, float cw, vec2 sz, bool dk, float scale, float det) {
  float h = p.y - yH;
  float up = clamp(h / max(sz.y - yH, 1.0), 0.0, 1.0);
  vec3 sky;
  if (dk) {
    sky = mix(vec3(0.30, 0.02, 0.36), vec3(0.025, 0.008, 0.10), smoothstep(0.0, 0.75, up));
    sky += vec3(1.00, 0.12, 0.45) * exp(-h / (0.22 * cw)) * 0.75;
    vec2 cell = floor(p / 34.0);
    float hs = hash21(cell);
    vec2 sp = fract(p / 34.0) * 34.0 - 4.0 - vec2(hash21(cell + 3.1), hash21(cell + 8.3)) * 26.0;
    sky += vec3(0.85, 0.85, 1.0) * step(0.9, hs) * exp(-dot(sp, sp) / 1.4) * smoothstep(0.3, 0.7, up) * (0.65 + 0.35 * sin(uSlow * 0.7 + hs * 60.0));
  } else {
    // Golden hour: azure overhead, a lilac band, a hot peach horizon.
    sky = mix(vec3(1.00, 0.62, 0.50), vec3(0.93, 0.66, 0.90), smoothstep(0.0, 0.35, up));
    sky = mix(sky, vec3(0.22, 0.52, 1.00), smoothstep(0.3, 0.95, up));
    sky += vec3(1.00, 0.55, 0.35) * exp(-h / (0.10 * cw)) * 0.30;
  }
  // The sun, at infinity, centred on the road's vanishing point. Stripes cut its lower half, scrolling down
  // toward the horizon; bass opens them.
  float R = (uAmbient > 0.5 ? SUN_R_AMB : SUN_R) * cw;
  float d = length(p - vec2(cc.x, yH));
  float v = h / R;
  float zone = 0.56;
  float w = clamp(1.0 - v / zone, 0.0, 1.0);
  float gap = min((0.05 + 0.36 * w) * (1.0 + 2.2 * uGap), 0.85);
  float ph = fract(v * 9.0 + uSlow * 0.12);
  float cut = (1.0 - smoothstep(gap - 0.06, gap + 0.06, ph)) * step(v, zone) * smoothstep(0.0, 0.08, w);
  float disc = soft(d - R, 1.0);
  float sunM = disc * (1.0 - cut);
  vec3 sunC = sunColor(v, dk) * (dk ? 0.86 + 0.24 * uGlow : 1.0);
  vec3 halo = sunColor(0.35, dk) * exp(-max(d - R, 0.0) / (0.28 * R)) * (dk ? 0.42 : 0.30) * (0.7 + 0.3 * uGlow);
  sky += halo * (1.0 - disc);
  // Through the gaps: the sky, warmed by the sun behind.
  sky = mix(sky, sky + sunColor(v, dk) * (dk ? 0.10 : 0.12), disc * cut);
  vec3 col = mix(sky, sunC, sunM);
  // Far mountains at both sides of the sun, a wire glow along their ridges.
  float ax = abs(p.x - cc.x) / cw;
  float side = smoothstep(0.6, 1.6, ax);
  if (h < 0.5 * cw) {
    float mx = (p.x - cc.x) / cw;
    float ridge = (0.05 + 0.30 * fbm(vec2(mx * 1.6 + 7.0, 2.0)) * side) * cw;
    float inM = soft(h - ridge, 0.8);
    vec3 mc = dk ? vec3(0.10, 0.015, 0.17) : vec3(0.50, 0.38, 0.78);
    float contour = neonLine(lineDist(h / cw, 0.035, 1.0 / cw), 0.4, 1.2).x * smoothstep(1.0, 0.0, h / max(ridge, 1.0)) * 0.5;
    vec3 rim = dk ? vec3(1.00, 0.20, 0.75) : vec3(0.85, 0.30, 0.75);
    col = mix(col, mc + rim * contour * 0.25 * det * scale, inM * side);
    vec2 rl = neonLine(abs(h - ridge), 0.8, 5.0);
    col += rim * (rl.x * 0.9 + rl.y * 0.25) * side * scale * (dk ? 1.0 : 0.6) * step(-2.0, ridge - h + 2.0);
  }
  // The skyline: two rows of towers in silhouette against the sun, the near row rimmed in neon. Mids raise the
  // towers band by band, mirrored about the road; a beat sends a ripple out from the centre.
  if (h < (CITY_H + CITY_LIFT + 0.12) * cw) {
    float dx = abs(p.x - cc.x) / cw;
    float env = smoothstep(CITY_W, 0.5, dx) * (0.45 + 0.55 * smoothstep(0.0, 0.7, dx));
    int bi = 5 + int(min(dx / CITY_W, 0.999) * 10.0);
    float lift = pow(uMidE, 0.7) * (0.5 + 0.9 * band(bi)) * CITY_LIFT * smoothstep(CITY_W + 0.2, 0.8, dx);
    float ripple = uPulse.y * exp(-pow((dx - 0.3 - uPulse.x * 2.0) / 0.25, 2.0)) * 0.10;
    // Far row: narrow, lower, hazed toward the sky.
    float fw = 0.032 * cw;
    float fi = floor(p.x / fw);
    float fh = (0.03 + 0.10 * hash21(vec2(fi, 1.3))) * cw * env + lift * 0.5 * cw;
    float far = soft(h - fh, 0.7);
    vec3 farC = dk ? vec3(0.17, 0.02, 0.24) : vec3(0.60, 0.42, 0.78);
    col = mix(col, farC, far * smoothstep(CITY_W + 0.2, CITY_W - 0.4, dx));
    // Near row: wider towers with stepped tops, antennas and lit windows.
    float nw = 0.068 * cw;
    float ni = floor(p.x / nw);
    float lx = fract(p.x / nw);
    float h1 = hash21(vec2(ni, 3.7)), h2 = hash21(vec2(ni, 9.1)), h3 = hash21(vec2(ni, 15.3));
    // About half the towers answer the mids strongly, the rest stay low, so the sun shows between the spires.
    float rise = mix(0.12, 1.25, smoothstep(0.42, 0.58, h2));
    float th = ((0.025 + CITY_H * h1 * h1 * (0.5 + 0.7 * h1)) * env + lift * rise + ripple * (0.4 + h2)) * cw;
    float inX = step(0.06 + 0.1 * h3, lx) * step(lx, 0.94 - 0.1 * h2);
    float step2 = step(0.6, h3) * step(0.3, lx) * step(lx, 0.7) * 0.05 * cw;
    float top = th + step2;
    float body = inX * soft(h - top, 0.7) * step(0.004 * cw, th);
    float ant = step(0.85, h1) * step(abs(lx - 0.5), 0.03) * step(h, top + 0.07 * cw) * inX;
    vec3 bodyC = dk ? vec3(0.035, 0.008, 0.07) : vec3(0.24, 0.13, 0.42);
    col = mix(col, bodyC, max(body, ant));
    vec3 rimC = mix(dk ? vec3(0.0, 0.95, 1.0) : vec3(0.0, 0.50, 1.0), dk ? vec3(1.0, 0.15, 0.8) : vec3(0.95, 0.15, 0.6), step(0.5, h2));
    float rim = inX * exp(-pow((h - top) / 0.9, 2.0)) * step(0.004 * cw, th);
    col += rimC * rim * (dk ? 1.1 : 0.7) * scale;
    vec2 wc = vec2(lx * nw, h) / vec2(4.0, 6.0);
    float win = step(0.3, fract(wc.x)) * step(fract(wc.x), 0.75) * step(0.3, fract(wc.y)) * step(fract(wc.y), 0.7) * step(h, top - 4.0) * inX;
    float lit = step(hash21(floor(wc) + ni * 7.3), 0.22);
    vec3 wcol = mix(vec3(1.0, 0.75, 0.45), vec3(0.4, 0.9, 1.0), step(0.6, hash21(floor(wc) + 2.0)));
    col += wcol * win * lit * body * (dk ? 0.55 : 0.0) * scale * det;
  }
  return col;
}

// The road and the grid below the horizon: a flat plane seen through the pinhole.
vec3 groundside(vec2 p, vec2 cc, float yH, float cw, float F, bool dk, float scale, float det, vec3 n1, vec3 n2) {
  float dy = max(yH - p.y, 0.5);
  float z = F * CAM_H / dy;
  float X = (p.x - cc.x) * CAM_H / dy;
  float pxX = CAM_H / dy;              // world X per px across
  float fwX = pxX * (1.0 + abs(p.x - cc.x) / dy);  // and its full footprint, for lines that converge
  float pxZ = F * CAM_H / (dy * dy);   // world Z per px
  float Zw = z + uTravel;
  float ax = abs(X);
  float fogK = smoothstep(4.0, 70.0, z);
  // Motion smear along the road, from this frame's travel, in px.
  float smear = uSpeed * 9.0 / 120.0 / pxZ;
  float onRoad = 1.0 - smoothstep(ROAD_W - pxX, ROAD_W + pxX, ax);
  vec3 col;
  // Beside the road: the grid floor. Cross lines rush toward the viewer; long lines stay put.
  // By day the floor is chrome: it mirrors the sky, peach at the horizon to azure underfoot.
  vec3 chrome = mix(vec3(1.0, 0.70, 0.62), vec3(0.62, 0.66, 0.98), smoothstep(0.0, 0.45, dy / cw));
  chrome = mix(chrome, vec3(0.30, 0.50, 0.95), smoothstep(0.35, 1.2, dy / cw));
  vec3 floorC = dk ? vec3(0.035, 0.0, 0.075) : chrome;
  floorC = mix(floorC, dk ? vec3(0.22, 0.02, 0.28) : vec3(1.0, 0.72, 0.65), fogK);
  float fadeZ = smoothstep(0.45, 0.12, pxZ / GRID);
  float dz = lineDist(Zw, GRID, pxZ);
  vec2 lz = neonLine(dz, 0.7 + smear * 0.5, 5.0 + smear) * vec2(1.0 / (1.0 + smear * 0.35), 1.0) * smoothstep(0.0, 90.0, p.y);
  float dxg = lineDist(ax - ROAD_W, GRID * 0.5, fwX);
  vec2 lxg = neonLine(dxg, 0.7, 5.0);
  float fadeX = smoothstep(0.3, 0.08, fwX / GRID);
  // Highs: glints running along the long lines, faster than the road.
  float gk = floor((ax - ROAD_W) / (GRID * 0.5) + 0.5);
  float gu = (z + uTrail.x * 1.2) / 9.0 + hash11(gk) * 7.0;
  float glint = exp(-pow((fract(gu) - 0.5) * 9.0 / 0.5, 2.0)) * step(0.45, hash21(vec2(mod(floor(gu), 64.0), gk)));
  float gl = lxg.x * glint * smoothstep(0.1, 0.6, uHighE) * fadeX;
  vec3 gridC = (n2 * (lz.x + lz.y * 0.35) * fadeZ + n1 * (lxg.x + lxg.y * 0.3) * fadeX) * (1.0 - fogK * 0.7);
  if (dk) col = floorC + gridC * 0.95 * scale * det + vec3(0.8, 1.0, 1.0) * gl * 1.4 * scale * det;
  else {
    col = mix(floorC, n2 * 0.85, clamp(lz.x * 0.85 + lz.y * 0.12, 0.0, 1.0) * fadeZ * det * (1.0 - fogK * 0.6));
    col = mix(col, n1 * 0.85, clamp(lxg.x * 0.85 + lxg.y * 0.10, 0.0, 1.0) * fadeX * det * (1.0 - fogK * 0.6));
    col += vec3(1.0) * gl * 0.6 * det;
  }
  // The road: wet asphalt, the sun's reflection broken by the moving surface, neon edges and rushing dashes.
  // By day the road is pale pearl near the viewer, so the Player's dark text and controls keep their contrast.
  vec3 roadC = dk ? vec3(0.030, 0.012, 0.060) : mix(vec3(0.42, 0.33, 0.58), vec3(0.64, 0.58, 0.80), smoothstep(0.1, 1.0, dy / cw));
  roadC = mix(roadC, dk ? vec3(0.18, 0.02, 0.24) : vec3(0.95, 0.66, 0.66), fogK);
  float ripple = 0.55 + 0.45 * vnoise(vec2(X * 4.0, Zw * 1.3));
  float refl = exp(-pow(X / (0.32 + 0.004 * z), 2.0)) * exp(-dy / (0.55 * cw)) * ripple;
  roadC += sunColor(clamp(dy / (0.5 * cw), 0.0, 1.0) * 0.6, dk) * refl * (dk ? 0.45 : 0.35) * (0.7 + 0.3 * uGlow);
  // Lamp pools: each post lights the road under its arm.
  float pz = lineDist(Zw - 0.2, LAMP_GAP, 1.0);
  roadC += (dk ? vec3(1.0, 0.25, 0.75) : vec3(1.0, 0.7, 0.8)) * exp(-pz * pz / 1.8 - pow((ax - (LAMP_X - ARM * 0.6)) / 0.5, 2.0)) * (dk ? 0.18 : 0.06) * scale;
  // Marks fade in the last strip above the stage's bottom edge, so a dash slides away under the viewer instead of
  // being cut off, which would pulse the stage at the dash rate.
  float underfoot = smoothstep(0.0, 90.0, p.y);
  float dash = smoothstep(0.0, 0.02, fract(Zw / DASH)) * (1.0 - smoothstep(0.42, 0.44 + smear * pxZ / DASH, fract(Zw / DASH))) * underfoot;
  vec2 cl = neonLine(ax / pxX, 0.045 / pxX, 4.0 + 0.02 / pxX);
  vec2 ll = neonLine(abs(ax - LANE) / pxX, 0.03 / pxX, 3.0 + 0.015 / pxX);
  vec3 markC = dk ? vec3(1.0, 0.55, 0.85) : vec3(1.0, 0.97, 1.0);
  roadC = mix(roadC, markC, cl.x * dash * 0.9 * det) + markC * cl.y * dash * 0.25 * scale * det * (dk ? 1.0 : 0.3);
  roadC = mix(roadC, dk ? vec3(0.75, 0.95, 1.0) : vec3(0.95, 0.97, 1.0), ll.x * dash * 0.7 * det);
  // Light trails: oncoming headlights on the left, tail lights ahead on the right. Highs stretch them.
  float len = 0.22 + 0.42 * uHighE;
  for (int i = 0; i < 2; i++) {
    float laneX = i == 0 ? -1.08 : 1.08;
    float off = i == 0 ? uTrail.x : uTrail.y;
    float u = (z + off) / TRAIL_SEG + float(i) * 0.37;
    float s = floor(u), f = fract(u);
    float on = smoothstep(0.55 - 0.4 * uHighE, 0.65 - 0.4 * uHighE, hash21(vec2(mod(s, 64.0), float(i) * 5.0)));
    float body = smoothstep(0.0, 0.03, f) * (1.0 - smoothstep(len - 0.04, len, f));
    float head = i == 0 ? exp(-f / 0.04) : exp(-(len - f) / 0.05) * step(f, len);
    float lw = abs(abs(X - laneX) - 0.16) / pxX;
    vec2 tl = neonLine(lw, max(0.022 / pxX, 0.6), 2.5 + 0.03 / pxX);
    vec3 tc = i == 0 ? (dk ? vec3(0.75, 0.95, 1.0) : vec3(1.0, 0.98, 0.9)) : (dk ? vec3(1.0, 0.10, 0.35) : vec3(1.0, 0.20, 0.35));
    roadC += tc * (tl.x * 0.9 + tl.y * 0.35) * (body * 0.75 + head * 0.8) * on * (1.0 - fogK) * scale * det * underfoot;
  }
  vec2 el = neonLine(abs(ax - ROAD_W) / pxX, max(0.03 / pxX, 0.7), 4.0 + 0.06 / pxX);
  col = mix(col, roadC, onRoad);
  col += n1 * (el.x * 1.1 + el.y * 0.35) * scale * (dk ? 1.0 : 0.7) * (1.0 - fogK * 0.5);
  // Above cruise, streaks race down the edge lines.
  float race = smoothstep(1.05, 1.9, uSpeed) * smoothstep(0.55, 0.97, fract((z + uTrail.x * 0.8) / 5.0 + 0.5 * step(0.0, X)));
  col += vec3(0.85, 1.0, 1.0) * (el.x * 0.9 + el.y * 0.4) * race * scale * (dk ? 1.0 : 0.6) * (1.0 - fogK);
  // Gate light on the road beneath each gate.
  for (int i = 0; i < 3; i++) {
    vec4 g = uGates[i];
    if (g.y <= 0.0) continue;
    vec3 gc = g.z < 0.5 ? n2 : n1;
    col += gc * exp(-pow((z - g.x) / 0.9, 2.0)) * smoothstep(ROAD_W + 0.6, ROAD_W - 0.2, ax) * g.y * (dk ? 0.22 : 0.10) * smoothstep(40.0, 15.0, g.x) * smoothstep(3.0, 7.0, g.x);
  }
  // Haze where the plane meets the sky.
  col += (dk ? vec3(1.0, 0.12, 0.5) : vec3(1.0, 0.75, 0.70)) * exp(-dy / (0.035 * cw)) * (dk ? 0.5 : 0.35);
  return col;
}

// The launch glitch's slices: rows cut 8 to 34 px tall, about half of them sliding sideways by up to amt px.
float launchSlice(float y, float amt, float seed) {
  float b = floor(y / (8.0 + 26.0 * hash11(floor(y / 40.0) + seed)) + seed);
  return (hash11(b * 3.1 + seed) - 0.5) * 2.0 * step(0.5, hash11(b * 1.7 + seed)) * amt;
}

// The chamfered gate outline in its own plane: world X and height above the road.
float gateSd(vec2 q) {
  vec2 c = vec2(q.x, q.y - GATE_H * 0.5);
  vec2 b = vec2(GATE_W, GATE_H * 0.5);
  vec2 r = abs(c);
  return max(sdBox(c, b), (r.x + r.y - (b.x + b.y - 0.55)) * 0.7071);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, sz = uRes / uDpr, cc = coverCenter() / uDpr;
  float cw = uCover.z / uDpr;
  float hu = hushAt(fc);
  float det = 1.0 - 0.6 * hu;
  bool dk = uLight < 0.5;
  float yH = cc.y - HORIZON * cw;
  float F = FOCAL * cw;
  float scale = 0.62 + 0.55 * uGlow;
  vec3 n1 = mix(dk ? vec3(0.0, 0.92, 1.0) : vec3(0.0, 0.45, 1.0), neon(1), 0.10);
  vec3 n2 = mix(dk ? vec3(1.0, 0.08, 0.78) : vec3(0.95, 0.10, 0.62), neon(0), 0.08);
  vec3 col;
  if (p.y >= yH) {
    // The launch glitch slides a few slices of the horizon band sideways and lets them glide back.
    float band = step(p.y, yH + 0.75 * cw);
    float shift = launchSlice(p.y, uGlitch.x, uGlitch.y) * band;
    vec2 ps = vec2(p.x + shift, p.y);
    col = skyside(ps, cc, yH, cw, sz, dk, scale, det);
    // A moving slice splits its red and blue a little; only during the glitch, only on the slices that move.
    if (abs(shift) > 0.5) {
      float split = clamp(abs(shift) * 0.25, 0.0, 3.0);
      col.r = skyside(ps + vec2(split, 0.0), cc, yH, cw, sz, dk, scale, det).r;
      col.b = skyside(ps - vec2(split, 0.0), cc, yH, cw, sz, dk, scale, det).b;
    }
  } else {
    col = groundside(p, cc, yH, cw, F, dk, scale, det, n1, n2);
  }
  // Lamp posts down both sides, in front of everything at infinity.
  float dxs = p.x - cc.x;
  float side = sign(dxs);
  vec3 postC = dk ? vec3(0.05, 0.02, 0.09) : vec3(0.78, 0.78, 0.88);
  vec3 tubeC = dk ? vec3(1.0, 0.30, 0.85) : vec3(1.0, 0.35, 0.70);
  {
    float zp = F * LAMP_X / max(abs(dxs), 0.5);
    float k = floor((zp + uTravel) / LAMP_GAP + 0.5);
    float zk = k * LAMP_GAP - uTravel;
    if (zk > 0.35) {
      float xl = cc.x + side * F * LAMP_X / zk;
      float hw = max(F * 0.035 / zk, 0.5);
      float yb = yH - F * CAM_H / zk, yt = yH + F * (LAMP_H - CAM_H) / zk;
      float inY = step(yb, p.y) * smoothstep(yt + 0.5, yt - 0.5, p.y);
      float fade = inY * smoothstep(80.0, 30.0, zk);
      col = mix(col, postC, soft(abs(p.x - xl) - hw, 0.7) * fade);
      // A neon strip down the road side of each post.
      vec2 sl = neonLine(abs(p.x - (xl - side * hw * 0.55)), clamp(hw * 0.22, 0.5, 1.5), clamp(hw * 1.2, 1.5, 6.0));
      col += n1 * (sl.x * 0.8 + sl.y * 0.2) * fade * smoothstep(1.0, 3.0, zk) * scale * (dk ? 1.0 : 0.6);
    }
  }
  if (p.y > yH) {
    float za = F * (LAMP_H - CAM_H) / (p.y - yH);
    float k = floor((za + uTravel) / LAMP_GAP + 0.5);
    float zk = k * LAMP_GAP - uTravel;
    if (zk > 0.35) {
      float s = F / zk;
      float ya = yH + (LAMP_H - CAM_H) * s;
      vec2 a = vec2(cc.x + side * (LAMP_X - ARM) * s, ya - 0.06 * s);
      vec2 b = vec2(cc.x + side * (LAMP_X - 0.3) * s, ya - 0.06 * s);
      float armM = soft(sdSeg(p, vec2(a.x, ya), vec2(cc.x + side * LAMP_X * s, ya)) - max(0.03 * s, 0.5), 0.7);
      col = mix(col, postC, armM * smoothstep(80.0, 30.0, zk));
      float td = sdSeg(p, a, b);
      // Tube width and halo are capped in px and the tube dims as it nears, so a passing lamp never floods the stage.
      vec2 tl = neonLine(td, clamp(0.04 * s, 0.8, 3.0), clamp(0.16 * s, 2.5, 10.0));
      float near = smoothstep(1.5, 4.5, zk) * smoothstep(70.0, 25.0, zk);
      // A faint cone of light under the tube, in the haze.
      float cx2 = (a.x + b.x) * 0.5, hw2 = abs(b.x - a.x) * 0.5;
      float below = clamp((a.y - p.y) / max((LAMP_H - 0.2) * s, 1.0), 0.0, 1.0);
      float cone = step(p.y, a.y) * (1.0 - smoothstep(hw2 * (1.0 + below * 1.2), hw2 * (1.0 + below * 1.2) + 0.3 * s, abs(p.x - cx2))) * (1.0 - below) * (1.0 - below);
      if (dk) col += tubeC * ((tl.x * 1.2 + tl.y * 0.5) + cone * 0.10) * near * scale;
      else col = mix(col, tubeC, clamp(tl.x * near, 0.0, 1.0)) + tubeC * (tl.y * 0.25 + cone * 0.04) * near;
    }
  }
  // Gates whooshing toward the viewer: a double neon tube on a chamfered frame. A thin chromatic fringe opens
  // with speed, on the gate only.
  for (int i = 0; i < 3; i++) {
    vec4 g = uGates[i];
    if (g.y <= 0.0 || g.x < 0.3) continue;
    float pw = g.x / F;
    vec2 q = vec2(dxs, p.y - yH) * pw + vec2(0.0, CAM_H);
    if (q.y < 0.0) continue;
    float fr = (0.4 + 0.6 * clamp(uSpeed - 1.0, 0.0, 1.0)) * pw * 2.0;
    float sR = abs(gateSd(q + vec2(fr, 0.0))) / pw;
    float sG = abs(gateSd(q)) / pw;
    float sB = abs(gateSd(q - vec2(fr, 0.0))) / pw;
    float sI = abs(gateSd(q) + 0.16) / pw;
    float tw = clamp(0.035 / pw, 0.7, 2.5);
    vec3 core = vec3(neonLine(sR, tw, 1.0).x, neonLine(sG, tw, 1.0).x, neonLine(sB, tw, 1.0).x);
    float halo = exp(-sG / clamp(0.22 / pw, 3.0, 9.0)) * 0.45 + neonLine(sI, tw * 0.6, 1.0).x * 0.5 + exp(-sI / clamp(0.1 / pw, 2.0, 5.0)) * 0.15;
    vec3 gc = g.z < 0.5 ? n2 : n1;
    // Lit from the distance, dimmed before it sweeps out of frame: its light grows and leaves gradually.
    float k = g.y * smoothstep(45.0, 22.0, g.x) * smoothstep(2.5, 7.0, g.x) * smoothstep(0.0, 0.08, q.y);
    // By day the tube is painted in its hue, since added light would wash out to white on a bright sky.
    if (dk) col += (mix(gc, vec3(1.0), 0.55) * core + gc * halo) * k * scale;
    else col = mix(col, gc * vec3(0.95, 0.85, 1.0) * mix(vec3(1.0), core, 0.5), clamp(max(core.g, max(core.r, core.b)) * k, 0.0, 1.0)) + gc * halo * k * 0.3;
  }
  col *= dk ? 0.96 + 0.04 * sin(fc.y * 3.14159 / (1.5 * uDpr)) : 1.0;
  col = hushed(col, hu, 0.45);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** The light beat clock that holds the lamp posts on the beat. */
export interface HighwayBeatClock {
  clock: number;
  last: number;
  period: number;
  pos: number;
  lock: number;
}

/** A gate on the road: its world depth, strength and hue (0 or 1). */
export interface HighwayGate {
  z: number;
  s: number;
  hue: number;
}

/** The scene's moving state. The last three fields are derived each step for the shader. */
export interface NeonHighwayState {
  travel: number;
  speed: number;
  vel: number;
  fast: number;
  slowMean: number;
  primed: boolean;
  surge: number;
  nudge: number;
  slow: number;
  gap: number;
  mid: number;
  high: number;
  // The skyline ripple's age and strength.
  pulse: [number, number];
  gates: HighwayGate[];
  gateHue: number;
  lastGate: number;
  glitch: number;
  glitchSeed: number;
  lastGlitch: number;
  wasHigh: boolean;
  // The oncoming and same-way trail offsets, wrapped.
  trail: [number, number];
  bands: Float32Array;
  bc: HighwayBeatClock;
  shownSpeed: number;
  shownPulse: number;
  glitchAmt: number;
}

export function createNeonHighwayState(): NeonHighwayState {
  return {
    travel: 0,
    speed: 1,
    vel: 0,
    fast: 0,
    slowMean: 0,
    primed: false,
    surge: 0,
    nudge: 0,
    slow: 0,
    gap: 0,
    mid: 0,
    high: 0,
    pulse: [9, 0],
    gates: [],
    gateHue: 0,
    lastGate: -99,
    glitch: 9,
    glitchSeed: 1,
    lastGlitch: -99,
    wasHigh: false,
    trail: [0, 0],
    bands: new Float32Array(24),
    bc: { clock: 0, last: -1, period: 0.5, pos: 0, lock: 0 },
    shownSpeed: 1,
    shownPulse: 0,
    glitchAmt: 0,
  };
}

/** The speed spring: intensity against its own slow mean, sprung toward the reactivity's range. Returns that gap. */
function stepSpeed(st: NeonHighwayState, s: VisualSignal, dt: number, drive: number): number {
  const H = HIGHWAY;
  const intensity = s.level + 0.15 * s.bassMotion;
  if (!st.primed) {
    st.fast = intensity;
    st.slowMean = intensity;
    st.primed = true;
  }
  st.fast = easeEnvelope(st.fast, intensity, dt, H.FAST_TAU);
  st.slowMean = easeEnvelope(st.slowMean, intensity, dt, H.SLOW_TAU);
  const rel = Math.max(-1, Math.min(1, (st.fast - st.slowMean) / H.REL_SPAN));
  const [lo, hi] = drive > 1.3 ? H.RANGE_LIVELY : H.RANGE_BALANCED;
  const target = drive === 0 ? H.CALM_SPEED : rel < 0 ? 1 + (1 - lo) * rel : 1 + (hi - 1) * rel;
  const up = target > st.speed;
  st.vel += ((target - st.speed) * (up ? H.PULL_UP : H.PULL_DOWN) - st.vel * (up ? H.DAMP_UP : H.DAMP_DOWN)) * dt;
  st.speed = Math.max(H.MIN_SPEED, st.speed + st.vel * dt);
  return rel;
}

/** The beat clock: the period eases toward the gaps between beats, the phase pulls onto each beat. */
function stepBeatClock(bc: HighwayBeatClock, s: VisualSignal, dt: number, drive: number): void {
  bc.clock += dt;
  bc.pos += dt / bc.period;
  if (drive > 0 && s.beat > 0) {
    const gap = bc.clock - bc.last;
    if (bc.last >= 0 && gap < 2.5) {
      const one = gap / Math.max(1, Math.round(gap / bc.period));
      if (one > 0.3 && one < 1.2) bc.period += (one - bc.period) * 0.3;
      bc.lock = Math.min(1, bc.lock + 0.25);
    }
    bc.pos += (Math.round(bc.pos) - bc.pos) * 0.5;
    bc.last = bc.clock;
  }
  if (bc.clock - bc.last > 2.5 || drive === 0) bc.lock = easeEnvelope(bc.lock, 0, dt, 1);
}

/** The nudge that brings a lamp post past on every beat (or every 2nd, or 2 per beat), at most MAX_NUDGE. */
function lampNudge(st: NeonHighwayState, v: number): number {
  const H = HIGHWAY;
  const bc = st.bc;
  const perBeat = (v * bc.period) / H.LAMP_GAP;
  let q = 1;
  for (const c of [0.25, 0.5, 1, 2, 4]) if (Math.abs(Math.log(perBeat / c)) < Math.abs(Math.log(perBeat / q))) q = c;
  const exact = q / perBeat - 1;
  if (Math.abs(exact) > H.MAX_NUDGE) return 0;
  // A post looks to pass about 1.5 units before it reaches the camera plane.
  const phase = (st.travel + 1.5) / H.LAMP_GAP;
  let err = phase - bc.pos * q;
  err -= Math.round(err);
  return Math.max(-H.MAX_NUDGE, Math.min(H.MAX_NUDGE, exact - H.PHASE_GAIN * err)) * bc.lock;
}

/**
 * Advances the drive by dt at motion gain `drive` (0 under Calm and while paused). `rng` picks the launch
 * glitch's slices.
 */
export function stepNeonHighway(st: NeonHighwayState, s: VisualSignal, dt: number, drive: number, rng: () => number): void {
  const H = HIGHWAY;
  const rel = stepSpeed(st, s, dt, drive);
  stepBeatClock(st.bc, s, dt, drive);
  st.surge = easeEnvelope(st.surge, drive > 0 ? s.bassMotion * H.SURGE : 0, dt, H.SURGE_TAU);
  const v = H.TRAVEL * (st.speed + st.surge);
  st.nudge = easeEnvelope(st.nudge, drive > 0 ? lampNudge(st, v) : 0, dt, H.NUDGE_TAU);
  const dz = dt * v * (1 + st.nudge);
  st.travel += dz;
  st.trail[0] = (st.trail[0] + dz * H.ONCOMING) % TRAIL_WRAP;
  st.trail[1] = (st.trail[1] + dz * H.AHEAD) % TRAIL_WRAP;
  st.slow += dt;
  // Band jobs, each eased: bass opens the sun, mids lift the skyline, highs stretch the trails.
  const ease2 = (prev: number, target: number, up: number, down: number) =>
    easeEnvelope(prev, target, dt, target > prev ? up : down);
  st.gap = ease2(st.gap, drive > 0 ? clamp01(s.bassMotion * 0.75) : 0, 0.12, 0.45);
  st.mid = ease2(st.mid, drive > 0 ? clamp01(s.midMotion) : 0, 0.2, 0.6);
  st.high = ease2(st.high, drive > 0 ? clamp01(s.highMotion) : 0, 0.15, 0.5);
  // Beats: a gate sent four beats ahead, and a ripple through the skyline.
  st.pulse[0] += dt;
  const now = st.bc.clock;
  if (drive > 0 && s.beat > 0) {
    if (st.pulse[0] > 0.6) st.pulse = [0, Math.min(1, 0.5 + s.beat * 0.5) * Math.min(1.3, drive)];
    const minGap = drive > 1.3 ? H.GATE_GAP_LIVELY : H.GATE_GAP_BALANCED;
    if (now - st.lastGate > minGap) {
      st.gates.push({ z: st.travel + v * st.bc.period * H.GATE_LEAD, s: Math.min(1, 0.55 + s.beat * 0.45), hue: st.gateHue });
      st.gateHue = 1 - st.gateHue;
      st.lastGate = now;
      if (st.gates.length > GATE_SLOTS) st.gates.shift();
    }
  }
  st.gates = st.gates.filter((g) => g.z - st.travel > 0.2);
  // The launch glitch: the intensity crossing into the top of its range, rarely.
  const high = rel > 0.75;
  if (drive > 0 && high && !st.wasHigh && now - st.lastGlitch > H.GLITCH_EVERY) {
    st.glitch = 0;
    st.lastGlitch = now;
    st.glitchSeed = 1 + rng() * 50;
  }
  st.wasHigh = high;
  st.glitch += dt;
  const ga = st.glitch / H.GLITCH_LIFE;
  st.glitchAmt = ga < 1 ? Math.sin(Math.PI * Math.min(1, ga * 2.5)) ** 2 * (1 - ga) * 22 * Math.min(1.3, drive) : 0;
  st.shownSpeed = (st.speed + st.surge) * (1 + st.nudge);
  st.shownPulse = st.pulse[1] * Math.max(0, 1 - st.pulse[0] / 1.4);
  cyberBands(st.bands, s, drive, dt);
}

/** Packs the live gates as depth from the camera, strength, hue and 0 per slot; empty slots stay zero. */
export function packGates(st: NeonHighwayState, out: Float32Array): void {
  out.fill(0);
  st.gates.slice(-GATE_SLOTS).forEach((g, i) => out.set([g.z - st.travel, g.s, g.hue, 0], i * 4));
}

const NEON_HIGHWAY_PROGRAM: ProgramSource = { name: "neon-highway", vs: FS_VS, fs: FS };
/** The programs neon highway compiles, for warming the shader cache ahead of the stage. */
export const NEON_HIGHWAY_PROGRAMS: readonly ProgramSource[] = [NEON_HIGHWAY_PROGRAM];

export function createNeonHighway(kit: Kit): Candidate {
  const { gl } = kit;
  const rng = createRng(RNG_SEED);
  const st = createNeonHighwayState();
  const gates = new Float32Array(GATE_SLOTS * 4);

  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      const s = f.sig;
      stepNeonHighway(st, s, f.dt, cyberGain(s, f.playing), rng);
      packGates(st, gates);
      const p = kit.program(NEON_HIGHWAY_PROGRAM);
      setScene(kit, p, f, 0, null, null);
      gl.uniform4fv(kit.uniform(p, "uBandsE"), st.bands);
      gl.uniform4fv(kit.uniform(p, "uGates"), gates);
      kit.set1(p, "uTravel", st.travel % HIGHWAY.WRAP);
      kit.set2(p, "uTrail", st.trail[0], st.trail[1]);
      kit.set1(p, "uSpeed", st.shownSpeed);
      kit.set1(p, "uGlow", clamp01(s.level * 1.6));
      kit.set1(p, "uSlow", st.slow);
      kit.set1(p, "uGap", st.gap);
      kit.set1(p, "uMidE", st.mid);
      kit.set1(p, "uHighE", st.high);
      kit.set2(p, "uPulse", st.pulse[0], st.shownPulse);
      kit.set2(p, "uGlitch", st.glitchAmt, st.glitchSeed);
      kit.drawQuad();
    },
    dispose() {},
  };
}
