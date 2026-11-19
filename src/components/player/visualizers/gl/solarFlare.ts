/*
 * Solar Flare: the sun up close, a ball rising from the lower left behind the cover, its limb a steep diagonal arc
 * against black space, with magnetic arcades standing on the limb. The photosphere is incandescent and is the light
 * of the picture: a limb-darkened disc, yellow-white at the centre through gold to orange and red at the edge,
 * stirred at several scales, crossed by dark filaments, with spot groups and plage under the arcades. Every loop is
 * a field line of a buried dipole, so the plasma is drawn in field-line coordinates: threads follow the field,
 * clumps flow along it, rain falls back down it. The stage bloom lets the disc and the loops bleed light into
 * space. Dark-only: the scene has no light look.
 *
 * The loudness sets the heat: a near-silent passage is a cooler star that rolls slowly, a loud one is white-hot,
 * its convection churning and its corona reaching far. A beat lands on the whole sun, sized by its weight: a ring
 * runs out over the surface from under an arcade, the disc swells, the limb brightens, the corona's rays quicken,
 * the arcades jump, a kink runs up each one and a jet leaves the limb. Bass hits raise the spicules and high hits
 * light pinpoints in the loops' densest clumps. The bass also runs the flow along the loops, the mids sway them,
 * the highs lean the spicules and stream the corona. A surge that lands in a loud passage, or a long run of
 * full-weight beats, snaps an arcade: a twisted rope leaves it, gold and hotter than the loops, the arcade drops
 * and regrows, and a blast wave runs over the surface. A cut cools the sun and its arcades sink back, until the
 * lull fades or a surge clears it. A scene opened mid-song starts at that passage's heat. Under Calm and on a
 * pause, everything a beat, a hit or a shift left in flight fades out within half a second.
 *
 * Photosensitivity: the disc's light follows the eased level, the eased heat and the beat envelope, which rises
 * at most three times a second and is eased in; beat light warms toward gold and white, never red, and the red
 * glow away from the limb does not follow the beat. The sun's shape moves on a slower envelope than its light.
 * No hit lights the arcades' plasma: a bass hit only moves the spicules, a thin fringe at the limb, and a high
 * hit lights only the pinpoints, white-gold and a small share of an arcade. A surface wave is a brighter front
 * with a darker wake, so the mean light does not step with it. An eruption's light is spread over its growth,
 * and its rope holds no saturated red.
 */

// -- Local Imports --
import { clamp01 } from "./cozy";
import { COSMIC_COMMON } from "./cosmic";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit, ProgramSource, Rect } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** One arcade: limb angle (deg), foot radius (sun radii), scale (sun radii), lean, skew of the rear sheets. */
type Region = readonly [number, number, number, number, number];

/** Where the sun and its arcades sit in one framing. */
interface Composition {
  // The sun's centre in cover widths from the cover centre, and its radius in cover widths.
  C: readonly [number, number];
  R: number;
  REG: readonly [Region, Region, Region];
  // The limb sectors (deg) where a beat may raise a jet.
  JET: readonly [readonly [number, number], readonly [number, number]];
  // The arcade a beat's wave starts under: the one with the most open disc below it.
  WAVE: number;
}

const PLAYER: Composition = {
  C: [-0.75, -1.75],
  R: 2.0,
  REG: [
    [50, 0.972, 0.36, -0.8, 0.2],
    [95, 0.975, 0.22, -0.18, -0.2],
    [29, 0.98, 0.15, -0.1, 0.18],
  ],
  JET: [
    [27, 47],
    [84, 99],
  ],
  WAVE: 1,
};
const AMBIENT: Composition = {
  C: [-0.75, -1.62],
  R: 2.0,
  REG: [
    [30, 0.972, 0.36, -0.22, 0.2],
    [96, 0.975, 0.22, -0.18, -0.2],
    [50, 0.98, 0.14, 0.2, 0.18],
  ],
  JET: [
    [12, 51],
    [84, 104],
  ],
  WAVE: 0,
};
// Heat follows the loudness: its value in silence, its gain per unit of loudness, and its ease in seconds.
const HEAT_FLOOR = 0.1;
const HEAT_GAIN = 1.1;
const HEAT_TAU = 0.5;
// The loudness of the still. A paused scene holds its heat.
const REST_LOUD = 0.3;
const REST_HEAT = HEAT_FLOOR + HEAT_GAIN * REST_LOUD;
// The beat envelope: its rise and fall in seconds, and the most weight a beat lands with.
const BEAT_RISE = 0.04;
const BEAT_FALL = 0.26;
const BEAT_TOP = 1.5;
// The beat as it moves the sun's shape (the swell and the arcades' jump): a slower rise in seconds, so a thread
// travels about its own width per frame and reads as moving, not as flicker.
const JUMP_RISE = 0.1;
// The hit envelopes' fall in seconds.
const HIT_FALL = 0.15;
// A surface wave's speed over the sphere in rad per second, its life in seconds, and the radius it starts at
// under its arcade, in sun radii.
const WAVE_V = 0.8;
const WAVE_LIFE = 1.5;
const WAVE_R = 0.8;
// The arcades' jump as a share of their height, and the extra speed of the corona's rays per second, each per
// unit of its envelope.
const BEAT_LIFT = 0.16;
const STREAM_BEAT = 1.0;
// Least time between two kinks in seconds, their speed (arcade units per second), life, and sideways shove
// under a beat of weight 1.
const KINK_GAP = 0.45;
const KINK_V = 1.1;
const KINK_LIFE = 2.6;
const KINK_SHOVE = 0.2;
// A surge snaps an arcade once the loudness reaches this, if it does within the wait in seconds.
const FLARE_LOUD = 0.45;
const FLARE_WAIT = 0.8;
// A run of full-weight beats snaps one too: the least weight (before the reactivity gain) and loudness that
// count, the run's memory in seconds, the count that fires, the least time since the last eruption, and the
// power of that eruption against a full surge's.
const RUN_WEIGHT = 0.6;
const RUN_LOUD = 0.7;
const RUN_TAU = 8;
const RUN_FULL = 12;
const RUN_REST = 60;
const RUN_POWER = 0.6;
// A rope's life in seconds, and the time a rope in flight takes to clear for the next.
const ROPE_LIFE = 8.5;
const ROPE_CLEAR = 0.5;
// The blast wave's run over the surface in seconds, its speed in rad per second, and its strength against a
// beat wave's.
const QUAKE_LIFE = 8;
const QUAKE_V = 0.2;
const QUAKE_L = 1.6;
// A cut's lull: its fade in seconds, the share of its heat the sun loses under a full one, the share of their
// height the arcades lose, and the time a surge takes to clear it, in seconds.
const LULL_TAU = 3;
const LULL_COOL = 0.3;
const LULL_SINK = 0.33;
const LULL_CLEAR = 0.08;
// Under Calm and while paused, what the beats, the hits and the shifts left in flight fades over this, in seconds.
const CALM_FADE = 0.1;
// Convection clock per second in silence, the extra at full loudness, and the extra per unit of the bass
// envelope. The surface's stir follows the loudness over STIR_TAU seconds.
const CHURN = 0.35;
const CHURN_LOUD = 1.6;
const CHURN_BASS = 0.6;
const STIR_TAU = 0.8;
// Plasma clock along the loops, and the extra per unit of the bass envelope.
const FLOW = 0.22;
const FLOW_BASS = 1.2;
// Rain clock per second.
const RAIN = 0.45;
// The loops' own swing, Hz.
const SWAY_HZ = 0.42;
// Least time between two jets in seconds, their launch speed (sun radii per second) and gravity.
const JET_GAP = 0.3;
const JET_V = 0.21;
const JET_G = 0.24;
// Slots the shader holds: arcades, jets, kinks, and beat waves after the blast wave's own slot.
const REGIONS = 3;
const JET_SLOTS = 4;
const KINK_SLOTS = 3;
const WAVE_SLOTS = 5;

