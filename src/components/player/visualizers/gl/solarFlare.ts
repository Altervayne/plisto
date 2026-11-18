/*
 * Solar Flare: the sun up close, a ball rising from the lower left behind the cover, its limb a steep diagonal arc
 * against black space, with magnetic arcades standing on the limb. The photosphere is incandescent and is the light
 * of the picture: a limb-darkened disc, yellow-white at the centre through gold to orange and red at the edge,
 * stirred at several scales, crossed by dark filaments, with spot groups and plage under the arcades. Every loop is
 * a field line of a buried dipole, so the plasma is drawn in field-line coordinates: threads follow the field,
 * clumps flow along it, rain falls back down it. The stage bloom lets the disc and the loops bleed light into
 * space. Dark-only: the scene has no light look.
 *
 * Energy (the eased level plus the swell) against the song's own slow mean sets the heat. The bass runs the
 * convection and the flow along the loops, the mids sway the loops, the highs lean the spicules and stream the
 * corona. A beat sends a kink up every arcade and throws a jet from the limb. A drop on a loaded field, or a strong
 * kick on a fully loaded one, snaps an arcade: a twisted rope leaves it, the arcade drops and regrows, and a blast
 * wave runs over the surface. A scene opened mid-song starts at that passage's heat.
 *
 * Photosensitivity: brightness follows only the eased level (shine) and the eased heat. The envelopes and beats
 * move mass: flows, sway, churn, jets that rise and fall back. An eruption's light is spread over its growth.
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
};
// The song's mean starts no lower than this, so a quiet intro reads as cool, and no higher than this.
const PRIOR = 0.45;
const PRIME_TOP = 0.62;
// The song's own mean, in seconds.
const SLOW_TAU = 60;
// The gap between energy and mean that reaches the end of the range.
const REL_SPAN = 0.4;
const HEAT_TAU = 2.0;
// Heat at the song's own mean, and its reach either side: Balanced, Lively.
const HEAT_REST = 0.45;
const HEAT_REACH: readonly [number, number] = [0.42, 0.55];
// The drive above which the Lively reach applies.
const LIVELY_DRIVE = 1.3;
// The field loads toward a cap set by the heat over this, in seconds.
const STRESS_TAU = 8;
// Least stress for a bass jump to snap the arcade, and the jump (swell against its one-second trail).
const SNAP_JUMP = 0.7;
const JUMP = 0.05;
// A fully loaded arcade snaps on the next strong kick.
const SNAP_KICK = 1.0;
// Least time between two kinks in seconds, their speed (arcade units per second) and life.
const KINK_GAP = 0.45;
const KINK_V = 1.1;
const KINK_LIFE = 2.6;
// Least time between two eruptions, and a rope's life, in seconds.
const ERUPT_GAP = 9;
const ROPE_LIFE = 8.5;
// The blast wave's run over the surface in seconds, and its speed in rad per second.
const QUAKE_LIFE = 8;
const QUAKE_V = 0.2;
// Convection clock per second, and the extra per unit of the bass envelope.
const CHURN = 0.5;
const CHURN_BASS = 1.1;
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
// Slots the shader holds: arcades, jets, kinks.
const REGIONS = 3;
const JET_SLOTS = 4;
const KINK_SLOTS = 3;

const FS = `${SCENE_PRELUDE}${COSMIC_COMMON}
uniform vec4 uSun;          // centre (cover widths), radius (cover widths)
uniform float uHeat;
uniform float uShine;
uniform float uChurn;
uniform float uHeave;
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
uniform vec4 uQuake;        // origin on the disc (sun radii), ring radius (rad), strength
uniform vec2 uKink[3];      // height reached (arcade units), sideways shove
// -- Tunables (shader side) --
const float DIP = 0.35;           // depth of the dipole under the surface, arcade units: sets how the feet spread
const float THREADS = 4.0;        // thread cells per doubling of loop height
const float GRAINS = 76.0;      // granules per sun radius
const float SPIC = 150.0;         // spicules per radian of limb
const float SPIC_H = 0.02;        // their height, sun radii
const float SURF_L = 2.0;
// A spot group in arcade units: along the limb, radial (down from the feet), size.
const vec3 SPOTS[4] = vec3[4](vec3(-0.52, -0.12, 1.0), vec3(0.47, -0.15, 0.85), vec3(0.82, -0.26, 0.5), vec3(-0.25, -0.34, 0.4));
const float GLOW_L = 1.0;
const float CORONA_L = 1.0;
const float LOOP_L = 2.4;
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

// One sheet of an arcade at x (arcade units, y up from the surface). The field lines are the circles of a
// buried line dipole; fl returns the apex height of the line through x and the signed position along it
// (0 at the apex, 1 at a foot). The light is threads along the field, clumps flowing foot to foot, and rain.
float sheet(vec2 x, float dip, float size, float rain, float seed, out vec2 fl) {
  vec2 z = vec2(x.x, max(x.y, 0.0) + dip);
  float k = dot(z, z) / z.y;
  float sg = atan(z.x, z.y) / max(acos(sqrt(dip / k)), 1e-3);
  fl = vec2(k - dip, sg);
  float Hn = fl.x / size;
  float tc = log2(1.0 + Hn / 0.06) * THREADS;
  float fw = fwidth(tc);
  if (x.y <= 0.0 || Hn > 2.2) return 0.0;
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
  // Rain: drops condense near the apex and fall down both legs, faster toward the feet, a bright head and a tail.
  float q = pow(s, 0.7) * 3.0 - uRainClk * (0.6 + 0.6 * h1) + h2 * 5.0;
  float qi = floor(q), qf = q - qi;
  float on = sat((rain - hash21(vec2(qi, i + seed * 3.0))) * 6.0);
  float drop = on * smoothstep(0.15, 0.7, qf) * (1.0 - smoothstep(0.72, 0.85, qf)) * exp(-pow((f - c) / (wa * 1.2), 2.0)) * smoothstep(0.1, 0.35, s);
  body += (env + 3.0 * outer) * drop * 0.9;
  // The feet are denser: the loops stand in bright moss.
  body *= 1.0 + 0.9 * smoothstep(0.55, 1.0, s) * (1.0 - smoothstep(0.0, 0.8, Hn));
  return body * smoothstep(0.0, 0.05, x.y);
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
  vec2 d = ((p - cc) / w - uSun.xy) / uSun.z;
  float r = length(d);
  float psi = atan(d.y, d.x);
  float px = 1.0 / (w * uSun.z);            // one CSS pixel in sun radii
  float hgt = r - 1.0, hp = max(hgt, 0.0);
  float outside = smoothstep(1.0 - px, 1.0 + px, r);
  float shine = 0.8 + 0.25 * uShine;
  float T = uHeat;
  float mu = sqrt(max(1.0 - r * r, 0.0));

  // The arcades: three sheets each. The front one stands on the disc, the middle one at the limb, and the rear
  // one shows only against space.
  float loops = 0.0, plage = 0.0, umb = 0.0, pen = 0.0, stri = 0.0, ar = 0.0;
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
    // A beat shakes the feet: a kink runs up the field and bends each loop as it passes.
    for (int k = 0; k < 3; k++) x.x += uKink[k].y * exp(-pow((x.y - uKink[k].x) / 0.22, 2.0)) * sat(x.y * 4.0);
    vec2 fl, fl2;
    vec2 x0 = vec2(x.x + (B.z + B.x) * x.y, x.y);
    float e = sheet(x0, DIP, A.w, B.y, seed + 1.0, fl);
    if (float(i) == uRope.x && uRope.w > 0.0) e += rope(fl) * smoothstep(0.0, 0.05, x0.y);
    float lift = (1.0 - A.y) / A.z;
    // The sheets differ in width and lean, so their loops cross instead of nesting.
    vec2 x1 = vec2((x.x + B.w) * 0.8 + (B.z * 0.7 + B.x * 0.8 - 0.22) * x.y, x.y - lift);
    e += 0.75 * sheet(x1, DIP * 1.5, A.w * 0.92, B.y, seed + 4.0, fl2);
    vec2 x2 = vec2((x.x + 2.0 * B.w) * 1.25 + (B.z * 0.4 + B.x * 0.6 + 0.25) * x.y, x.y);
    e += 0.6 * sheet(x2, DIP * 0.7, A.w * 0.85, B.y, seed + 7.0, fl2) * outside;
    loops += e;
  }
  ar = sat(ar);

  vec3 col = vec3(0.004, 0.003, 0.008);
  if (r > 1.0 - px * 2.0) {
    // Space: a trace of the cover's colours, faint stars far from the sun.
    float neb = vnoise(p * 0.003 + vec2(4.0, 1.0)) * vnoise(p * 0.0021 + vec2(1.0, 6.0));
    col += mix(uPal[1], uPal[0], 0.5) * neb * 0.05;
    col += vec3(0.85, 0.9, 1.0) * stars(p, 38.0, 0.45, 1.0) * 0.4 * smoothstep(0.12, 0.5, hgt) * (1.0 - hu);
    // Corona: a bright inner rim, broad plumes, and fine rays that stream outward on their own clock.
    float rays = vnoise(vec2(psi * 9.0, 2.0 + uStream * 0.03));
    float fineR = vnoise(vec2(psi * 64.0, log(hp + 0.04) * 3.0 - uStream));
    float streak = vnoise(vec2(psi * 27.0 + 5.0, log(hp + 0.1) * 1.5 - uStream * 0.4));
    float plume = (0.25 + 1.9 * rays * rays * rays) * (1.0 + 0.8 * ar);
    float cor = 0.3 * exp(-hp / 0.012) + plume * (0.5 * exp(-hp / 0.08) + 0.13 * exp(-hp / 0.3) + 0.01) * (0.3 + 0.7 * fineR + 0.7 * streak);
    // Spicules: a fringe of fine jets along the limb. Each breathes on its own cycle; the highs make them lean.
    float sx = psi * SPIC + hp / SPIC_H * 0.5 * sin(uHighClk * 0.6 + psi * 23.0) * (0.3 + uHighE);
    float sid = floor(sx);
    float sh = hash21(vec2(sid, 3.0));
    float hh = SPIC_H * (0.35 + 0.65 * sh) * (0.75 + 0.25 * sin(uHighClk * (0.5 + sh) + sh * 40.0)) * (1.0 + 0.6 * ar);
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
    vec3 corCol = mix(vec3(1.0, 0.30, 0.10), vec3(1.0, 0.60, 0.28), exp(-hp / 0.12)) * (0.6 + 0.6 * T);
    // The sun lights the space round it: a glow off the limb, gold close in and red far out, hotter with the heat.
    float glow = 0.5 * exp(-hp / 0.02) + 0.18 * exp(-hp / 0.09) + 0.04 * exp(-hp / 0.35);
    vec3 glowCol = mix(vec3(1.0, 0.24, 0.05), vec3(1.0, 0.74, 0.38), exp(-hp / 0.06)) * (0.5 + 0.9 * T);
    col += (glowCol * glow * GLOW_L + corCol * cor * CORONA_L + chromo + plasma(jets * 2.4, T)) * shine * outside * (1.0 - 0.6 * hu);
  }

  if (r < 1.0 + px * 2.0) {
    // The surface, on the sphere: an even chart of the visible hemisphere, so cells foreshorten toward the limb.
    vec2 uv = d * (2.0 / (1.0 + mu));
    // The blast wave of an eruption: a ring that runs out over the sphere from the arcade's feet and shoves the
    // surface pattern ahead of it. Its light is zero-mean: a brighter front, a darker wake.
    vec3 o3 = vec3(uQuake.xy, sqrt(max(1.0 - dot(uQuake.xy, uQuake.xy), 0.0)));
    float qx = (acos(clamp(dot(vec3(d, mu), o3), -1.0, 1.0)) - uQuake.z) / 0.04;
    float qg = uQuake.w * exp(-qx * qx);
    uv += normalize(d - uQuake.xy + 1e-4) * qg * 0.014;
    // Convection: slow large eddies carry the small ones, on the churn clock; the bass deepens the stirring.
    vec2 big = vec2(vnoise(uv * 3.1 + vec2(0.0, uChurn * 0.05)), vnoise(uv * 3.1 + vec2(5.2, -uChurn * 0.04))) - 0.5;
    // The large eddies carry everything smaller: the flow they set shears and streams the finer patterns, so
    // nothing tiles. Mid eddies ride on it and stir at their own scale.
    vec2 flow = uv + big * (0.07 + 0.08 * uHeave);
    vec2 mid = vec2(vnoise(flow * 9.0 + vec2(uChurn * 0.12, 3.0)), vnoise(flow * 9.0 + vec2(9.0, -uChurn * 0.1))) - 0.5;
    flow += mid * 0.024;
    // Supergranules: a slow network of brighter seams. Turbulence: mottling stretched along the flow.
    float sn = vnoise(flow * 7.0 + vec2(2.0, uChurn * 0.03));
    float network = 1.0 - abs(2.0 * sn - 1.0);
    network *= network;
    float turb = vnoise(flow * 15.0 + mid * 2.5 + vec2(uChurn * 0.09, 7.0));
    // Granules: the finest layer, bright cells parted by darker lanes. Their contrast varies over the disc and
    // drowns in light where the disc is hottest; toward the limb they compress and fade before they alias.
    vec3 g = gran(flow * GRAINS, uChurn * 1.2);
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
    // to orange and red at the edge.
    float Ts = 1.0 + 0.5 * T - (1.0 - mu) * (1.0 - mu) + fine + 0.25 * (network - 0.3) + 0.45 * (turb - 0.5) + 0.4 * big.x
      + 0.4 * pl - 0.5 * fil + 0.12 * qg * qx;
    float inten = (0.18 + 0.82 * pow(mu, 0.75)) * (0.78 + 0.44 * turb) * (1.0 + 0.4 * pl) * (1.0 - 0.35 * fil);
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

  col += plasma(loops * LOOP_L, T) * shine * (1.0 - 0.7 * hu);

  col = tone(col);
  col = mix(col, uGround, hu * 0.15);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** One arcade's moving state: how far it has regrown since a snap, its height, its rain and the rain after a snap. */
