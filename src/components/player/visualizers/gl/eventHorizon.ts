/*
 * Event Horizon: a close portrait of one black hole. Every pixel traces its light ray through the curved space
 * (the Schwarzschild orbit equation, stepped in the ray's own plane), so the far side of the disc rises over the
 * shadow and its underside wraps beneath it. In ambient the hole stands beside the cover; in the Player it rises
 * behind the cover, larger than the tile. Dark-only: the scene has no light look.
 *
 * The hottest gas is written past full white, so the bloom's bright-pass turns it into glare in its own colour
 * while the cool end of the disc stays under the threshold.
 *
 * Photosensitivity: the rule limits change, not level, so the disc may blaze. Brightness follows only the eased
 * level (the heat and the density, which are the level seen partly against its own mean, and uShine for the sky
 * and the ring); it rises over about two seconds and falls more slowly. Bass rocks the disc, mids wind its spiral
 * arms, highs ride the inner orbits and a beat drops a clump of gas that spirals in: each heats or thickens the
 * gas in one place and cools or thins its own orbit by as much, so they move light and add none. Calm and paused
 * hold a steady mid intensity and a slow orbit with no reaction.
 */

// -- Local Imports --
import { clamp01, createRng } from "./cozy";
import { COSMIC_COMMON } from "./cosmic";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit, ProgramSource, Rect } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

// The song's own mean of the eased level, s; the mean starts no lower and no higher than the prime band.
const SLOW_TAU = 20;
const PRIME_LOW = 0.28;
const PRIME_HIGH = 0.4;
// The gap between level and mean that reaches the end of the range.
const REL_SPAN = 0.1;
// The eased level that reads as nothing and as everything, and the same for the eased bass.
const LEVEL_LOW = 0.14;
const LEVEL_SPAN = 0.34;
const WEIGHT_LOW = 0.06;
const WEIGHT_SPAN = 0.4;
// The level's own share of the intensity: a long loud passage settles at 0.8, not 0.5.
const I_LEVEL = 0.6;
// The shine is 1 - exp(-SHINE_K * level).
const SHINE_K = 3.2;
// The heat, the density and the shine rise over HEAT_TAU, s, and fall over COOL_TAU.
export const HEAT_TAU = 1.8;
export const COOL_TAU = 2.6;
// Calm and paused hold this intensity and this pace.
export const CALM_I = 0.4;
export const CALM_PACE = 0.55;
// Gas pace at the bottom, the mean and the top of the range.
export const PACE_LIVELY: readonly [number, number, number] = [0.45, 1.0, 2.2];
const PACE_BALANCED: readonly [number, number, number] = [0.65, 1.0, 1.7];
// The drive above which the Lively range applies.
const LIVELY_DRIVE = 1.3;
// Extra pace per unit of the mid envelope.
export const MID_PACE = 0.25;
// Share of the pace lost with no bass weight at all.
const PACE_LIGHT = 0.24;
// The camera plunges over CAM_TAU_IN, s, and backs out over CAM_TAU_OUT.
const CAM_TAU_IN = 2.2;
const CAM_TAU_OUT = 5.0;
// Camera distance, in masses, and elevation over the disc, rad: backed out, then plunged in.
const D_FAR = 64;
const D_NEAR = 50;
const EL_HIGH = 0.44;
const EL_LOW = 0.3;
// Disc tilt, rad, at rest and per unit of the bass envelope; its precession, rad/s, the same.
export const TILT_BASE = 0.02;
export const TILT_BASS = 0.1;
const PREC_BASE = 0.07;
const PREC_BASS = 0.55;
// Spiral-arm depth at rest and per unit of the mid envelope, and the arms' turn rate, rad per gas-second.
export const WAVE_BASE = 0.16;
export const WAVE_MID = 0.5;
const WAVE_PACE = 0.5;
// The camera's slow orbit, rad per gas-second: the lensed sky slides round the hole.
const SKY_PACE = 0.014;
// Least time between two beat clumps, s; a clump gathers over CLUMP_RISE, s, and falls from the outer disc to
// the inner edge over CLUMP_FALL gas-seconds; each starts CLUMP_TURN rad round from the last.
const CLUMP_GAP = 0.45;
const CLUMP_RISE = 0.45;
export const CLUMP_FALL = 2.8;
const CLUMP_TURN = 2.4;
// Beat clumps alive at once; the shader's uClump holds this many.
export const CLUMP_SLOTS = 4;
// Disc edges, masses, and the Keplerian rate scale: must match R_IN, R_OUT and KEP in the shader.
export const R_IN = 3.4;
export const R_OUT = 30;
const KEP = 15;

/**
 * One framing, each pair backed out then plunged in: the hole's centre from the cover's centre (x, y up) and its
 * shadow radius, in cover widths; then the camera roll, rad, and the side the gas comes at the camera on (1 left,
 * -1 right).
 */
interface Framing {
  at: readonly [readonly [number, number], readonly [number, number]];
  r: readonly [number, number];
  roll: number;
  side: number;
}

// Player: the shadow rises as a dome behind the tile's top edge, and the plunge grows it until the ring runs all
// round the tile, the label and the title. Ambient: the hole stands beside the tile with the title in its shadow,
// bright side away from the tile.
const FRAME_PLAYER: Framing = { at: [[0, 0.3], [0, 0.05]], r: [0.5, 0.72], roll: -0.2, side: 1 };
const FRAME_AMBIENT: Framing = { at: [[1.12, -0.12], [1.12, -0.12]], r: [0.5, 0.5], roll: 0.14, side: -1 };