const FS = `${SCENE_PRELUDE}${COSMIC_COMMON}
uniform vec4 uSun;          // centre (cover widths), radius (cover widths)
uniform float uHeat;
uniform float uShine;
uniform float uChurn;
uniform float uHeave;
uniform float uStir;
uniform float uBeat;
uniform float uJump;
uniform float uSpike;
uniform float uSpark;
uniform float uFlowClk;
uniform float uRainClk;
uniform float uStream;
uniform float uHighE;
uniform float uHighClk;
uniform vec4 uRegA[3];      // limb angle, foot radius, scale (sun radii), filled height (arcade units)
uniform vec4 uRegB[3];      // sway, rain share, lean, skew of the rear sheets
uniform vec4 uRope;         // region, apex height (arcade units), half width, light
uniform vec4 uRopeB;        // twist turns, leg fade, front light, seed
uniform vec4 uJet[4];       // limb angle, tip height (sun radii), lean, light
uniform vec4 uWave[6];      // origin on the disc (sun radii), ring radius (rad), strength; the first is the blast wave
uniform vec2 uKink[3];      // height reached (arcade units), sideways shove
// -- Tunables (shader side) --
const float DIP = 0.35;           // depth of the dipole under the surface, arcade units: sets how the feet spread
const float THREADS = 4.0;        // thread cells per doubling of loop height
const float GRAINS = 76.0;      // granules per sun radius
const float SPIC = 150.0;         // spicules per radian of limb
const float SPIC_H = 0.02;        // their height, sun radii
const float SURF_L = 2.0;
const float SWELL = 0.011;        // the disc's growth under a jump of 1, as a share of its radius
const float WAVE_W = 0.025;       // a surface wave's half width, rad
const float WAVE_T = 1.0;         // its swing of the surface temperature, and of the surface light
const float WAVE_I = 0.6;
const float WAVE_PUSH = 0.016;    // its shove of the surface pattern, sun radii
// A spot group in arcade units: along the limb, radial (down from the feet), size.
const vec3 SPOTS[4] = vec3[4](vec3(-0.52, -0.12, 1.0), vec3(0.47, -0.15, 0.85), vec3(0.82, -0.26, 0.5), vec3(-0.25, -0.34, 0.4));
const float GLOW_L = 1.0;
const float CORONA_L = 1.0;
const float LOOP_L = 2.4;
const float PIN_FLOW = 0.78;      // the clump density a pinpoint needs
const float PIN_L = 1.6;          // the pinpoints' light under a high hit of 1
const float EXPOSURE = 1.25;

// The temperature ramp: deep red, red-orange, orange, gold, yellow-white, white-gold. Its luminance rises along it.
vec3 fire(float T) {
  vec3 c = mix(vec3(0.35, 0.03, 0.0), vec3(0.85, 0.18, 0.02), sat(T / 0.35));
  c = mix(c, vec3(1.0, 0.42, 0.05), sat((T - 0.35) / 0.3));
  c = mix(c, vec3(1.0, 0.66, 0.16), sat((T - 0.65) / 0.3));
  c = mix(c, vec3(1.0, 0.85, 0.42), sat((T - 0.95) / 0.3));
  return mix(c, vec3(1.0, 0.96, 0.78), sat((T - 1.25) / 0.35));
}
// Glowing plasma of a given density: thin plasma is red-orange, dense plasma gold, the densest white-hot.
vec3 plasma(float e, float T) {
  vec3 c = mix(vec3(1.0, 0.22, 0.05), vec3(1.0, 0.50, 0.11), sat(e * 0.7 + T * 0.7));
  c = mix(c, vec3(1.0, 0.88, 0.62), sat(e * 0.5 + T * 0.5 - 0.6));
  return c * e;
}
// Granulation: bright cells parted by darker lanes. Each cell centre circles on the clock t, so the cells
// shoulder each other and turn over. Returns the distance to the nearest lane, the cell's hash, and the
// distance to the cell's centre.
vec3 gran(vec2 u, float t) {
  vec2 g = floor(u), f = u - g;
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      float h = hash21(g + o), h2 = hash21(g + o + 37.0);
      vec2 c = o + 0.5 + 0.36 * vec2(cos(6.283 * h + t * (0.6 + h2)), sin(6.283 * h2 + t * (0.5 + h)));
      float dd = length(c - f);
      if (dd < d1) { d2 = d1; d1 = dd; id = h; } else if (dd < d2) d2 = dd;
    }
  }
  return vec3(d2 - d1, id, d1);
}
// Exposure on luminance with the hue kept; a channel past one spills into the others, so the hottest plasma
// over-exposes toward white-gold and keeps its texture.
vec3 tone(vec3 c) {
  float L = luma(c);
  vec3 t = c * (1.0 - exp(-L * EXPOSURE)) / max(L, 1e-5);
  vec3 over = max(t - 1.0, 0.0);
  t = min(t, 1.0) + vec3(0.0, over.r * 0.4, over.r * 0.1 + over.g * 0.45);
  return min(t, vec3(1.0));
}

// The field lines of an arcade are the circles of a buried line dipole. Returns the apex height of the line
// through x (arcade units, y up from the surface) and the signed position along it (0 at the apex, 1 at a foot).
vec2 fieldLine(vec2 x, float dip) {
  vec2 z = vec2(x.x, max(x.y, 0.0) + dip);
  float k = dot(z, z) / z.y;
  return vec2(k - dip, atan(z.x, z.y) / max(acos(sqrt(dip / k)), 1e-3));
}
// One sheet of an arcade at x: its plasma, and the pinpoints a high hit lights. The plasma is threads along the
// field, clumps flowing foot to foot, and rain.
vec2 sheet(vec2 x, float dip, float size, float rain, float seed) {
  vec2 fl = fieldLine(x, dip);
  float sg = fl.y;
  float Hn = fl.x / size;
  float tc = log2(1.0 + Hn / 0.06) * THREADS;
  float fw = fwidth(tc);
  if (x.y <= 0.0 || Hn > 2.2) return vec2(0.0);
  float s = abs(sg);
  float i = floor(tc), f = tc - i;
  float h1 = hash21(vec2(i, seed)), h2 = hash21(vec2(i, seed + 31.0)), h3 = hash21(vec2(i, seed + 67.0));
  float c = 0.5 + 0.3 * (h1 - 0.5);
  float wd = 0.09 + 0.13 * h2;
  float wa = max(wd, fw * 0.9);
  float across = exp(-pow((f - c) / wa, 2.0));
  float thread = (0.06 + 1.3 * h3 * h3 * h3) * across * wd / wa;
  float t2 = tc * 3.0 + seed;
  float i2 = floor(t2), w2 = max(0.2, fw * 2.7);
  float h4 = hash21(vec2(i2, seed + 5.0));
  float fine = h4 * h4 * exp(-pow((t2 - i2 - 0.5) / w2, 2.0)) * 0.2 / w2;
  // Clumps run along each thread from one foot to the other, on the flow clock.
  float flow = vnoise(vec2(sg * (h1 > 0.5 ? 3.0 : -3.0) + uFlowClk * (0.5 + h2), i * 7.3 + seed));
  float env = 1.0 - smoothstep(0.5, 1.1, Hn);
  float outer = 0.10 * (1.0 - smoothstep(1.0, 2.2, Hn));
  // Unresolved plasma fills the arcade, densest low in its core.
  float haze = 0.08 + 0.4 * exp(-Hn * 2.2);
  float body = (env + outer) * (thread * (0.22 + 1.6 * flow * flow) + 0.4 * fine + haze);
  // A pinpoint sits where a bright thread's clump is densest: a small share of the arcade.
  float pin = env * h3 * across * smoothstep(PIN_FLOW, PIN_FLOW + 0.12, flow);
  // Rain: drops condense near the apex and fall down both legs, faster toward the feet, a bright head and a tail.
  float q = pow(s, 0.7) * 3.0 - uRainClk * (0.6 + 0.6 * h1) + h2 * 5.0;
  float qi = floor(q), qf = q - qi;
  float on = sat((rain - hash21(vec2(qi, i + seed * 3.0))) * 6.0);
  float drop = on * smoothstep(0.15, 0.7, qf) * (1.0 - smoothstep(0.72, 0.85, qf)) * exp(-pow((f - c) / (wa * 1.2), 2.0)) * smoothstep(0.1, 0.35, s);
  body += (env + 3.0 * outer) * drop * 0.9;
  // The feet are denser: the loops stand in bright moss.
  body *= 1.0 + 0.9 * smoothstep(0.55, 1.0, s) * (1.0 - smoothstep(0.0, 0.8, Hn));
  return vec2(body, pin) * smoothstep(0.0, 0.05, x.y);
}

// The erupting rope: a band of field lines that leaves the arcade, threads wound round its axis, with a faint
// front running ahead of it. Its legs thin out as it goes.
float rope(vec2 fl) {
  float v = (fl.x - uRope.y) / uRope.z;
  float e = 0.0;
  if (abs(v) < 2.0) {
    // Two families of threads cross the band on opposite diagonals: the near and far side of the twist.
    float acc = 0.0;
    for (int k = 0; k < 2; k++) {
      float u = v * 3.2 + (k == 0 ? 3.0 : -3.0) * fl.y * uRopeB.x + uRopeB.w + float(k) * 3.7;
      float i = floor(u);
      float h = hash21(vec2(i, 5.0 + float(k)));
      float tex = 0.3 + 1.3 * vnoise(vec2(fl.y * 6.0 - uFlowClk * 0.5, i * 3.1 + float(k) * 9.0));
      acc += (0.12 + 0.88 * h * h) * exp(-pow((u - i - 0.5) / 0.2, 2.0)) * tex * (k == 0 ? 1.0 : 0.55);
    }
    e = exp(-v * v * 1.3) * (0.14 + 1.3 * acc);
  }
  float front = uRopeB.z * exp(-pow((fl.x - uRope.y * 1.55) / (uRope.z * 1.6), 2.0)) * 0.25;
  float legs = 1.0 - uRopeB.y * smoothstep(0.3, 0.95, abs(fl.y));
  return (e + front) * legs * uRope.w;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  float hu = hushAt(fc);
  vec2 cc = coverCenter() / uDpr;
  float w = uCover.z / uDpr;
  // A beat swells the whole sun about its centre and adds to its light.
  float bt = min(uBeat, 1.2);
  vec2 d = ((p - cc) / w - uSun.xy) / (uSun.z * (1.0 + SWELL * uJump));
  float r = length(d);
  float psi = atan(d.y, d.x);
  float px = 1.0 / (w * uSun.z);            // one CSS pixel in sun radii
  float hgt = r - 1.0, hp = max(hgt, 0.0);
  float outside = smoothstep(1.0 - px, 1.0 + px, r);
  float shine = 0.8 + 0.25 * uShine + 0.05 * bt;
  float T = uHeat;
  float mu = sqrt(max(1.0 - r * r, 0.0));

  // The arcades: three sheets each. The front one stands on the disc, the middle one at the limb, and the rear
  // one shows only against space.
  float flare = 0.0, plage = 0.0, umb = 0.0, pen = 0.0, stri = 0.0, ar = 0.0;
  vec2 loops = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    vec4 A = uRegA[i], B = uRegB[i];
    float dpsi = psi - A.x;
    ar += exp(-pow(dpsi / 0.2, 2.0));
    vec2 x = vec2(dpsi * r, r - A.y) / A.z;
    float ext = float(i) == uRope.x ? uRope.y * 1.6 : 0.0;
    if (abs(x.x) > 2.0 + ext * 0.6 || x.y > 2.9 + ext || x.y < -0.6) continue;
    float seed = float(i) * 13.0;
    // The arcade is rooted in an active region: bright plage, and a group of spots under its feet. Each spot is
    // a round patch of the sphere, so it flattens toward the limb; its penumbra is striated.
    plage += exp(-pow(x.x / 0.95, 2.0) - pow((x.y + 0.2) / 0.4, 2.0));
    if (x.y < 0.3 && r < 1.0) {
      for (int s = 0; s < 4; s++) {
        vec3 S = SPOTS[s];
        vec2 q = vec2(x.x - S.x, (x.y - S.y) / max(mu, 0.12)) / S.z;
        float a = atan(q.y, q.x);
        float ds = length(q) * (1.0 + 0.16 * sin(a * 3.0 + seed + float(s)) + 0.08 * sin(a * 7.0 + seed));
        umb = max(umb, 1.0 - smoothstep(0.085, 0.125, ds));
        float pe = 1.0 - smoothstep(0.2, 0.27, ds);
        if (pe > pen) { pen = pe; stri = 0.5 + 0.5 * sin(a * 24.0 + seed * 3.0 + 6.0 * ds); }
      }
    }
    // A slow warp bends the field off its perfect circles; the feet stay put.
    vec2 wv = vec2(vnoise(x * 1.8 + vec2(seed, uChurn * 0.04)), vnoise(x * 1.8 + vec2(seed + 9.0, -uChurn * 0.03))) - 0.5;
    x += wv * 0.3 * smoothstep(0.0, 0.4, x.y);
    // A beat shakes the feet: a kink runs up the field and bends each loop as it passes. The rope has left the
    // arcade, so the kinks do not reach it.
    float lean = (B.z + B.x) * x.y;
    if (float(i) == uRope.x && uRope.w > 0.0) flare = rope(fieldLine(vec2(x.x + lean, x.y), DIP)) * smoothstep(0.0, 0.05, x.y);
    for (int k = 0; k < 3; k++) x.x += uKink[k].y * exp(-pow((x.y - uKink[k].x) / 0.22, 2.0)) * sat(x.y * 4.0);
    vec2 e = sheet(vec2(x.x + lean, x.y), DIP, A.w, B.y, seed + 1.0);
    float lift = (1.0 - A.y) / A.z;
    // The sheets differ in width and lean, so their loops cross instead of nesting.
    vec2 x1 = vec2((x.x + B.w) * 0.8 + (B.z * 0.7 + B.x * 0.8 - 0.22) * x.y, x.y - lift);
    e += 0.75 * sheet(x1, DIP * 1.5, A.w * 0.92, B.y, seed + 4.0);
    vec2 x2 = vec2((x.x + 2.0 * B.w) * 1.25 + (B.z * 0.4 + B.x * 0.6 + 0.25) * x.y, x.y);
    e += 0.6 * sheet(x2, DIP * 0.7, A.w * 0.85, B.y, seed + 7.0) * outside;
    loops += e;
  }
  ar = sat(ar);

  vec3 col = vec3(0.004, 0.003, 0.008);
  if (r > 1.0 - px * 2.0) {
    // Space: a trace of the cover's colours, faint stars far from the sun.
    float neb = vnoise(p * 0.003 + vec2(4.0, 1.0)) * vnoise(p * 0.0021 + vec2(1.0, 6.0));
    col += mix(uPal[1], uPal[0], 0.5) * neb * 0.05;
    col += vec3(0.85, 0.9, 1.0) * stars(p, 38.0, 0.45, 1.0) * 0.4 * smoothstep(0.12, 0.5, hgt) * (1.0 - hu);
    // Corona: a bright inner rim, broad plumes, and fine rays that stream outward on their own clock. Its reach
    // follows the heat.
    float reach = 0.7 + 0.7 * T;
    float rays = vnoise(vec2(psi * 9.0, 2.0 + uStream * 0.03));
    float fineR = vnoise(vec2(psi * 64.0, log(hp + 0.04) * 3.0 - uStream));
    float streak = vnoise(vec2(psi * 27.0 + 5.0, log(hp + 0.1) * 1.5 - uStream * 0.4));
    float plume = (0.25 + 1.9 * rays * rays * rays) * (1.0 + 0.8 * ar);
    float cor = 0.3 * exp(-hp / 0.012) + plume * (0.5 * exp(-hp / (0.08 * reach)) + 0.13 * exp(-hp / (0.3 * reach)) + 0.01)
      * (0.3 + 0.7 * fineR + 0.7 * streak);
    // Spicules: a fringe of fine jets along the limb. Each breathes on its own cycle; the highs make them lean,
    // and a bass hit throws them taller.
    float sx = psi * SPIC + hp / SPIC_H * 0.5 * sin(uHighClk * 0.6 + psi * 23.0) * (0.3 + uHighE);
    float sid = floor(sx);
    float sh = hash21(vec2(sid, 3.0));
    float hh = SPIC_H * (0.35 + 0.65 * sh) * (0.75 + 0.25 * sin(uHighClk * (0.5 + sh) + sh * 40.0)) * (1.0 + 0.6 * ar)
      * (1.0 + 0.8 * uSpike);
    float spic = exp(-pow((sx - sid - 0.5) / 0.3, 2.0)) * (1.0 - smoothstep(0.2 * hh, hh, hp));
    // Jets: a beat throws a thin column of plasma up from the limb; it rises, slows and falls back.
    float jets = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 J = uJet[i];
      float lat = (psi - J.x) * r - J.z * hp * (1.0 + 4.0 * hp);
      float al = hp / max(J.y, 1e-4);
      jets += J.w * exp(-pow(lat / (0.004 + 0.05 * hp), 2.0)) * (1.0 - smoothstep(0.7, 1.0, al)) * (0.45 + 0.55 * al);
    }
    vec3 chromo = vec3(1.0, 0.30, 0.08) * (1.2 * exp(-hp / 0.005) + 1.4 * spic);
    vec3 corCol = mix(vec3(1.0, 0.30, 0.10), vec3(1.0, 0.60, 0.28), exp(-hp / 0.12)) * (0.48 + 0.85 * T);
    // The sun lights the space round it: a glow off the limb, gold close in and red far out, hotter with the heat.
    // A beat brightens only the gold rim on the limb: the red glow further out holds its light.
    float glow = 0.5 * exp(-hp / 0.02) * (1.0 + 0.6 * bt) + 0.18 * exp(-hp / (0.09 * reach)) + 0.04 * exp(-hp / (0.35 * reach));
    vec3 glowCol = mix(vec3(1.0, 0.24, 0.05), vec3(1.0, 0.74, 0.38), exp(-hp / 0.06)) * (0.38 + 1.1 * T);
    col += (glowCol * glow * GLOW_L + corCol * cor * CORONA_L + chromo + plasma(jets * 2.4, T)) * shine * outside * (1.0 - 0.6 * hu);
  }

  if (r < 1.0 + px * 2.0) {
    // The surface, on the sphere: an even chart of the visible hemisphere, so cells foreshorten toward the limb.
    vec2 uv = d * (2.0 / (1.0 + mu));
    // Waves: a beat's, and the blast wave of an eruption. Each is a ring that runs out over the sphere from its
    // origin and shoves the surface pattern ahead of it. Its light is zero-mean: a brighter front, a darker
    // wake. A ring fades toward the limb before it aliases.
    vec3 n3 = vec3(d, mu);
    float front = 0.0;
    for (int i = 0; i < 6; i++) {
      vec4 W = uWave[i];
      if (W.w <= 0.0) continue;
      vec3 o3 = vec3(W.xy, sqrt(max(1.0 - dot(W.xy, W.xy), 0.0)));
      float wx = (acos(clamp(dot(n3, o3), -1.0, 1.0)) - W.z) / WAVE_W;
      float wg = W.w * exp(-wx * wx);
      uv += normalize(d - W.xy + 1e-4) * wg * WAVE_PUSH;
      front += wg * wx;
    }
    front *= smoothstep(0.04, 0.3, mu);
    // Convection: large eddies carry the small ones, on the churn clock; the loudness and the bass deepen the
    // stirring.
    vec2 big = vec2(vnoise(uv * 3.1 + vec2(0.0, uChurn * 0.12)), vnoise(uv * 3.1 + vec2(5.2, -uChurn * 0.1))) - 0.5;
    // The large eddies carry everything smaller: the flow they set shears and streams the finer patterns, so
    // nothing tiles. Mid eddies ride on it and stir at their own scale.
    vec2 flow = uv + big * (0.07 + 0.08 * uHeave + 0.05 * uStir);
    vec2 mid = vec2(vnoise(flow * 9.0 + vec2(uChurn * 0.3, 3.0)), vnoise(flow * 9.0 + vec2(9.0, -uChurn * 0.25))) - 0.5;
    flow += mid * (0.024 + 0.02 * uStir);
    // Supergranules: a slow network of brighter seams. Turbulence: mottling stretched along the flow.
    float sn = vnoise(flow * 7.0 + vec2(2.0, uChurn * 0.08));
    float network = 1.0 - abs(2.0 * sn - 1.0);
    network *= network;
    float turb = vnoise(flow * 15.0 + mid * 2.5 + vec2(uChurn * 0.22, 7.0));
    // Granules: the finest layer, bright cells parted by darker lanes. Their contrast varies over the disc and
    // drowns in light where the disc is hottest; toward the limb they compress and fade before they alias.
    vec3 g = gran(flow * GRAINS, uChurn * 0.8);
    float detail = smoothstep(0.1, 0.45, mu);
    float lane = 1.0 - smoothstep(0.0, 0.42, g.x);
    float cell = 0.5 + 0.5 * sin(g.y * 40.0 + uChurn * (0.5 + g.y));
    float gc = detail * (0.2 + 0.9 * turb) * mix(1.0, 0.45, mu * mu * (0.4 + 0.6 * T));
    float fine = (0.08 * (cell - 0.5) + 0.26 * (0.4 - g.z) - 0.22 * lane) * gc;
    // Filaments: dark ropes of cool plasma hanging over the disc, snaking along the seams of the large eddies,
    // frayed by the turbulence and broken where the mid eddies cut them.
    float fil = (1.0 - smoothstep(0.012, 0.05, abs(big.y + (turb - 0.5) * 0.07))) * smoothstep(0.05, 0.2, big.x)
      * smoothstep(-0.2, 0.1, mid.x) * smoothstep(0.12, 0.4, mu);
    float pl = sat(plage) * (0.25 + 1.5 * turb * (0.4 + network));
    // Heat sets the temperature of the whole disc; the limb is cooler: yellow-white at the centre through gold
    // to orange and red at the edge. The stir widens the gap between the hot cells and the seams round them, so
    // a white-hot disc keeps its texture. A beat warms the disc and lifts the limb toward the centre's light.
    float boil = fine + 0.25 * (network - 0.3) + 0.45 * (turb - 0.5) + 0.4 * big.x;
    float Ts = 0.77 + T * (1.3 - 0.57 * T) - (1.0 - mu) * (1.0 - mu) * (1.0 - 0.4 * bt) + boil * (1.0 + 1.2 * uStir)
      + 0.4 * pl - 0.5 * fil + WAVE_T * front + 0.06 * bt;
    float inten = mix(0.18 + 0.82 * pow(mu, 0.75), 1.0, 0.2 * bt) * mix(1.0, 0.56 + 0.88 * turb, 0.5 + 0.5 * uStir)
      * (1.0 + 0.4 * pl) * (1.0 - 0.35 * fil) * (1.0 + WAVE_I * front);
    // The spots: a dark umbra inside a cooler penumbra combed by bright and dark fibrils.
    float near = smoothstep(0.03, 0.2, mu);
    float penT = pen * (1.0 - umb) * near;
    Ts -= penT * (0.25 + 0.35 * stri);
    Ts = mix(Ts, 0.25 * Ts, umb * near);
    inten *= (1.0 - 0.3 * penT) * (1.0 - 0.65 * umb * near);
    // In the Player the disc runs under the transport: it cools below the seek bar so the controls read.
    float shade = uAmbient < 0.5 ? 1.0 - smoothstep(uFloor - 30.0 * uDpr, uFloor + 110.0 * uDpr, fc.y) : 0.0;
    Ts -= 0.32 * shade;
    // Under the title the disc is a cooler region with a wide ragged edge that follows the eddies, not a patch.
    // The hush is sampled round the pixel to widen its feather.
    vec2 ha = vec2(80.0 * uDpr, 0.0);
    float hw = max(hu, (hu + hushAt(fc + ha) + hushAt(fc - ha) + hushAt(fc + ha.yx) + hushAt(fc - ha.yx)) / 5.0);
    float hq =smoothstep(0.0, 1.0, hw + 0.7 * big.x * sin(3.14159 * hw));
    Ts = mix(Ts, min(Ts, 0.66 + 0.2 * (Ts - 1.0)), hq);
    inten *= (1.0 - 0.35 * shade) * (1.0 - 0.42 * hq);
    vec3 surf = fire(Ts) * SURF_L * inten;
    col = mix(col, surf * shine, 1.0 - outside);
  }

  // The rope is hotter than the arcades: gold where it is thin and white-gold where it is dense, never red, so
  // a body that large holds no saturated red to flicker. A high hit lights the pinpoints white-gold.
  vec3 hot = mix(vec3(1.0, 0.62, 0.22), vec3(1.0, 0.9, 0.66), sat(flare * 0.8)) * flare;
  hot += vec3(1.0, 0.9, 0.66) * (PIN_L * uSpark * loops.y);
  col += (plasma(loops.x * LOOP_L, T) + hot * LOOP_L) * shine * (1.0 - 0.7 * hu);

  col = tone(col);
  col = mix(col, uGround, hu * 0.15);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/**
 * One arcade's moving state: how far it has regrown since a snap, the height the heat gives it, the share of
 * that height it stands at (less after a snap and under a cut's lull), its rain and the rain after a snap.
 */
interface Arcade {
  fill: number;
  size: number;
  stand: number;
  rain: number;
  wet: number;
}

/**
 * An erupting rope: the arcade it left, its age and life in seconds, its starting apex height, its twist seed
 * and its power, 0..1.
 */
interface Rope {
  k: number;
  age: number;
  life: number;
  h0: number;
  seed: number;
  power: number;
}

/** The blast wave over the surface: its age in seconds, its origin on the disc in sun radii and its power. */
interface Quake {
  age: number;
  o: [number, number];
  power: number;
}

/** A jet off the limb: its age, limb angle, launch speed under a beat of weight 1, lean and its beat's weight. */
interface Jet {
  age: number;
  psi: number;
  v: number;
  lean: number;
  w: number;
}

/** A kink running up the arcades: its age and its signed sideways shove. */
interface Kink {
  age: number;
  a: number;
}

/** A beat's wave over the surface: its age in seconds and its beat's weight. */
interface Wave {
  age: number;
  a: number;
}

/** A beat still being weighed: its weight so far, and what it launched. */
interface Landing {
  w: number;
  wave: Wave;
  jet: Jet | null;
  kink: Kink | null;
}

/** The scene's moving state, and the uniforms the last step packed from it. */
export interface SolarFlareState {
  primed: boolean;
  heat: number;
  // The heat without a cut's lull: what the arcades' height follows.
  warm: number;
  // The loudness as the surface's stir: 0 under Calm and while paused.
  stir: number;
  // How much of what is in flight shows: 1 while the music drives the scene, 0 under Calm and while paused.
  wake: number;
  // The beat envelope, the weight it holds and its slower twin for the sun's shape; the bass and high hit
  // envelopes.
  beat: number;
  beatHeld: number;
  jump: number;
  spike: number;
  spark: number;
  // A cut's lull as the heat reads it, eased, and the value it eases toward, which the arcades' sink follows.
  lull: number;
  lullHeld: number;
  // The run of full-weight beats in a loud passage, fading over RUN_TAU.
  run: number;
  // A surge waiting for the loudness to arrive: its power and its age in seconds.
  armed: { power: number; age: number } | null;
  landing: Landing | null;
  shine: number;
  clock: number;
  churn: number;
  flow: number;
  rainClk: number;
  stream: number;
  highClk: number;
  bass: number;
  // How deep the bass stirs the surface: the bass envelope, held to the drive.
  heave: number;
  mid: number;
  high: number;
  swayPh: number;
  regs: Arcade[];
  rope: Rope | null;
  // The rope that leaves once the one in flight has cleared.
  nextRope: Rope | null;
  quake: Quake | null;
  lastErupt: number;
  nextErupt: number;
  jets: Jet[];
  lastJet: number;
  jetN: number;
  kinks: Kink[];
  lastKink: number;
  kinkSide: number;
  waves: Wave[];
  // Per arcade: limb angle, foot radius, scale and filled height; then sway, rain, lean and skew.
  regA: Float32Array;
  regB: Float32Array;
  // The rope: region, apex height, half width and light; then twist, leg fade, front light and seed.
  ropeA: Float32Array;
  ropeB: Float32Array;
  // Per jet slot: limb angle, tip height, lean and light.
  jet: Float32Array;
  // Per wave slot, the blast wave first: origin, ring radius and strength.
  wave: Float32Array;
  // Per kink slot: height reached and sideways shove.
  kink: Float32Array;
}

export function createSolarFlareState(): SolarFlareState {
  return {
    primed: false,
    heat: REST_HEAT,
    warm: REST_HEAT,
    stir: 0,
    wake: 1,
    beat: 0,
    beatHeld: 0,
    jump: 0,
    spike: 0,
    spark: 0,
    lull: 0,
    lullHeld: 0,
    run: 0,
    armed: null,
    landing: null,
    shine: 0.4,
    clock: 0,
    churn: 0,
    flow: 0,
    rainClk: 0,
    stream: 0,
    highClk: 0,
    bass: 0,
    heave: 0,
    mid: 0,
    high: 0,
    swayPh: 0,
    regs: Array.from({ length: REGIONS }, () => ({ fill: 1, size: 0.8, stand: 1, rain: 0.3, wet: 0 })),
    rope: null,
    nextRope: null,
    quake: null,
    lastErupt: -99,
    nextErupt: 0,
    jets: [],
    lastJet: -9,
    jetN: 0,
    kinks: [],
    lastKink: -9,
    kinkSide: 1,
    waves: [],
    regA: new Float32Array(REGIONS * 4),
    regB: new Float32Array(REGIONS * 4),
    ropeA: Float32Array.of(-1, 1, 1, 0),
    ropeB: new Float32Array(4),
    jet: new Float32Array(JET_SLOTS * 4),
    wave: new Float32Array((WAVE_SLOTS + 1) * 4),
    kink: new Float32Array(KINK_SLOTS * 2),
  };
}

const DEG = Math.PI / 180;

/** A fixed hash of a jet's count and a channel, 0..1, so the jets land the same way on every run. */
function jetHash(n: number, a: number): number {
  const x = Math.sin(n * 127.1 + a * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A jet's launch speed in sun radii per second: faster under a heavier beat. */
function jetSpeed(j: Jet): number {
  return j.v * (0.3 + 0.85 * j.w);
}

/** The point of the disc at a limb angle (deg) and a radius, in sun radii. */
function onDisc(deg: number, radius: number): [number, number] {
  return [radius * Math.cos(deg * DEG), radius * Math.sin(deg * DEG)];
}

/**
 * Snaps the next arcade with a power of 0..1: a rope leaves it, the arcade drops and rains, and a blast wave
 * starts at its feet. The rope is sized by the arcade's regrown height, whatever a cut has sunk it to. A rope
 * already in flight clears first.
 */
function erupt(st: SolarFlareState, comp: Composition, power: number): void {
  st.lastErupt = st.clock;
  st.run = 0;
  const k = st.nextErupt;
  st.nextErupt = k === 0 ? 1 : 0;
  const h0 = st.regs[k].size * st.regs[k].fill * (0.44 + 0.2 * power);
  const rope: Rope = { k, age: 0, life: ROPE_LIFE, h0, seed: st.clock % 6.283, power };
  if (st.rope) {
    st.rope.life = Math.min(st.rope.life, st.rope.age + ROPE_CLEAR);
    st.nextRope = rope;
  } else st.rope = rope;
  st.quake = { age: 0, o: onDisc(comp.REG[k][0], comp.REG[k][1]), power };
  st.regs[k].fill = 0.62 - 0.2 * power;
  st.regs[k].wet = power;
}

/**
 * Advances the state by dt for the Player or ambient composition. Under Calm and while paused the beats, the
 * hits and the shifts are ignored, what they left in flight fades out within half a second, the surface keeps
 * its idle churn and nothing erupts. Under Calm the heat still follows the loudness, as `shine` follows the
 * level; paused, it holds the still's.
 */
export function stepSolarFlare(st: SolarFlareState, s: VisualSignal, dt: number, playing: boolean, ambient: boolean): void {
  const live = playing && s.drive > 0;
  const drive = live ? s.drive : 0;
  const bassM = live ? s.bassMotion : 0;
  const midM = live ? s.midMotion : 0;
  const highM = live ? s.highMotion : 0;
  const weight = live ? Math.min(BEAT_TOP, s.beatWeight) : 0;
  const gain = Math.min(1.6, drive);
  st.clock += dt;
  const comp = ambient ? AMBIENT : PLAYER;
  // Once the music stops driving the scene, the envelopes and everything in flight fade, and what was in flight
  // is then dropped.
  const fade = live ? 1 : Math.exp(-dt / CALM_FADE);
  st.wake = easeEnvelope(st.wake, live ? 1 : 0, dt, CALM_FADE);
  if (!live && st.wake < 0.01) {
    st.rope = null;
    st.nextRope = null;
    st.quake = null;
    st.waves = [];
    st.kinks = [];
    st.jets = [];
  }
  // A cut starts a lull that fades on its own; a surge clears it and arms an eruption.
  st.lullHeld *= Math.exp(-dt / LULL_TAU);
  if (live && s.cut > 0) st.lullHeld = Math.min(1, s.cut);
  if (live && s.surge > 0) {
    st.lullHeld = 0;
    st.armed = { power: Math.min(1, s.surge), age: 0 };
  }
  if (!live) {
    st.lullHeld = 0;
    st.armed = null;
    st.landing = null;
  }
  st.lull = easeEnvelope(st.lull, st.lullHeld, dt, st.lullHeld > st.lull ? 0.3 : LULL_CLEAR);
  // Heat: the loudness, less the lull. A scene that opens mid-song starts at that passage's heat.
  const warm = clamp01(HEAT_FLOOR + HEAT_GAIN * (playing ? s.loudness : REST_LOUD));
  const heat = warm * (1 - LULL_COOL * st.lull);
  if (!st.primed) {
    st.heat = heat;
    st.warm = warm;
    st.stir = live ? s.loudness : 0;
    st.primed = true;
  }
  st.heat = easeEnvelope(st.heat, heat, dt, HEAT_TAU);
  st.warm = easeEnvelope(st.warm, warm, dt, HEAT_TAU);
  st.stir = easeEnvelope(st.stir, live ? s.loudness : 0, dt, STIR_TAU);
  st.shine = easeEnvelope(st.shine, clamp01(s.level * 1.6), dt, 1.0);
  // The beat envelope takes the weight as it lands and lets it go; the hit envelopes do the same for a hit.
  st.beatHeld = Math.max(st.beatHeld * Math.exp(-dt / BEAT_FALL), weight) * fade;
  st.beat = easeEnvelope(st.beat, st.beatHeld, dt, BEAT_RISE) * fade;
  st.jump = easeEnvelope(st.jump, st.beatHeld, dt, JUMP_RISE) * fade;
  const hitFall = Math.exp(-dt / HIT_FALL) * fade;
  st.spike = Math.max(st.spike * hitFall, live ? Math.min(BEAT_TOP, s.bassHit) : 0);
  st.spark = Math.max(st.spark * hitFall, live ? Math.min(BEAT_TOP, s.highHit) : 0);
  // Loudness and bass: convection. Bass: the flow along the loops. Mids: the loops sway. Highs: spicules and
  // the corona's rays.
  st.bass = easeEnvelope(st.bass, Math.min(1.3, bassM), dt, 0.22);
  st.mid = easeEnvelope(st.mid, midM, dt, 0.4);
  st.high = easeEnvelope(st.high, highM, dt, 0.3);
  st.heave = st.bass * Math.min(1, drive);
  st.churn += dt * (CHURN + CHURN_LOUD * st.stir * st.stir + CHURN_BASS * st.bass);
  st.flow += dt * (FLOW + FLOW_BASS * st.bass);
  st.rainClk += dt * RAIN;
  st.stream += dt * (0.12 + 0.5 * st.high + STREAM_BEAT * st.beat);
  st.highClk += dt * (1.0 + 5.0 * st.high);
  st.swayPh += dt * 2 * Math.PI * SWAY_HZ * (1 + 0.3 * st.mid);
  // Beat: a wave over the surface, a jet off the limb and a kink up every arcade, alternating sides. Each is
  // launched on the beat's first frame and takes the weight the beat ends on.
  for (const w of st.waves) w.age += dt;
  st.waves = st.waves.filter((w) => w.age < WAVE_LIFE);
  for (const j of st.jets) j.age += dt;
  st.jets = st.jets.filter((j) => j.age < (2 * jetSpeed(j)) / JET_G);
  for (const k of st.kinks) k.age += dt;
  st.kinks = st.kinks.filter((k) => k.age < KINK_LIFE);
  if (weight > 0) {
    if (!st.landing) {
      const L: Landing = { w: 0, wave: { age: 0, a: 0 }, jet: null, kink: null };
      if (st.waves.length === WAVE_SLOTS) st.waves.shift();
      st.waves.push(L.wave);
      if (st.clock - st.lastJet >= JET_GAP) {
        st.lastJet = st.clock;
        if (st.jets.length === JET_SLOTS) st.jets.shift();
        const n = st.jetN++;
        const sec = comp.JET[jetHash(n, 1) < 0.72 ? 0 : 1];
        L.jet = {
          age: 0,
          psi: (sec[0] + (sec[1] - sec[0]) * jetHash(n, 3)) * DEG,
          v: JET_V * (0.75 + 0.5 * jetHash(n, 2)),
          lean: (jetHash(n, 4) - 0.5) * 0.9,
          w: 0,
        };
        st.jets.push(L.jet);
      }
      if (st.clock - st.lastKink >= KINK_GAP) {
        st.lastKink = st.clock;
        if (st.kinks.length === KINK_SLOTS) st.kinks.shift();
        st.kinkSide = -st.kinkSide;
        L.kink = { age: 0, a: 0 };
        st.kinks.push(L.kink);
      }
      st.landing = L;
    }
    const L = st.landing;
    L.w = Math.max(L.w, weight);
    L.wave.a = L.w;
    if (L.jet) L.jet.w = L.w;
    if (L.kink) L.kink.a = st.kinkSide * KINK_SHOVE * L.w;
  } else if (st.landing) {
    if (st.landing.w >= RUN_WEIGHT * drive && s.loudness >= RUN_LOUD) st.run += 1;
    st.landing = null;
  }
  // Eruption: a surge snaps an arcade once its passage is loud, sized by the surge. A long run of full-weight
  // beats in a loud passage snaps one too, at most once per RUN_REST.
  st.run *= Math.exp(-dt / RUN_TAU);
  if (st.armed) {
    st.armed.age += dt;
    if (s.loudness >= FLARE_LOUD) {
      erupt(st, comp, st.armed.power);
      st.armed = null;
    } else if (st.armed.age > FLARE_WAIT) st.armed = null;
  }
  if (st.run >= RUN_FULL && st.clock - st.lastErupt >= RUN_REST) erupt(st, comp, RUN_POWER);
  comp.REG.forEach((R, k) => {
    const g = st.regs[k];
    g.fill = easeEnvelope(g.fill, 1, dt, live ? 7 : CALM_FADE);
    const breathe = 1 + 0.04 * Math.sin(st.clock * 0.31 + k * 2.1);
    const target = (0.58 + 0.48 * st.warm) * breathe;
    g.size = easeEnvelope(g.size, target, dt, target < g.size ? 0.55 : 1.8);
    // The arcade drops over half a second after a snap or a cut, and stands back up as it regrows, as the lull
    // fades, or within LULL_CLEAR once the lull is cleared.
    const stand = g.fill * (1 - LULL_SINK * st.lullHeld);
    g.stand = easeEnvelope(g.stand, stand, dt, stand < g.stand ? 0.55 : LULL_CLEAR);
    // After an eruption the arcade rains hard for a while; the rain comes on over a second, never at once. A
    // cool passage rains more than a hot one. Once the music stops driving the scene, an eruption's rain stops
    // with the rest of it.
    const stopping = !live && g.wet > 0.01;
    g.wet = easeEnvelope(g.wet, 0, dt, live ? 5 : CALM_FADE);
    const rain = Math.max(g.wet, 0.22 + 0.4 * clamp01((REST_HEAT - st.heat) / 0.3));
    g.rain = easeEnvelope(g.rain, rain, dt, rain > g.rain ? 1.2 : stopping ? CALM_FADE : 6);
    const sway = (0.04 + 0.2 * st.mid * Math.min(1, gain)) * Math.sin(st.swayPh + k * 1.9);
    st.regA.set([R[0] * DEG, R[1], R[2], g.size * g.stand * (1 + BEAT_LIFT * st.jump)], k * 4);
    st.regB.set([sway, g.rain, R[3], R[4]], k * 4);
  });
  st.ropeA.set([-1, 1, 1, 0]);
  st.ropeB.fill(0);
  if (st.rope) {
    const E = st.rope;
    E.age += dt;
    if (E.age >= E.life) {
      st.rope = st.nextRope;
      st.nextRope = null;
    } else {
      const e = E.age / ROPE_LIFE;
      const grow = 1 + 0.07 * E.age + 0.022 * Math.pow(E.age, 2.4);
      const fin = Math.min(1, E.age / 0.5);
      const fout = Math.min(1 - Math.max(0, (e - 0.6) / 0.4) ** 2, clamp01((E.life - E.age) / ROPE_CLEAR));
      const light = (0.6 + 0.4 * E.power) * fin * fin * (3 - 2 * fin) * fout * st.wake;
      st.ropeA.set([E.k, E.h0 * grow, (0.16 + 0.08 * E.power) * E.h0 * Math.pow(grow, 0.8), light / Math.pow(grow, 0.4)]);
      st.ropeB.set([1.8 / Math.sqrt(grow), clamp01(E.age / 3), clamp01(E.age / 1.5), E.seed]);
    }
  }
  st.wave.fill(0);
  if (st.quake) {
    const Q = st.quake;
    Q.age += dt;
    if (Q.age > QUAKE_LIFE) st.quake = null;
    else {
      const strength = QUAKE_L * (0.5 + 0.5 * Q.power) * Math.min(1, Q.age / 0.4) * Math.exp(-Q.age / 2.5) * st.wake;
      st.wave.set([Q.o[0], Q.o[1], 0.04 + QUAKE_V * Q.age, strength], 0);
    }
  }
  // A beat's wave leaves the surface under the composition's wave arcade and is gone within its life, so the
  // rings of successive beats stay a clear gap apart.
  const o = onDisc(comp.REG[comp.WAVE][0], WAVE_R);
  st.waves.forEach((w, i) => {
    const fin = Math.min(1, w.age / 0.1);
    const fout = 1 - (w.age / WAVE_LIFE) ** 2;
    st.wave.set([o[0], o[1], 0.03 + WAVE_V * w.age, w.a * fin * fout * st.wake], (i + 1) * 4);
  });
  st.kink.fill(0);
  st.kinks.forEach((k, i) => {
    const fin = Math.min(1, k.age / 0.25);
    const fout = 1 - k.age / KINK_LIFE;
    st.kink.set([0.1 + KINK_V * k.age, k.a * fin * fout * fout * st.wake], i * 2);
  });
  st.jet.fill(0);
  st.jets.forEach((j, i) => {
    const v = jetSpeed(j);
    const tip = v * j.age - 0.5 * JET_G * j.age * j.age;
    const fin = Math.min(1, j.age / 0.12);
    const fout = Math.min(1, ((2 * v) / JET_G - j.age) / 0.25);
    st.jet.set([j.psi, Math.max(tip, 1e-4), j.lean, fin * fout * Math.min(1, j.w) * st.wake], i * 4);
  });
}

const SOLAR_FLARE_PROGRAM: ProgramSource = { name: "solar-flare", vs: FS_VS, fs: FS };
/** The programs solar flare compiles, for warming the shader cache ahead of the stage. */
export const SOLAR_FLARE_PROGRAMS: readonly ProgramSource[] = [SOLAR_FLARE_PROGRAM];

export function createSolarFlare(kit: Kit): Candidate {
  const { gl } = kit;
  const st = createSolarFlareState();
  const sun: Rect = [0, 0, 0, 0];

  return {
    mode: "image",
    bloom: 0.6,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      stepSolarFlare(st, f.sig, f.dt, f.playing, f.ambient);
      const comp = f.ambient ? AMBIENT : PLAYER;
      const p = kit.program(SOLAR_FLARE_PROGRAM);
      setScene(kit, p, f, 0, null, null);
      sun[0] = comp.C[0];
      sun[1] = comp.C[1];
      sun[2] = comp.R;
      kit.set4(p, "uSun", sun);
      kit.set1(p, "uHeat", st.heat);
      kit.set1(p, "uShine", st.shine);
      kit.set1(p, "uChurn", st.churn);
      kit.set1(p, "uHeave", st.heave);
      kit.set1(p, "uStir", st.stir);
      kit.set1(p, "uBeat", st.beat);
      kit.set1(p, "uJump", st.jump);
      kit.set1(p, "uSpike", st.spike);
      kit.set1(p, "uSpark", st.spark);
      kit.set1(p, "uFlowClk", st.flow);
      kit.set1(p, "uRainClk", st.rainClk);
      kit.set1(p, "uStream", st.stream);
      kit.set1(p, "uHighE", st.high);
      kit.set1(p, "uHighClk", st.highClk);
      gl.uniform4fv(kit.uniform(p, "uRegA"), st.regA);
      gl.uniform4fv(kit.uniform(p, "uRegB"), st.regB);
      gl.uniform4fv(kit.uniform(p, "uRope"), st.ropeA);
      gl.uniform4fv(kit.uniform(p, "uRopeB"), st.ropeB);
      gl.uniform4fv(kit.uniform(p, "uJet"), st.jet);
      gl.uniform4fv(kit.uniform(p, "uWave"), st.wave);
      gl.uniform2fv(kit.uniform(p, "uKink"), st.kink);
      kit.drawQuad();
    },
    dispose() {},
  };
}