interface Arcade {
  fill: number;
  size: number;
  rain: number;
  wet: number;
}

/** An erupting rope: the arcade it left, its age in seconds, its starting apex height and its twist seed. */
interface Rope {
  k: number;
  age: number;
  h0: number;
  seed: number;
}

/** The blast wave over the surface: its age in seconds and its origin on the disc in sun radii. */
interface Quake {
  age: number;
  o: [number, number];
}

/** A jet off the limb: its age, limb angle, launch speed, lean and life. */
interface Jet {
  age: number;
  psi: number;
  v: number;
  lean: number;
  life: number;
}

/** A kink running up the arcades: its age and its signed sideways shove. */
interface Kink {
  age: number;
  a: number;
}

/** The scene's moving state, and the uniforms the last step packed from it. */
export interface SolarFlareState {
  primed: boolean;
  // The song's own mean energy, the swell's one-second trail, and the eased energy against the mean.
  slow: number;
  sw1: number;
  relE: number;
  heat: number;
  stress: number;
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
  quake: Quake | null;
  lastErupt: number;
  nextErupt: number;
  jets: Jet[];
  lastJet: number;
  jetN: number;
  kinks: Kink[];
  lastKink: number;
  kinkSide: number;
  // Per arcade: limb angle, foot radius, scale and filled height; then sway, rain, lean and skew.
  regA: Float32Array;
  regB: Float32Array;
  // The rope: region, apex height, half width and light; then twist, leg fade, front light and seed.
  ropeA: Float32Array;
  ropeB: Float32Array;
  // Per jet slot: limb angle, tip height, lean and light.
  jet: Float32Array;
  // The blast wave: origin, ring radius and strength.
  quakeU: Float32Array;
  // Per kink slot: height reached and sideways shove.
  kink: Float32Array;
}