const FS = `${SCENE_PRELUDE}${COSMIC_COMMON}
uniform vec4 uHole;
uniform float uMirror;
uniform float uD;
uniform float uEl;
uniform float uSpin;
uniform float uTilt;
uniform float uPrec;
uniform float uHeat;
uniform float uDens;
uniform float uWave;
uniform float uWavePh;
uniform float uHot;
uniform vec3 uHotA;
uniform float uShine;
uniform float uSky;
uniform vec4 uClump[4];
// -- Tunables (shader side) --
const float B_C = 5.196152;       // critical impact parameter: the shadow's edge, in masses
const float D_REF = 60.0;         // camera distance at which the shadow has the framing's radius
const float R_IN = 3.4;           // disc edges, masses
const float R_OUT = 30.0;
const float R_FALL = 2.2;         // the plunging gas is drawn down to here
const float TWIST = 1.5;          // the plunge's spiral: rad of orbit per mass fallen
const float FALL_FADE = 0.5;      // the plunging strands cool at this rate per mass, on top of the hole's redshift
const float KEP = 15.0;           // Keplerian rate scale: rad per gas-second at r = 1
const float LANE = 5.5;           // lanes are laid on LANE * r^0.6, so they widen outward
const float FLOW_P = 17.0;       // the gas texture renews over this many gas-seconds, so the shear never winds up;
                                  // a quicker renewal swings the picture's brightness as one pattern gives way to the next
const float PHASE_K = 0.4;        // the renewal's lag per unit of r^0.6
const float BOLD_IN = 8.0;        // the gas goes from fine strands to bold blobs, knots and dust between these radii
const float BOLD_OUT = 15.0;
const float INFALL = 0.25;        // the gas drifts inward by this share of its radius over one renewal
const float SPIRAL_K = 4.2;       // pitch of the two spiral arms
const float NOD = 0.4;            // share of the tilt that nods at the camera; the rest rolls about the line of sight,
                                  // which rocks the picture without changing how much disc faces the camera
const float BETA_K = 0.92;        // gas speed scale for the Doppler shift
const float HEAT_LOW = 1.1;       // temperature of the inner edge at no intensity and at full; 1 is white-hot
const float HEAT_HIGH = 1.5;
const float T_FALL = 0.5;         // the temperature falls outward as r to minus this
const float RIM_COOL = 0.3;       // and by this share more from RIM_FROM out to the rim
const float RIM_FROM = 11.0;
const float DOPPLER = 1.25;       // the seen temperature goes as this power of the Doppler factor
const float LANE_COOL = 0.6;      // temperature of the thinnest gas and of the thickest, against the orbit's own
const float KNOT_HOT = 1.12;
const float INNER_COOL = 0.8;     // the thinnest gas at the inner edge
const float DUST_W = 0.065;       // half-width of a dust lane, in the knot noise's own units
const float DUST_COOL = 0.45;     // how far a dust lane cools and darkens the gas behind it
const float DUST_DARK = 0.6;
const vec2 BLUE = vec2(0.34, 0.13); // red and green given up by gas hotter than white
const float OVER = 1.5;           // how far past full white the hottest gas goes; the bloom's glare is made of it
const float BODY = 0.38;          // gas left between the lanes at no density
const float FILL = 0.5;           // how far the inner disc closes over its lanes at full density
const float ARM_HEAT = 0.2;       // share of a spiral arm's depth that shows as heat
const float HUSH_COOL = 0.5;      // under the label and the title the gas cools and dims by these shares
const float HUSH_DIM = 0.35;
const float HUSH_WIDE = 80.0;     // the cooled region's halo: this many px further out, at this share
const float HUSH_HALO = 0.2;
const float HOT_TAKE = 0.7;       // a hot spot's gas comes out of its own orbit: 1.2 * sqrt(pi) / TAU over the mean gas
const float HOT_HEAT = 0.3;       // a hot spot is this much hotter than its orbit, which cools by the spot's mean
const float HOT_MEAN = 0.282;     // sqrt(pi) / TAU: a spot's mean round its orbit, per unit of lane
const float GLINT_MEAN = 0.109;   // mean of the ring's glint pattern, taken back out so glints add no light
const float RING_PX = 1.15;       // photon ring core half-width, device pixels
const float RING_LOW = 2.5;       // the ring's intensity at no heat and at full
const float RING_HIGH = 7.0;
const float GLOW = 0.16;          // the scattered light just outside the ring
const float EXPOSURE = 1.15;      // for the sky, the ring and the scattered light; the disc is display-referred
const int STEPS = 24;
const float H_NEAR = 0.34;        // ray step, in orbit angle: near the hole, far from it, and at most DU_MAX change of 1/r
const float H_FAR = 0.6;
const float DU_MAX = 0.07;

float wrapA(float a) { return a - TAU * floor(a / TAU + 0.5); }

// Value noise periodic in y with an integer period, so a texture closes round the hole or round the sky.
float pnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, per), y1 = mod(i.y + 1.0, per);
  return mix(mix(hash21(vec2(i.x, y0)), hash21(vec2(i.x + 1.0, y0)), u.x),
             mix(hash21(vec2(i.x, y1)), hash21(vec2(i.x + 1.0, y1)), u.x), u.y);
}

// Turbulent gas on the lane coordinate r (see LANE): blobs a few times longer than wide when a layer is born,
// which the orbit's shear then draws out into arcs. Octaves fade out where a pixel covers more than their cell
// (fr in lanes per pixel across, fy in turns per pixel along). bold: 0 near the inner edge, where the gas orbits
// fast and wide blobs would swing the picture's brightness, so the fine octaves carry it there; 1 far out.
float streaks(float r, float y, float seed, float fr, float fy, float bold, out float knot) {
  float lod1 = 1.0 - smoothstep(0.25, 0.6, max(fr * 1.3, fy * 24.0));
  float lod2 = 1.0 - smoothstep(0.25, 0.6, max(fr * 3.4, fy * 64.0));
  // One slow sample kinks the gas, gathers it into knots and, along its contours, lays the dust lanes.
  knot = pnoise(vec2(r * 0.24 + seed, y * 7.0), 7.0) - 0.5;
  r += knot * 7.0;
  y += knot * 0.05;
  float n = 0.5 + (pnoise(vec2(r * 0.45 + seed, y * 9.0 + seed * 3.0), 9.0) - 0.5) * mix(0.3, 1.0, bold);
  if (lod1 > 0.0) n += (pnoise(vec2(r * 1.3 + seed * 1.7, y * 24.0), 24.0) - 0.5) * mix(0.9, 0.5, bold) * lod1;
  if (lod2 > 0.0) n += (pnoise(vec2(r * 3.4 + seed * 2.3, y * 64.0), 64.0) - 0.5) * mix(0.6, 0.3, bold) * lod2;
  return n;
}

// Incandescence at a temperature, 1 being white-hot: deep red, orange, gold, yellow-white, white, then blue-white
// and past full white. The cool end stays under the bloom's bright-pass, so only hot gas glares and the glare
// keeps its colour.
vec3 fire(float T) {
  // Each channel's rise is eased in: s * (0.7 + 0.3 s) is close to s^1.2 and costs no pow.
  float r = sat((T - 0.1) / 0.45), g = sat((T - 0.36) / 0.6), b = sat((T - 0.62) / 0.45);
  r *= 0.7 + 0.3 * r;
  g *= 0.7 + 0.3 * g;
  b *= sqrt(b);
  float hot = sat((T - 1.08) / 0.35), over = sat((T - 1.45) / 0.55);
  return vec3(r * (1.0 - BLUE.x * hot), g * (1.0 - BLUE.y * hot), b) * (1.0 + OVER * over * over);
}

// One layer's light: the temperature follows the gas, so lanes are redder and knots whiter, and a dust lane cools
// and darkens what lies behind it. Near the inner edge (bold 0) the gas is more even: it orbits fast there, and
// bold knots would swing the picture's brightness.
vec3 gasLight(float T, float t, float dust, float bold) {
  float tN = smoothstep(0.2, 0.8, t);
  T *= mix(mix(INNER_COOL, 1.06, tN), mix(LANE_COOL, KNOT_HOT, tN), bold) * (1.0 - DUST_COOL * dust);
  return fire(max(T, 0.0)) * (1.0 - DUST_DARK * dust);
}

// The disc at a point P on its plane, seen along photon direction k (towards the camera). Returns its light in
// rgb, premultiplied, and its opacity in a. fr, fy: the pixel's footprint across and along the orbit. hush: how
// far the text asks the gas to cool here.
vec4 discAt(vec3 P, vec3 n, vec3 bx, vec3 bz, vec3 k, float fr, float fy, float hush) {
  float rr = length(P);
  // Inside the inner edge the gas plunges: the edge's own pattern is dragged inward along a tightening spiral.
  float fall = max(R_IN - rr, 0.0);
  float r = max(rr, R_IN);
  float psi = atan(dot(P, bz), dot(P, bx)) - TWIST * fall;
  float x = R_IN / r;
  float om = KEP / (r * sqrt(r));
  float p06 = pow(r, 0.6);
  // Two layers of gas in its own frame, sheared by the Keplerian rate and drifting inward, renewed in turn. The
  // renewal runs out of step from ring to ring, so the disc never renews all at once.
  float ph = uSpin / FLOW_P - p06 * PHASE_K;
  float fa = fract(ph), fb = fract(ph + 0.5);
  float wa = 1.0 - abs(2.0 * fa - 1.0), wb = 1.0 - wa;
  float ya = (psi - om * fa * FLOW_P) / TAU, yb = (psi - om * fb * FLOW_P) / TAU;
  // (1 + z)^0.6 by its series, z = INFALL * f: the drift's stretch of the lane coordinate.
  float za = INFALL * fa, zb = INFALL * fb;
  float ra = LANE * p06 * (1.0 + za * (0.6 - 0.12 * za)), rb = LANE * p06 * (1.0 + zb * (0.6 - 0.12 * zb));
  float sa = floor(ph) * 7.31, sb = floor(ph + 0.5) * 7.31 + 3.7;
  float fl = fr * LANE * 0.6 * p06 / r;
  float ka, kb;
  float bold = smoothstep(BOLD_IN, BOLD_OUT, r);
  float ta = streaks(ra, ya, sa, fl, fy, bold, ka), tb = streaks(rb, yb, sb, fl, fy, bold, kb);
  // Large knots along each orbit, and dark dust lanes along the knot noise's contours, both away from the inner
  // edge.
  ta += ka * 0.45 * bold;
  tb += kb * 0.45 * bold;
  float da = (1.0 - smoothstep(0.0, DUST_W, abs(ka + 0.09))) * bold, db = (1.0 - smoothstep(0.0, DUST_W, abs(kb + 0.09))) * bold;
  // Mids: a two-armed trailing spiral turning as a pattern.
  float arms = 1.0 + uWave * cos(2.0 * psi + SPIRAL_K * log(r) - uWavePh);
  // Highs: hot spots riding the innermost orbits. Each gathers the gas and the heat of its own orbit (lane is the
  // share it takes from the rest of the ring), so a spot moves light and adds none.
  float hot = 0.0, lane = 0.0;
  for (int i = 0; i < 3; i++) {
    if (r > R_IN * 1.7) break;
    float rh = R_IN * (1.1 + 0.17 * float(i));
    float wd = 0.7 + 0.3 * float(i);
    float arc = wrapA(psi - uHotA[i]) * rh;
    float qr = (r - rh) / 0.25, qa = arc / wd;
    float across = exp(-qr * qr);
    hot += across * exp(-qa * qa);
    lane += across * wd / rh;
  }
  // Beats: a clump of gas falls in, shearing into an arc as it goes. It empties the orbit close on either side
  // of itself by as much as it holds, so the tile or the panel's edge rarely hides one and shows the other.
  float clump = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 c = uClump[i];
    float sr = 0.3 + 0.07 * c.x;
    if (c.z <= 0.0 || abs(r - c.x) > 2.7 * sr) continue;
    float sp = 0.16 + 0.3 * c.w;
    float dp = wrapA(psi - c.y + 1.5 * (r - c.x) / c.x * min(c.w, 1.6));
    float qr = (r - c.x) / sr, qp = dp / sp;
    clump += c.z * exp(-qr * qr) * (exp(-qp * qp) - 0.5 * exp(-qp * qp / 4.0));
  }
  // Doppler and the hole's own redshift: the side coming at the camera is hotter, the receding side and the
  // plunging gas cooler.
  vec3 vdir = normalize(cross(P, n));
  float beta = min(0.58, BETA_K / sqrt(max(rr - 1.0, 1.0)));
  float g = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(vdir, k)) * sqrt(max(1.0 - 1.5 / rr, 0.0));
  // A clump holds less gas where the beaming would brighten it, so it carries the same light all the way round.
  clump *= min(1.0 / (g * g), 1.6);
  float spots = 1.0 - HOT_TAKE * uHot * lane;
  // Under the text the gas is a cooler region with a ragged edge that follows the gas, not a patch.
  float cool = smoothstep(0.0, 1.0, hush + 1.4 * (ta * wa + tb * wb - 0.5) * sin(PI * hush));
  // The temperature the camera sees sets the colour and the light together: it falls outward and rises with the
  // heat and with the Doppler factor.
  float T = mix(HEAT_LOW, HEAT_HIGH, uHeat) * pow(x, T_FALL) * (1.0 - RIM_COOL * smoothstep(RIM_FROM, R_OUT, r))
    * pow(g, DOPPLER) * exp(-fall * FALL_FADE)
    * (1.0 + 0.2 * clump) * (1.0 + HOT_HEAT * uHot * (hot - HOT_MEAN * lane)) * (1.0 + ARM_HEAT * (arms - 1.0))
    * (1.0 - HUSH_COOL * cool);
  // Each layer is shaded whole and the two results are mixed, so the renewal moves no light.
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 2; i++) {
    float t = i == 0 ? ta : tb;
    // The gas is a luminous body with lanes in it, fuller as the density rises. Towards the inner edge it
    // closes over its lanes part of the way: few lanes fit the beamed side, and their gaps would swing the
    // picture's brightness as they pass.
    float gas = mix(mix(BODY, 0.55, uDens), 1.0, smoothstep(0.2, 0.8, t));
    gas = mix(gas, 0.8, FILL * uDens * smoothstep(0.1, 0.45, x));
    float rho = max(gas * arms * (1.0 + 1.6 * clump) * spots + uHot * 1.2 * hot, 0.0);
    // A ragged outer rim. Past the inner edge only the densest strands go on, and end short of the hole.
    float rim = R_OUT * (0.72 + 0.28 * t);
    rho *= 1.0 - smoothstep(rim * 0.4, rim, r);
    rho *= mix(1.0, smoothstep(0.45, 0.8, t) * 2.0 * (1.0 - smoothstep(0.6, R_IN - R_FALL, fall)), smoothstep(0.0, 0.15, fall));
    // Optically thick but for the outer wisps, which the stars show through.
    float alpha = 1.0 - exp(-rho * mix(3.0, 4.2, uDens) * (0.15 + 0.85 * x));
    sum += vec4(gasLight(T, t, i == 0 ? da : db, bold) * alpha, alpha) * (i == 0 ? wa : wb);
  }
  return vec4(sum.rgb * (1.0 - HUSH_DIM * cool), sum.a);
}

// Sparse stars on a hashed grid in sky coordinates, drawn round on screen: a star is a point, so the lens moves
// and brightens it but never smears it. inv maps a sky offset to pixels. Slow twinkle, as the shared stars.
float starPoints(vec2 s, mat2 inv, float cell, float share, float size) {
  vec2 id = floor(s / cell);
  if (hash21(id + 23.3) > share) return 0.0;
  vec2 f = s / cell - id;
  vec2 r = vec2(hash21(id + 1.7), hash21(id + 9.1));
  float q = length(inv * ((f - (0.2 + 0.6 * r)) * cell)) / (size * (0.6 + 0.8 * r.x));
  if (q > 3.0) return 0.0;
  float tw = 0.75 + 0.25 * sin(uTime / (4.0 + 5.0 * r.x) + r.y * 40.0);
  return exp(-q * q) * tw * (0.35 + 0.65 * r.y);
}

// Cube-face coordinates of a direction, for the star grid.
vec2 faceUv(vec3 d) {
  vec3 a = abs(d);
  if (a.z >= a.x && a.z >= a.y) return d.xy / a.z + (d.z > 0.0 ? vec2(0.0) : vec2(9.0, 0.0));
  if (a.x >= a.y) return d.zy / a.x + (d.x > 0.0 ? vec2(19.0, 0.0) : vec2(29.0, 0.0));
  return d.xz / a.y + (d.y > 0.0 ? vec2(0.0, 19.0) : vec2(0.0, 29.0));
}

// The prelude's hush in x (as hushAt) and, in y, the same with a faint halo HUSH_WIDE further out: the region the
// gas cools in.
vec2 hushBoth(vec2 p) {
  vec2 h = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    vec4 r = uHush[i];
    if (r.z <= 0.0) continue;
    vec2 rad = r.zw * 0.7071;
    vec2 q = p - (r.xy + r.zw * 0.5);
    float k1 = length(q / rad);
    float sd = k1 < 1.0 ? (k1 - 1.0) * min(rad.x, rad.y) : k1 * (k1 - 1.0) / length(q / (rad * rad));
    float at = 1.0 - smoothstep(-0.25 * uHushFeather, uHushFeather, sd);
    float halo = 1.0 - smoothstep(-0.25 * uHushFeather, uHushFeather, sd - HUSH_WIDE * uDpr);
    h = max(h, vec2(at, max(at, HUSH_HALO * halo)));
  }
  return h;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  vec2 hb = hushBoth(fc);
  float hu = hb.x, hw = hb.y;
  float gF = uHole.z * D_REF / B_C;
  vec2 o = rot2(p - uHole.xy, -uHole.w) / gF;
  o.x *= uMirror;
  float se = sin(uEl), ce = cos(uEl);
  vec3 e1 = vec3(0.0, se, -ce);
  vec3 up = vec3(0.0, ce, se);
  vec3 d = normalize(vec3(o.x, 0.0, 0.0) + up * o.y - e1);
  float ca = -dot(d, e1);
  vec3 tp = d + e1 * ca;
  float sa = max(length(tp), 1e-6);
  vec3 e2 = tp / sa;
  float b = max(uD * sa, 1e-3);
  float fwB = max(fwidth(b), 1e-5);

  // The cover tile is opaque: skip the trace under it (a few pixels inside its edge, so the quads that straddle
  // the cut stay hidden).
  if (sdRound(fc - coverCenter(), uCover.zw * 0.5 - 4.0 * uDpr, uRadius) < 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // The disc's plane, tilted and precessing with the bass.
  vec3 n = normalize(vec3(sin(uTilt) * cos(uPrec), cos(uTilt), NOD * sin(uTilt) * sin(uPrec)));
  vec3 bx = normalize(vec3(1.0, 0.0, 0.0) - n * n.x);
  vec3 bz = cross(bx, n);
  float nextX = atan(dot(e2, n), dot(e1, n)) + 0.5 * PI;

  // Trace the ray backwards from the camera through the hole's field: u = 1/r against the orbit angle,
  // u'' = 3u^2 - u (RK4). Far from the hole the ray is nearly straight and the steps are long.
  vec3 hit[2];
  hit[0] = vec3(0.0); hit[1] = vec3(0.0);
  int nh = 0;
  int fate = 0;
  float phi = 0.0, u = 1.0 / uD, v = ca / b;
  float uEnd = 0.6 / uD;
  float phiInf = PI;
  nextX = mod(nextX, PI);
  for (int i = 0; i < STEPS; i++) {
    float h = min(mix(H_FAR, H_NEAR, sat(u * 14.0)), DU_MAX / (abs(v) + 1e-4));
    float u0 = u, v0 = v, p0 = phi;
    float k1u = v, k1v = 3.0 * u * u - u;
    float a2 = u + 0.5 * h * k1u, k2u = v + 0.5 * h * k1v, k2v = 3.0 * a2 * a2 - a2;
    float a3 = u + 0.5 * h * k2u, k3u = v + 0.5 * h * k2v, k3v = 3.0 * a3 * a3 - a3;
    float a4 = u + h * k3u, k4u = v + h * k3v, k4v = 3.0 * a4 * a4 - a4;
    u += h / 6.0 * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    v += h / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
    phi += h;
    if (phi >= nextX && nh < 2) {
      // Cubic Hermite between the two steps, so the disc's rings do not facet.
      float f = (nextX - p0) / h, f2 = f * f, f3 = f2 * f;
      float uk = (2.0 * f3 - 3.0 * f2 + 1.0) * u0 + (f3 - 2.0 * f2 + f) * h * v0 + (-2.0 * f3 + 3.0 * f2) * u + (f3 - f2) * h * v;
      vec3 hv = vec3(uk, mix(v0, v, f), nextX);
      if (nh == 0) hit[0] = hv; else hit[1] = hv;
      nh++;
      nextX += PI;
    }
    if (u > 0.5) { fate = 1; break; }
    // Past the exit the ray runs straight, but for the weak bend of the leg still ahead.
    if (v < 0.0 && u < uEnd) { fate = 2; phiInf = phi + atan(u, -v) + 2.0 / b * (1.0 - sqrt(max(1.0 - b * b * u * u, 0.0))); break; }
  }

  // Footprints, taken outside any branch.
  float r0 = hit[0].x > 0.0 ? 1.0 / hit[0].x : 0.0;
  float r1 = hit[1].x > 0.0 ? 1.0 / hit[1].x : 0.0;
  vec2 fr = min(vec2(fwidth(r0), fwidth(r1)), vec2(3.0));
  vec3 dirOut = cos(phiInf) * e1 + sin(phiInf) * e2;
  dirOut = vec3(rot2(dirOut.xz, uSky), dirOut.y).xzy;
  vec2 sky = faceUv(dirOut) * gF;
  vec2 sx = dFdx(sky) * uDpr, sy = dFdy(sky) * uDpr;
  float mag = length(abs(sx) + abs(sy));
  float det = sx.x * sy.y - sx.y * sy.x;
  mat2 inv = mat2(sy.y, -sx.y, -sy.x, sx.x) / (abs(det) < 1e-4 ? 1e-4 : det);

  // Front to back: each disc crossing, then the sky (or nothing, for a ray the hole swallowed).
  vec3 col = vec3(0.0);
  float trans = 1.0;
  float shine = 0.58 + 0.75 * uShine;
  for (int k = 0; k < 2; k++) {
    if (k >= nh || trans < 0.03) break;
    vec3 hv = k == 0 ? hit[0] : hit[1];
    float rk = 1.0 / max(hv.x, 1e-4);
    if (hv.x <= 0.0 || rk < R_FALL || rk > R_OUT) continue;
    float cphi = cos(hv.z), sphi = sin(hv.z);
    vec3 radial = cphi * e1 + sphi * e2;
    vec3 P = rk * radial;
    vec3 tdir = normalize(-hv.y / (hv.x * hv.x) * radial + rk * (-sphi * e1 + cphi * e2));
    float fk = k == 0 ? fr.x : fr.y;
    vec4 e = discAt(P, n, bx, bz, -tdir, fk, fk / (TAU * rk) * 3.0, hw);
    col += trans * e.rgb;
    trans *= 1.0 - e.a;
  }

  vec3 sky3 = vec3(0.0);
  if (fate == 2 && trans > 0.03) {
    // A band of dust in the cover's colours crosses the sky; the hole bends it into arcs as the camera orbits.
    float bl = dot(dirOut, vec3(0.5, 0.8, 0.33));
    float band = exp(-bl * bl / 0.09);
    sky3 = mix(vec3(0.012, 0.010, 0.030), vec3(0.003, 0.004, 0.013), sat(dirOut.y + 0.5));
    if (band > 0.01) {
      float lon = atan(dirOut.x, dirOut.z) / TAU;
      float n1 = pnoise(vec2(dirOut.y * 2.4 + 3.0, lon * 10.0), 10.0);
      float n2 = pnoise(vec2(dirOut.y * 7.0 + 9.0, lon * 28.0), 28.0);
      // A bright wandering core with filaments and dark lanes, inside a wide faint glow.
      float wob = bl + (n1 - 0.5) * 0.24;
      float core = exp(-wob * wob / 0.012);
      float ridge = 1.0 - abs(2.0 * n2 - 1.0);
      float lanes = smoothstep(0.38, 0.7, n1 * 0.45 + n2 * 0.55);
      vec3 cool = lift(uPal[1], 0.5), warm = lift(mix(uPal[2], uPal[0], n1), 0.5);
      sky3 += (cool * band * 0.08 + mix(cool, warm, core * ridge) * core * (0.2 + 0.8 * ridge * ridge) * (1.0 - 0.7 * lanes) * 0.8) * shine * (1.0 - 0.6 * hu);
    }
    // Where the lens squeezes the sky into less than a pixel per star cell, the stars fade instead of crawling.
    float seen = (1.0 - hu) * (1.0 - smoothstep(4.0, 12.0, mag));
    if (seen > 0.0) {
      float st = starPoints(sky, inv, 26.0, 0.5, 1.0) + 0.9 * starPoints(sky + 51.0, inv, 67.0, 0.42, 1.6);
      sky3 += vec3(0.85, 0.9, 1.0) * st * (0.6 + 0.9 * band) * seen;
    }
  }
  // The sky, the ring and the scattered light go through the exposure; the disc is added as it is.
  vec3 lit = trans * sky3;

  // The photon ring: light that circled the hole, thin and sharp on the shadow's edge, beamed like the disc.
  // Highs run small glints along it.
  float xr = (b - B_C * 1.004) / (fwB * RING_PX);
  float ringCore = exp(-xr * xr);
  float halo = exp(-max(b - B_C, 0.0) / (B_C * 0.03)) * step(B_C, b);
  float side = 1.0 - 0.4 * o.x / max(length(o), 1e-5);
  if (ringCore + halo > 1e-3 || fate == 0) {
    float ang = atan(o.y, o.x);
    float glint = sat(0.5 + 0.5 * sin(ang * 7.0 + uSpin * 2.1) * sin(ang * 4.0 - uSpin * 1.3));
    glint *= glint * glint;
    glint *= glint;
    vec3 rc = vec3(1.0, 0.95, 0.86) * mix(RING_LOW, RING_HIGH, uHeat) * side * side;
    lit += trans * rc * (ringCore * (1.0 + 1.6 * uHot * (glint - GLINT_MEAN)) + halo * 0.2 + (fate == 0 ? 0.3 : 0.0)) * shine;
  }

  // The disc's light scattered just outside the ring, as hot as the gas; the shadow stays black.
  float gl = max(b / B_C - 1.0, 0.0);
  lit += fire(mix(0.6, 1.0, uHeat)) * exp(-gl * 1.4) * step(1.0, b / B_C) * GLOW * shine * side * side;

  col += (1.0 - exp(-lit * EXPOSURE)) * (1.0 - 0.6 * hu);
  col += (hash21(fc) - 0.5) / 255.0;
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** One beat clump falling in: its start radius, current radius and angle, age in gas-seconds and seconds, and strength. */
interface Clump {
  r0: number;
  r: number;
  psi: number;
  age: number;
  life: number;
  h: number;
}

/** The scene's moving state, and the clump uniforms the last step packed from it. */
export interface EventHorizonState {
  primed: boolean;
  slow: number;
  I: number;
  weight: number;
  cam: number;
  heat: number;
  dens: number;
  speed: number;
  vel: number;
  spin: number;
  sky: number;
  tilt: number;
  prec: number;
  wave: number;
  wavePh: number;
  hot: number;
  hotA: [number, number, number];
  shine: number;
  clumps: Clump[];
  lastClump: number;
  clumpPsi: number;
  clock: number;
  // Per clump slot: radius, angle, faded strength and age.
  clump: Float32Array;
}

export function createEventHorizonState(): EventHorizonState {
  return {
    primed: false,
    slow: 0,
    I: 0.4,
    weight: 0.3,
    cam: 0.4,
    heat: 0.4,
    dens: 0.4,
    speed: 1,
    vel: 0,
    spin: 0,
    sky: 0,
    tilt: TILT_BASE,
    prec: 0.7,
    wave: WAVE_BASE,
    wavePh: 0,
    hot: 0,
    hotA: [0.3, 2.4, 4.4],
    shine: 0.4,
    clumps: [],
    lastClump: -9,
    clumpPsi: 0,
    clock: 0,
    clump: new Float32Array(CLUMP_SLOTS * 4),
  };
}

/**
 * Advances the state by dt. The first step starts every eased value at its target, so a scene opened mid-song
 * starts in that passage's state. Under Calm and while paused the motion envelopes and beats are ignored: a
 * steady mid intensity and a slow orbit, with only the eased level, through `shine`, setting the light. `rng`
 * picks where a beat clump starts.
 */
export function stepEventHorizon(
  st: EventHorizonState,
  s: VisualSignal,
  dt: number,
  playing: boolean,
  rng: () => number,
): void {
  const live = playing && s.drive > 0;
  const drive = live ? s.drive : 0;
  const bassM = live ? s.bassMotion : 0;
  const midM = live ? s.midMotion : 0;
  const highM = live ? s.highMotion : 0;
  const beat = live ? s.beat : 0;
  st.clock += dt;
  const fresh = !st.primed;
  const ease = fresh ? atTarget : easeEnvelope;
  if (fresh) {
    st.slow = Math.min(Math.max(s.level, PRIME_LOW), PRIME_HIGH);
    st.primed = true;
  }
  // Intensity: the eased level against the song's own slow mean, plus a share of the level itself. Paused, the
  // level falls to the follower's resting arch, so the mean holds until the song resumes.
  if (playing) st.slow = easeEnvelope(st.slow, s.level, dt, SLOW_TAU);
  const rel = Math.max(-1, Math.min(1, (s.level - st.slow) / REL_SPAN));
  const lvl = clamp01((s.level - LEVEL_LOW) / LEVEL_SPAN);
  st.I = ease(st.I, drive === 0 ? CALM_I : clamp01(I_LEVEL * lvl + (1 - I_LEVEL) * (0.5 + 0.5 * rel)), dt, 0.8);
  // The gas heats over seconds and cools more slowly still: the light of a drop never comes or goes in a step.
  // The shine saturates softly, so a loud passage's own ups and downs barely reach the light.
  const shine = 1 - Math.exp(-s.level * SHINE_K);
  st.shine = ease(st.shine, shine, dt, shine > st.shine ? HEAT_TAU : COOL_TAU);
  st.heat = ease(st.heat, st.I, dt, st.I > st.heat ? HEAT_TAU : COOL_TAU);
  st.dens = ease(st.dens, st.I, dt, st.I > st.dens ? HEAT_TAU : COOL_TAU);
  // The camera plunges with the intensity and the weight of the bass, and backs out slowly.
  st.weight = ease(st.weight, drive === 0 ? 0.4 : clamp01((s.swell - WEIGHT_LOW) / WEIGHT_SPAN), dt, 1.2);
  const plunge = drive === 0 ? CALM_I : clamp01(0.5 + (0.5 * st.I + 0.5 * st.weight - 0.5) * Math.min(1.25, 0.6 + 0.4 * drive));
  st.cam = ease(st.cam, plunge, dt, plunge > st.cam ? CAM_TAU_IN : CAM_TAU_OUT);
  // Gas pace through a soft spring: quick to whip up, slow to wind down.
  const range = drive > LIVELY_DRIVE ? PACE_LIVELY : PACE_BALANCED;
  let pace = CALM_PACE;
  if (drive > 0) {
    // The range is for a full bass: without its weight the gas runs up to a quarter slower.
    pace = (rel < 0 ? range[1] + (range[1] - range[0]) * rel : range[1] + (range[2] - range[1]) * rel)
      * (1 + MID_PACE * midM) * (1 - PACE_LIGHT * (1 - st.weight * st.weight));
  }
  if (fresh) {
    st.speed = pace;
    st.vel = 0;
  }
  const up = pace > st.speed;
  st.vel += ((pace - st.speed) * (up ? 1.6 : 0.6) - st.vel * (up ? 2.5 : 1.5)) * dt;
  st.speed = Math.max(0.3, st.speed + st.vel * dt);
  const dSpin = dt * st.speed;
  st.spin += dSpin;
  st.sky += dSpin * SKY_PACE;
  // Bass: the disc tilts and the tilt precesses, so the whole plane rocks.
  st.tilt = easeEnvelope(st.tilt, TILT_BASE + TILT_BASS * bassM, dt, 0.4);
  st.prec += dt * (PREC_BASE + (PREC_BASS * (st.tilt - TILT_BASE)) / TILT_BASS);
  // Mids: spiral-arm depth and turn. Highs: hot spots and ring glints.
  st.wave = easeEnvelope(st.wave, WAVE_BASE + WAVE_MID * midM, dt, 0.45);
  st.wavePh += dSpin * WAVE_PACE * (1 + (1.5 * (st.wave - WAVE_BASE)) / WAVE_MID);
  st.hot = easeEnvelope(st.hot, highM, dt, 0.3);
  for (let i = 0; i < 3; i++) st.hotA[i] = (st.hotA[i] + dSpin * KEP * Math.pow(R_IN * (1.1 + 0.17 * i), -1.5)) % (Math.PI * 2);
  // Beat: a clump gathers in the outer disc and falls in along a tightening spiral.
  if (beat > 0 && st.clock - st.lastClump >= CLUMP_GAP) {
    st.lastClump = st.clock;
    st.clumpPsi += CLUMP_TURN;
    if (st.clumps.length === CLUMP_SLOTS) st.clumps.shift();
    const r0 = R_OUT * (0.55 + 0.2 * rng());
    st.clumps.push({ r0, r: r0, psi: st.clumpPsi % (Math.PI * 2), age: 0, life: 0, h: Math.min(1.5, beat) });
  }
  st.clump.fill(0);
  const clumps = st.clumps;
  let n = 0;
  for (let i = 0; i < clumps.length; i++) if (clumps[i].age < CLUMP_FALL) clumps[n++] = clumps[i];
  clumps.length = n;
  for (let i = 0; i < n; i++) {
    const c = clumps[i];
    c.age += dSpin;
    c.life += dt;
    const a = Math.min(1, c.age / CLUMP_FALL);
    c.r = c.r0 - (c.r0 - R_IN * 1.05) * a * a;
    c.psi = (c.psi + dSpin * KEP * Math.pow(c.r, -1.5)) % (Math.PI * 2);
    const fin = Math.min(1, c.life / CLUMP_RISE);
    st.clump[i * 4] = c.r;
    st.clump[i * 4 + 1] = c.psi;
    st.clump[i * 4 + 2] = c.h * fin * fin * (3 - 2 * fin) * (1 - a * a * a);
    st.clump[i * 4 + 3] = c.age;
  }
}

/** The eased value a first step jumps to: its target. */
function atTarget(_from: number, to: number): number {
  return to;
}

/** A framing value between its backed-out and plunged-in poses. */
function pose(out: number, plunged: number, cam: number): number {
  return out + (plunged - out) * cam;
}

const EVENT_HORIZON_PROGRAM: ProgramSource = { name: "event-horizon", vs: FS_VS, fs: FS };
/** The programs event-horizon compiles, for warming the shader cache ahead of the stage. */
export const EVENT_HORIZON_PROGRAMS: readonly ProgramSource[] = [EVENT_HORIZON_PROGRAM];

export function createEventHorizon(kit: Kit): Candidate {
  const st = createEventHorizonState();
  // One seed per surface: the clumps land the same way on every run.
  const rng = createRng(0xe4e);
  const hole: Rect = [0, 0, 0, 0];

  return {
    mode: "image",
    bloom: 0.3,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      stepEventHorizon(st, f.sig, f.dt, f.playing, rng);
      const p = kit.program(EVENT_HORIZON_PROGRAM);
      setScene(kit, p, f, 0, null, null);
      // The hole sits by the cover in CSS pixels from the bottom-left, sized in cover widths, eased between the
      // framing's backed-out and plunged-in poses.
      const frame = f.ambient ? FRAME_AMBIENT : FRAME_PLAYER;
      const cover = kit.geo.cover;
      const dpr = kit.size.dpr;
      const w = cover[2] / dpr;
      hole[0] = (cover[0] + cover[2] * 0.5) / dpr + pose(frame.at[0][0], frame.at[1][0], st.cam) * w;
      hole[1] = (cover[1] + cover[3] * 0.5) / dpr + pose(frame.at[0][1], frame.at[1][1], st.cam) * w;
      hole[2] = pose(frame.r[0], frame.r[1], st.cam) * w;
      hole[3] = frame.roll;
      kit.set4(p, "uHole", hole);
      kit.set1(p, "uMirror", frame.side);
      kit.set1(p, "uD", D_FAR + (D_NEAR - D_FAR) * st.cam);
      kit.set1(p, "uEl", EL_HIGH + (EL_LOW - EL_HIGH) * st.cam);
      kit.set1(p, "uSpin", st.spin);
      kit.set1(p, "uTilt", st.tilt);
      kit.set1(p, "uPrec", st.prec);
      kit.set1(p, "uHeat", st.heat);
      kit.set1(p, "uDens", st.dens);
      kit.set1(p, "uWave", st.wave);
      kit.set1(p, "uWavePh", st.wavePh);
      kit.set1(p, "uHot", st.hot);
      kit.gl.uniform3fv(kit.uniform(p, "uHotA"), st.hotA);
      kit.set1(p, "uShine", st.shine);
      kit.set1(p, "uSky", st.sky);
      kit.gl.uniform4fv(kit.uniform(p, "uClump"), st.clump);
      kit.drawQuad();
    },
    dispose() {},
  };
}