export function createSolarFlareState(): SolarFlareState {
  return {
    primed: false,
    slow: 0,
    sw1: 0,
    relE: 0,
    heat: HEAT_REST,
    stress: 0.6,
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
    regs: Array.from({ length: REGIONS }, () => ({ fill: 1, size: 0.8, rain: 0.3, wet: 0 })),
    rope: null,
    quake: null,
    lastErupt: -99,
    nextErupt: 0,
    jets: [],
    lastJet: -9,
    jetN: 0,
    kinks: [],
    lastKink: -9,
    kinkSide: 1,
    regA: new Float32Array(REGIONS * 4),
    regB: new Float32Array(REGIONS * 4),
    ropeA: Float32Array.of(-1, 1, 1, 0),
    ropeB: new Float32Array(4),
    jet: new Float32Array(JET_SLOTS * 4),
    quakeU: new Float32Array(4),
    kink: new Float32Array(KINK_SLOTS * 2),
  };
}

const DEG = Math.PI / 180;

/** A fixed hash of a jet's count and a channel, 0..1, so the jets land the same way on every run. */
function jetHash(n: number, a: number): number {
  const x = Math.sin(n * 127.1 + a * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Advances the state by dt for the Player or ambient composition. Under Calm and while paused the motion
 * envelopes and beats are ignored and nothing erupts; the heat rests and only the eased level, through `shine`,
 * sets the light.
 */
export function stepSolarFlare(st: SolarFlareState, s: VisualSignal, dt: number, playing: boolean, ambient: boolean): void {
  const live = playing && s.drive > 0;
  const drive = live ? s.drive : 0;
  const bassM = live ? s.bassMotion : 0;
  const midM = live ? s.midMotion : 0;
  const highM = live ? s.highMotion : 0;
  const beat = live ? s.beat : 0;
  const gain = Math.min(1.6, drive);
  st.clock += dt;
  const comp = ambient ? AMBIENT : PLAYER;
  // Energy against the song's own mean. Only the eased level and swell are read.
  const energy = s.level + s.swell;
  const relOf = () => (drive === 0 ? 0 : Math.max(-1, Math.min(1, (energy - st.slow) / REL_SPAN)));
  // A scene that opens mid-song starts at that passage's heat: the mean is primed inside a plausible band.
  if (!st.primed) {
    st.slow = Math.min(Math.max(energy, PRIOR), PRIME_TOP);
    st.sw1 = s.swell;
    st.relE = relOf();
    st.primed = true;
  }
  // A pause drops the level to the resting arch; the mean holds through it, so a resume finds the song's own heat.
  // Calm keeps tracking, so a switch to a livelier setting starts from a true mean.
  if (playing) st.slow = easeEnvelope(st.slow, energy, dt, SLOW_TAU);
  st.sw1 = easeEnvelope(st.sw1, s.swell, dt, 1);
  const rel = relOf();
  st.relE = easeEnvelope(st.relE, rel, dt, HEAT_TAU);
  st.heat = clamp01(HEAT_REST + (drive > LIVELY_DRIVE ? HEAT_REACH[1] : HEAT_REACH[0]) * st.relE);
  st.shine = easeEnvelope(st.shine, clamp01(s.level * 1.6), dt, 1.0);
  // Bass: convection and the flow along the loops. Mids: the loops sway. Highs: spicules and the corona's rays.
  st.bass = easeEnvelope(st.bass, Math.min(1.3, bassM), dt, 0.22);
  st.mid = easeEnvelope(st.mid, midM, dt, 0.4);
  st.high = easeEnvelope(st.high, highM, dt, 0.3);
  st.heave = st.bass * Math.min(1, drive);
  st.churn += dt * (CHURN + CHURN_BASS * st.bass);
  st.flow += dt * (FLOW + FLOW_BASS * st.bass);
  st.rainClk += dt * RAIN;
  st.stream += dt * (0.12 + 0.5 * st.high);
  st.highClk += dt * (1.0 + 5.0 * st.high);
  st.swayPh += dt * 2 * Math.PI * SWAY_HZ * (1 + 0.3 * st.mid);
  // The field loads toward a cap set by the heat; Calm holds it part loaded.
  const cap = drive === 0 ? 0.7 : 0.25 + (0.45 + 0.55 * st.relE);
  st.stress = easeEnvelope(st.stress, cap, dt, STRESS_TAU);
  // Eruption: a loaded arcade snaps when the bass jumps (a drop landing) or, fully loaded, on the next strong kick.
  const since = st.clock - st.lastErupt;
  const jump = st.stress >= SNAP_JUMP && s.swell - st.sw1 > JUMP;
  const kick = st.stress >= SNAP_KICK && bassM > 0.55 * drive;
  if (drive > 0 && since > ERUPT_GAP && (jump || kick)) {
    st.lastErupt = st.clock;
    const k = st.nextErupt;
    st.nextErupt = k === 0 ? 1 : 0;
    st.rope = { k, age: 0, h0: st.regs[k].size * 0.62, seed: st.clock % 6.283 };
    const R = comp.REG[k];
    const a = R[0] * DEG;
    st.quake = { age: 0, o: [R[1] * Math.cos(a), R[1] * Math.sin(a)] };
    st.regs[k].fill = 0.42;
    st.regs[k].wet = 1.0;
    st.stress = 0.25;
  }
  comp.REG.forEach((R, k) => {
    const g = st.regs[k];
    g.fill = easeEnvelope(g.fill, 1, dt, 7);
    const breathe = 1 + 0.04 * Math.sin(st.clock * 0.31 + k * 2.1);
    const target = (0.62 + 0.42 * (0.45 + 0.55 * st.relE) + 0.25 * Math.max(0, st.stress - 0.7)) * g.fill * breathe;
    g.size = easeEnvelope(g.size, target, dt, target < g.size ? 0.55 : 1.8);
    // After an eruption the arcade rains hard for a while; the rain comes on over a second, never at once.
    g.wet = easeEnvelope(g.wet, 0, dt, 5);
    const rain = Math.max(g.wet, drive === 0 ? 0.3 : 0.22 + 0.4 * Math.max(0, -st.relE));
    g.rain = easeEnvelope(g.rain, rain, dt, rain > g.rain ? 1.2 : 6);
    const sway = (0.04 + 0.2 * st.mid * Math.min(1, gain)) * Math.sin(st.swayPh + k * 1.9);
    st.regA.set([R[0] * DEG, R[1], R[2], g.size], k * 4);
    st.regB.set([sway, g.rain, R[3], R[4]], k * 4);
  });
  st.ropeA.set([-1, 1, 1, 0]);
  st.ropeB.fill(0);
  if (st.rope) {
    const E = st.rope;
    E.age += dt;
    const e = E.age / ROPE_LIFE;
    if (e >= 1) st.rope = null;
    else {
      const grow = 1 + 0.07 * E.age + 0.022 * Math.pow(E.age, 2.4);
      const fin = Math.min(1, E.age / 0.5);
      const fout = 1 - Math.max(0, (e - 0.6) / 0.4) ** 2;
      st.ropeA.set([E.k, E.h0 * grow, 0.22 * E.h0 * Math.pow(grow, 0.8), (fin * fin * (3 - 2 * fin) * fout) / Math.pow(grow, 0.4)]);
      st.ropeB.set([1.8 / Math.sqrt(grow), clamp01(E.age / 3), clamp01(E.age / 1.5), E.seed]);
    }
  }
  st.quakeU.fill(0);
  if (st.quake) {
    const Q = st.quake;
    Q.age += dt;
    if (Q.age > QUAKE_LIFE) st.quake = null;
    else st.quakeU.set([Q.o[0], Q.o[1], 0.04 + QUAKE_V * Q.age, Math.min(1, Q.age / 0.4) * Math.exp(-Q.age / 2.5)]);
  }
  // Beat: a jet rises from the limb and falls back.
  for (const j of st.jets) j.age += dt;
  st.jets = st.jets.filter((j) => j.age < j.life);
  if (beat > 0 && st.clock - st.lastJet >= JET_GAP) {
    st.lastJet = st.clock;
    if (st.jets.length === JET_SLOTS) st.jets.shift();
    const n = st.jetN++;
    const sec = comp.JET[jetHash(n, 1) < 0.72 ? 0 : 1];
    const v = JET_V * (0.6 + 0.4 * Math.min(1.5, beat)) * (0.75 + 0.5 * jetHash(n, 2));
    st.jets.push({
      age: 0,
      psi: (sec[0] + (sec[1] - sec[0]) * jetHash(n, 3)) * DEG,
      v,
      lean: (jetHash(n, 4) - 0.5) * 0.9,
      life: (2 * v) / JET_G,
    });
  }
  // Beat: a kink runs up every arcade, alternating sides, and dies away as it climbs.
  for (const k of st.kinks) k.age += dt;
  st.kinks = st.kinks.filter((k) => k.age < KINK_LIFE);
  if (beat > 0 && st.clock - st.lastKink >= KINK_GAP) {
    st.lastKink = st.clock;
    if (st.kinks.length === KINK_SLOTS) st.kinks.shift();
    st.kinkSide = -st.kinkSide;
    st.kinks.push({ age: 0, a: st.kinkSide * 0.07 * Math.min(1.5, beat) });
  }
  st.kink.fill(0);
  st.kinks.forEach((k, i) => {
    const fin = Math.min(1, k.age / 0.15);
    const fout = 1 - k.age / KINK_LIFE;
    st.kink.set([0.1 + KINK_V * k.age, k.a * fin * fout * fout], i * 2);
  });
  st.jet.fill(0);
  st.jets.forEach((j, i) => {
    const tip = j.v * j.age - 0.5 * JET_G * j.age * j.age;
    const fin = Math.min(1, j.age / 0.12);
    const fout = Math.min(1, (j.life - j.age) / 0.25);
    st.jet.set([j.psi, Math.max(tip, 1e-4), j.lean, fin * fout], i * 4);
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
      gl.uniform4fv(kit.uniform(p, "uQuake"), st.quakeU);
      gl.uniform2fv(kit.uniform(p, "uKink"), st.kink);
      kit.drawQuad();
    },
    dispose() {},
  };
}
