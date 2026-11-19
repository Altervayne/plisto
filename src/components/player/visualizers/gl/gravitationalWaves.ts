/*
 * Gravitational Waves: two black holes in a tight inspiral around the cover, over a grid of space-time fabric
 * seen from above the orbit. Each hole is a shadow with a photon ring and a banded accretion disc, its far
 * half lensed over the shadow; the fabric plunges into a funnel under each hole and carries the two-armed
 * spiral wave the pair radiates. Rays near a hole march the steep funnel; the rest take a bracketed solve.
 * Dark-only: the scene has no light look.
 *
 * The absolute loudness sets the wave and the floor of the pace: a near-silent passage barely turns over a
 * faint wave. Above that floor the pace swings with the intensity (the loudness plus the recent kick weight)
 * against its own slow mean, through a soft spring, so a build or a drop whips the pair round even when the
 * loudness is pinned high and a calmer passage lets it settle. A strong kick pushes the orbit on through an
 * eased envelope. The bass raises the wave and deepens the wells, the mids add pace and disc turbulence, the
 * highs spark the photon rings and shimmer the jets. A beat sends a crest out on the wave, sized by the beat's
 * weight, and a knot up each jet; a surge sends one great wave and lurches the pair, a cut lets the turning
 * and the waves sink. Calm and paused hold a fixed slow orbit with no reaction.
 *
 * Photosensitivity: overall brightness follows the eased level. The wave, the beat crests, the photon-ring spark,
 * the jet knot and the disc turbulence add light too, but each is eased and local, and crests launch at most
 * a few times a second.
 */

// -- Local Imports --
import { clamp01 } from "./cozy";
import { COSMIC_COMMON } from "./cosmic";
import { createCoverTexture } from "./coverTexture";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit, ProgramSource } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

// Orbit pace at a pace of 1, rad/s, and the share of it Calm and paused cruise at.
export const OMEGA = 2.4;
export const CALM_PACE = 0.6;
// The pace as a multiple of OMEGA: the near-silent floor, and the pace at full loudness while the music holds
// its own recent level, at Balanced and at Lively.
export const PACE_QUIET = 0.12;
const PACE_BODY_BALANCED = 1.1;
export const PACE_BODY_LIVELY = 1.3;
// The drive above which the Lively body and swing apply.
const LIVELY_DRIVE = 1.3;
// How far the share of the pace above the floor swings with the intensity against its recent level:
// [calmer, building] as multiples of it, at Balanced and at Lively.
const SWING_BALANCED: readonly [number, number] = [0.6, 1.8];
const SWING_LIVELY: readonly [number, number] = [0.5, 2.0];
// The pace eases into PACE_MAX above PACE_KNEE. The wave arms pass a point at twice the orbit's rate, so the
// cap keeps them under three a second.
const PACE_KNEE = 2.2;
export const PACE_MAX = 3.1;
// The loudness the loudness curve runs between, and its exponent: it stays low through a quiet intro.
const LOUD_LO = 0.1;
const LOUD_HI = 0.9;
const LOUD_CURVE = 1.5;
// Intensity: the loudness plus this share of the recent kick weight, which a peak-follow holds over KICK_TAU.
const KICK_SHARE = 0.15;
const KICK_TAU = 0.8;
// The intensity measure, quick and slow, in seconds, and the gap between them that reaches the end of the swing.
const FAST_TAU = 0.8;
const SLOW_TAU = 10;
const REL_SPAN = 0.12;
// The beat push: extra pace per unit of beat weight, the time constant of each of its two rise stages and its
// fall, in seconds.
export const PUSH_PACE = 0.5;
const PUSH_RISE = 0.05;
const PUSH_FALL = 0.25;
// Extra pace per unit of the mid envelope.
const MID_PACE = 0.12;
// Extra pace per unit of surge, easing out over LURCH_TAU seconds.
export const LURCH_PACE = 0.7;
const LURCH_TAU = 1.5;
// A cut sinks the turning and the waves over this many seconds.
const SINK_SECS = 1.5;
// The orbit tightens by this share at the top of the loudness curve.
const INSPIRAL = 0.1;
// Gravitational-wave number, rad per world unit.
export const WAVE_K = 3.4;
// Wave amplitude: at rest (Calm), at the near-silent floor, at the top of the loudness curve, and per unit of bass envelope.
export const WAVE_BASE = 0.04;
export const WAVE_QUIET = 0.012;
export const WAVE_LOUD = 0.1;
export const WAVE_BASS = 0.07;
// Well depth at the throat, at rest and per unit of bass envelope.
export const WELL_BASE = 0.62;
export const WELL_BASS = 0.16;
// Least time between two beat crests, and a crest's life, in seconds.
const CREST_GAP = 0.55;
export const CREST_LIFE = 8;
// A beat's weight below this launches no crest; a crest's height follows the weight while it is held.
const CREST_MIN = 0.12;
const WEIGHT_HOLD = 0.12;
// The great wave a surge sends, per unit of surge, and the cap on its height.
const SURGE_CREST = 2.2;
export const SURGE_MAX = 2.6;
// The shader caps the sum of overlapping crests here, so the lift stays inside the surface solver's bracket.
export const CREST_SUM_MAX = SURGE_MAX;
// Beat crests alive at once; the shader's uCrest holds this many.
const CREST_SLOTS = 4;
// A jet knot's climb, in seconds.
const KNOT_LIFE = 1.1;
// The discs' inner-edge rotation, rad/s, before the mids.
const DISC_SPIN = 3.2;

const FS = `${SCENE_PRELUDE}${COSMIC_COMMON}
uniform float uPhi;
uniform float uOrbR;
uniform float uWaveA;
uniform float uWell;
uniform float uSpin;
uniform float uShine;
uniform float uTurb;
uniform float uHighE;
uniform float uWaveK;
uniform vec2 uCrest[4];
uniform vec2 uKnot;
// -- Tunables (shader side) --
const float ORBIT_W = 0.84;       // orbit radius on screen at rest, in cover widths
const float DIST = 6.0;           // camera distance, in orbit radii
const float ELEV = 0.75;          // camera height above the orbital plane, rad: high enough that the pair clears the tile
const float SHEET_Y = 0.32;       // the fabric's rest height above the orbital plane: each well dives down to its hole
const float CELL = 0.32;          // grid cell, world units
const float WELL_A = 0.14;        // throat radius of a well: a 1/r funnel, steep near the hole with a long shallow tail
const float FUNNEL_REACH = 0.9;   // rays that pass this close to a hole march the steep funnel instead of the quick solve
const float CREST_W = 0.35;       // a beat crest's half-width, world units
const float CREST_A = 0.08;
const float WAVE_MAX = 0.22;      // the wave never grows past this, so the sheet and the grid never fold over
const float STRAIN = 0.62;        // in-plane stretch of the grid per unit of wave height: the cells squeeze and widen
const float HOLE_R = 0.1;         // shadow radius, world units
const float LENS = 0.95;          // Einstein radius for the discs, in shadow radii: the far half hugs the shadow
const float BG_LENS = 2.6;        // and for the fabric and stars behind, which wrap into arcs round the photon ring
const float DISC_IN = 1.5;        // disc edges, in shadow radii
const float DISC_OUT = 4.4;
const float BANDS = 12.0;         // rings across a disc
const float DOPPLER = 0.42;       // gas speed at the inner edge, as a share of c
const float JET_LEN = 1.3;        // world units
const float EXPOSURE = 1.25;
const float FILL = 0.05;          // the fabric's own faint glow, under the lines

vec3 gCam, gFwd, gUp;
vec2 gCC;
float gF;
vec3 gH[2];
float gWave, gArm, gCrest, gLift;

vec3 rayAt(vec2 q) { vec2 o = q - gCC; return normalize(vec3(o.x, 0.0, 0.0) + gUp * o.y + gFwd * gF); }
float depthOf(vec3 P) { return dot(P - gCam, gFwd); }
vec2 project(vec3 P) { vec3 v = P - gCam; return gCC + gF * vec2(v.x, dot(v, gUp)) / dot(v, gFwd); }

float height(vec2 xz) {
  vec2 a = xz - gH[0].xz, b = xz - gH[1].xz;
  float wells = -uWell * WELL_A * (inversesqrt(dot(a, a) + WELL_A * WELL_A) + inversesqrt(dot(b, b) + WELL_A * WELL_A));
  float r2 = dot(xz, xz) + 1e-4, r = sqrt(r2);
  // The quadrupole wave: two trailing arms turning with the orbit, so the waves leave at twice its pace.
  float x = uWaveK * r - 2.0 * uPhi;
  float wave = ((xz.x * xz.x - xz.y * xz.y) * cos(x) - 2.0 * xz.x * xz.y * sin(x)) / r2;
  float env = smoothstep(0.5 * uOrbR, 1.7 * uOrbR, r) / (1.0 + 0.15 * r);
  float crest = 0.0;
  for (int i = 0; i < 4; i++) { float u = (r - uCrest[i].x) / CREST_W; crest += uCrest[i].y * exp(-u * u); }
  crest = min(crest, ${CREST_SUM_MAX.toFixed(2)});
  gWave = wave * env;
  // The arm profile: narrow bright crests over wide dim troughs, averaging zero along a ring.
  gArm = (smoothstep(0.25, 1.0, wave) - 0.28) * env;
  gCrest = crest * env;
  gLift = env * (wave * min(uWaveA + CREST_A * crest, WAVE_MAX) + 0.35 * CREST_A * crest);
  return SHEET_Y + wells + gLift;
}

// Black-body-like colour of the disc gas at a temperature, 1 at the inner edge; brightness rises with it.
vec3 heat(float T) {
  vec3 c = mix(vec3(0.50, 0.05, 0.01), vec3(1.0, 0.32, 0.04), sat(T * 2.2 - 0.5));
  c = mix(c, vec3(1.0, 0.72, 0.30), sat(T * 2.6 - 1.5));
  c = mix(c, vec3(1.0, 0.96, 0.88), sat(T * 2.8 - 2.3));
  c = mix(c, vec3(0.78, 0.88, 1.0), sat(T * 2.2 - 2.6));
  return c * (0.25 + 2.2 * T * T);
}

// One ring of a disc: its own brightness and a few clumps turning at the ring's Keplerian rate.
float band(float b, float ang, int i) {
  float rb = DISC_IN + (b + 0.5) / BANDS * (DISC_OUT - DISC_IN);
  float h = hash21(vec2(b, float(i) * 7.0 + 1.0));
  float m = 2.0 + floor(h * 4.0);
  float rot = uSpin * pow(DISC_IN / rb, 1.5) + h * 6.283;
  float clump = sin(m * ang - rot) * 0.6 + sin((m + 3.0) * ang - rot * 1.3 + h * 11.0) * 0.4;
  return (0.45 + 0.55 * hash21(vec2(b, 3.0 + float(i)))) * (1.0 + (0.28 + 0.35 * uTurb) * clump);
}

// Emission of hole i's disc at a point Q on the orbital plane: banded rings that each turn at their own
// Keplerian rate (so the pattern never winds up), a white-hot inner edge, and Doppler beaming.
vec3 discAt(vec3 Q, int i) {
  vec2 rel = (Q.xz - gH[i].xz) / HOLE_R;
  float r = length(rel);
  if (r < DISC_IN * 0.95 || r > DISC_OUT) return vec3(0.0);
  float aa = fwidth(r) + 1e-3;
  float edge = smoothstep(DISC_IN, DISC_IN + aa * 1.5, r) * (1.0 - smoothstep(DISC_OUT * 0.55, DISC_OUT, r));
  float x = DISC_IN / r;
  float T = pow(x, 0.75);
  vec3 tang = vec3(-rel.y, 0.0, rel.x) / r;
  float beta = DOPPLER * sqrt(x);
  float g = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(tang, normalize(gCam - Q)));
  float ang = atan(rel.y, rel.x);
  float bands = (r - DISC_IN) / (DISC_OUT - DISC_IN) * BANDS;
  float b0 = floor(bands);
  // The ring edges are hard, antialiased by blending into the next band over one pixel.
  float tex = mix(band(b0, ang, i), band(b0 + 1.0, ang, i), smoothstep(1.0 - fwidth(bands), 1.0, fract(bands)));
  return heat(T * g) * pow(g, 3.0) * tex * edge;
}

// Adds one hole: its far disc half lensed over the shadow, the shadow, the photon ring, the near half and the jets.
void drawHole(inout vec3 col, vec2 p, int i, float shine) {
  vec2 s = project(gH[i]);
  float z = depthOf(gH[i]);
  float rs = HOLE_R * gF / z;
  vec2 dp = p - s;
  float dist = length(dp);
  float jetL = JET_LEN * gF * cos(ELEV) / z;
  // Jets: thin blue-white beams along the spin axis. The highs shimmer them; a beat sends a knot up each.
  float a = abs(dp.y) / jetL;
  if (a < 1.0 && abs(dp.x) < rs * 1.2) {
    float wdt = rs * (0.09 + 0.35 * a);
    float core = exp(-pow(dp.x / wdt, 2.0)) * smoothstep(rs * 1.05, rs * 1.6, abs(dp.y)) * pow(1.0 - a, 2.2) * (0.6 + 0.8 * exp(-a * 5.0));
    float shimmer = 1.0 + 0.35 * uHighE * sin(a * 38.0 - uTime * 9.0 + float(i) * 2.0);
    float knot = uKnot.y * exp(-pow((a - uKnot.x) / 0.07, 2.0));
    float jet = core * (0.8 * shimmer + 2.2 * knot);
    col += mix(vec3(0.45, 0.65, 1.0), vec3(0.9, 0.95, 1.0), sat(core)) * jet * shine * (dp.y < 0.0 ? 0.6 : 1.0);
  }
  // A wide warm bloom, so each disc lights the space around it.
  col += vec3(1.0, 0.42, 0.12) * exp(-pow(dist / (rs * 5.5), 2.0)) * 0.22 * shine;
  if (dist > rs * DISC_OUT * 1.25) return;
  float te = LENS * rs;
  vec2 pl = p - te * te * dp / max(dot(dp, dp), 1.0);
  vec3 d1 = rayAt(pl);
  vec3 Q1 = gCam + d1 * (-gCam.y / d1.y);
  float outside = smoothstep(rs - 0.7, rs + 0.7, dist);
  // The far and near halves blend over a short depth band at the sides, so the lensed half meets the direct one.
  float m = HOLE_R * 1.2;
  float far = smoothstep(z - m, z + m, depthOf(Q1));
  if (far > 0.0) col += discAt(Q1, i) * shine * outside * far;
  col *= outside;
  float pw = max(0.8, rs * 0.04);
  float ring = exp(-pow((dist - rs * 1.04) / pw, 2.0));
  float ang = atan(dp.y, dp.x);
  float spark = pow(sat(0.5 + 0.5 * sin(ang * 9.0 + uSpin * 1.7) * sin(ang * 5.0 - uSpin * 1.1 + float(i))), 6.0);
  col += vec3(1.0, 0.93, 0.82) * ring * shine * (1.6 + 2.2 * uHighE * spark);
  vec3 d0 = rayAt(p);
  vec3 Q0 = gCam + d0 * (-gCam.y / d0.y);
  float nearW = 1.0 - smoothstep(z - m, z + m, depthOf(Q0));
  if (nearW > 0.0) {
    vec3 near = discAt(Q0, i) * shine * nearW;
    col = col * (1.0 - sat(luma(near) * 0.8)) + near;
  }
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  float hu = hushAt(fc);
  gCC = coverCenter() / uDpr;
  float w = uCover.z / uDpr;
  gF = ORBIT_W * w * DIST;
  float se = sin(ELEV), ce = cos(ELEV);
  gCam = vec3(0.0, DIST * se, -DIST * ce);
  gFwd = vec3(0.0, -se, ce);
  gUp = vec3(0.0, ce, se);
  gH[0] = uOrbR * vec3(cos(uPhi), 0.0, sin(uPhi));
  gH[1] = -gH[0];
  float shine = 0.6 + 0.75 * uShine;

  // The background is seen through both lenses.
  vec2 pw = p;
  for (int i = 0; i < 2; i++) {
    vec2 s = project(gH[i]);
    float te = BG_LENS * HOLE_R * gF / depthOf(gH[i]);
    vec2 d = p - s;
    pw -= te * te * d / max(dot(d, d), 1.0);
  }
  vec3 d = rayAt(pw);
  float dy = min(d.y, -1e-3);
  float tA = (SHEET_Y + 0.25 - gCam.y) / dy, tB = (SHEET_Y - 2.0 * uWell - 0.25 - gCam.y) / dy;
  vec2 A = (gCam + d * tA).xz, AB = (gCam + d * tB).xz - A;
  float near = 1e3;
  for (int i = 0; i < 2; i++) {
    vec2 q = gH[i].xz - A;
    near = min(near, length(q - AB * sat(dot(q, AB) / dot(AB, AB))));
  }
  vec3 P;
  if (near < FUNNEL_REACH) {
    // The funnel walls are too steep for the quick solve: march to the first crossing, then bisect.
    float dt = (tB - tA) / 12.0, t0 = tA, t1 = tB, f0 = 1.0, f1 = -1.0;
    for (int i = 1; i <= 12; i++) {
      float tt = tA + dt * float(i);
      vec3 Q = gCam + d * tt;
      float f = Q.y - height(Q.xz);
      if (f < 0.0) { t0 = tt - dt; t1 = tt; f1 = f; break; }
      f0 = f;
    }
    for (int i = 0; i < 5; i++) {
      float tm = 0.5 * (t0 + t1);
      vec3 Q = gCam + d * tm;
      float f = Q.y - height(Q.xz);
      if (f < 0.0) { t1 = tm; f1 = f; } else { t0 = tm; f0 = f; }
    }
    // A last secant step between the bracketing points, so the hit does not snap to the bisection's steps.
    P = gCam + d * mix(t0, t1, sat(f0 / max(f0 - f1, 1e-5)));
  } else {
    // Off the funnels the one crossing lies between 0.3 above and 0.6 below the rest height; Illinois converges
    // on it, so this solve and the march agree where they meet.
    float ta = (SHEET_Y + 0.3 - gCam.y) / dy, tb = (SHEET_Y - 0.6 - gCam.y) / dy;
    vec3 Qa = gCam + d * ta, Qb = gCam + d * tb;
    float fa = Qa.y - height(Qa.xz), fb = Qb.y - height(Qb.xz);
    for (int i = 0; i < 4; i++) {
      float tc = (ta * fb - tb * fa) / (fb - fa);
      vec3 Qc = gCam + d * tc;
      float fc = Qc.y - height(Qc.xz);
      if (fc * fb < 0.0) { ta = tb; fa = fb; } else fa *= 0.5;
      tb = tc; fb = fc;
    }
    P = gCam + d * tb;
  }
  float hh = height(P.xz);
  float t = length(P - gCam);
  // How far down a well this point is, 0 on the open sheet and 1 at the throat.
  float depthK = sat((SHEET_Y - 0.12 - hh) / uWell);

  // Space behind the fabric: a faint cover-tinted haze and stars.
  vec3 col = mix(vec3(0.010, 0.008, 0.028), vec3(0.002, 0.003, 0.012), fc.y / uRes.y);
  float neb = fbm(pw * 0.0026 + vec2(2.0, 7.0)) * fbm(pw * 0.0019 + vec2(5.0, 1.0));
  col += mix(uPal[1], uPal[0], 0.4) * neb * 0.16;
  float st = stars(pw, 34.0, 0.5, 1.0) + 0.7 * stars(pw + 30.0, 61.0, 0.5, 1.5);
  // Stars stretch into arcs near the photon rings and fade where the lens magnifies them past a few pixels.
  float mag = length(fwidth(pw));
  col += vec3(0.85, 0.9, 1.0) * st * 0.8 * (1.0 - hu) * (1.0 - smoothstep(2.5, 6.0, mag));

  // The fabric: per-axis antialiased lines that fade out before they get dense, warmer and brighter in the wells,
  // and lit along the wave so its crests run across the grid.
  vec2 g = (P.xz + P.xz / (length(P.xz) + 0.3) * gLift * STRAIN) / CELL;
  vec2 fw = max(fwidth(g), vec2(1e-4));
  vec2 dl = abs(fract(g - 0.5) - 0.5) / fw;
  vec2 dl4 = abs(fract(g * 0.25 - 0.5) - 0.5) * 4.0 / fw;
  vec2 fadeMinor = 1.0 - smoothstep(vec2(0.12), vec2(0.32), fw.yx);
  vec2 fadeMajor = 1.0 - smoothstep(vec2(0.3), vec2(0.9), fw.yx);
  vec2 lnMinor = (1.0 - smoothstep(vec2(0.0), vec2(1.0), dl)) * fadeMinor;
  vec2 lnMajor = (1.0 - smoothstep(vec2(0.2), vec2(1.4), dl4)) * fadeMajor;
  float line = max(max(lnMinor.x, lnMinor.y) * 0.45, max(lnMajor.x, lnMajor.y));
  // Down a well the cells stretch, so half-cell lines fade in there and the lines visibly converge into the throat.
  vec2 dl2 = abs(fract(g * 2.0 - 0.5) - 0.5) * 0.5 / fw;
  vec2 lnFine = (1.0 - smoothstep(vec2(0.0), vec2(1.0), dl2)) * (1.0 - smoothstep(vec2(0.06), vec2(0.16), fw.yx));
  line = max(line, max(lnFine.x, lnFine.y) * 0.4 * smoothstep(0.05, 0.5, depthK));
  // Where the near lip of a funnel hides its throat the depth jumps between pixels; the lines fade across that edge.
  line *= 1.0 - smoothstep(0.02, 0.09, fwidth(t));
  vec2 halo = exp(-dl4 * 0.35) * fadeMajor;
  line += 0.22 * max(halo.x, halo.y);
  float heatW = 0.0;
  for (int i = 0; i < 2; i++) { vec2 q = P.xz - gH[i].xz; heatW += 1.0 / (1.0 + dot(q, q) * 5.0); }
  vec3 lineCol = mix(vec3(0.20, 0.52, 1.0), vec3(1.0, 0.42, 0.10), sat(heatW * 1.2 + depthK * 0.6));
  lineCol = mix(lineCol, vec3(1.0, 0.78, 0.5), depthK * depthK * 0.6);
  float fog = exp(-max(t - 4.0, 0.0) * 0.11);
  // Crests light up and troughs dim by the same share, so the waves run across the grid as light without
  // changing its mean; a beat crest adds a little light of its own as it travels.
  float waveLit = 1.0 + 2.2 * gArm * sat(uWaveA * 7.0) + 2.0 * gCrest;
  lineCol = mix(lineCol, vec3(0.85, 0.92, 1.0), sat(gWave * 0.6 + gCrest * 0.6) * 0.6);
  col += lineCol * line * fog * (0.55 + 1.1 * heatW + 0.8 * depthK) * waveLit * shine * (1.0 - 0.75 * hu);
  col += vec3(1.0, 0.45, 0.12) * heatW * heatW * 0.05 * shine * fog;
  // A faint fill on the fabric, brighter on the wave's crests and darker in its troughs: the two spiral arms.
  float arms = 1.0 + 3.0 * gArm * sat(uWaveA * 7.0) + 2.2 * gCrest;
  col += vec3(0.20, 0.36, 1.0) * FILL * arms * fog * smoothstep(0.0, 0.4, length(P.xz) - uOrbR * 0.6) * (1.0 - 0.8 * depthK) * shine * (1.0 - 0.6 * hu);
  vec3 cov = coverAt(0.5 + (p - gCC) / (w * 3.2), 4.0);
  float glow = exp(-pow(length(p - gCC) / (w * 0.95), 2.0));
  col += lift(cov, 0.5) * glow * 0.35 * shine;

  // The holes, the farther one first.
  int nearI = depthOf(gH[0]) < depthOf(gH[1]) ? 0 : 1;
  drawHole(col, p, 1 - nearI, shine);
  drawHole(col, p, nearI, shine);

  col = 1.0 - exp(-col * EXPOSURE);
  col = mix(col, uGround, hu * 0.45);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** One crest riding out on the wave: its radius in world units, age in seconds, height and whether a beat still holds it. */
interface Crest {
  r: number;
  age: number;
  h: number;
  held: boolean;
}

/** The scene's moving state, and the crest and knot uniforms the last step packed from it. */
export interface GravitationalWavesState {
  phi: number;
  radius: number;
  fast: number;
  slow: number;
  primed: boolean;
  speed: number;
  vel: number;
  // The peak-followed kick weight, and the beat push's held target, first ease and envelope.
  kick: number;
  pushHold: number;
  pushIn: number;
  push: number;
  // The orbit's pace this step, as a multiple of OMEGA.
  pace: number;
  // The share of the loudness curve reached, 0..1, and the surge lurch and cut sink envelopes.
  lv: number;
  lurch: number;
  sink: number;
  waveA: number;
  well: number;
  spin: number;
  shine: number;
  turb: number;
  high: number;
  crests: Crest[];
  lastCrest: number;
  knotAge: number;
  knotH: number;
  clock: number;
  // Per crest slot: its radius and faded height.
  crest: Float32Array;
  // The knot's climb along the jet, 0..1, and its glow.
  knot: [number, number];
}

export function createGravitationalWavesState(): GravitationalWavesState {
  return {
    phi: 0.6,
    radius: 1,
    fast: 0,
    slow: 0,
    primed: false,
    speed: CALM_PACE,
    vel: 0,
    kick: 0,
    pushHold: 0,
    pushIn: 0,
    push: 0,
    pace: CALM_PACE,
    lv: 0,
    lurch: 0,
    sink: 0,
    waveA: WAVE_BASE,
    well: WELL_BASE,
    spin: 0,
    shine: 0.4,
    turb: 0,
    high: 0,
    crests: [],
    lastCrest: -9,
    knotAge: 9,
    knotH: 0,
    clock: 0,
    crest: new Float32Array(CREST_SLOTS * 2),
    knot: [0, 0],
  };
}

/** A pace eased into PACE_MAX above PACE_KNEE, with no kink at the knee. */
export function paceKnee(p: number): number {
  if (p <= PACE_KNEE) return p;
  const room = PACE_MAX - PACE_KNEE;
  return PACE_KNEE + room * Math.tanh((p - PACE_KNEE) / room);
}

/**
 * Advances the state by dt. Under Calm and while paused the motion envelopes and beats are ignored, so the
 * pair cruises at a fixed slow pace over a low wave; only the eased level, through `shine`, sets the light.
 * The pace spring eases it into and out of that cruise.
 */
export function stepGravitationalWaves(st: GravitationalWavesState, s: VisualSignal, dt: number, playing: boolean): void {
  const live = playing && s.drive > 0;
  const drive = live ? s.drive : 0;
  const bassM = live ? s.bassMotion : 0;
  const midM = live ? s.midMotion : 0;
  const highM = live ? s.highMotion : 0;
  const beat = live ? s.beat : 0;
  const weight = live ? s.beatWeight : 0;
  const surge = live ? s.surge : 0;
  st.clock += dt;
  // The absolute loudness sets the floor and the wave; the intensity against its own recent level swings the
  // pace above the floor, so a build speeds the pair up even when the loudness is pinned high.
  st.kick = Math.max(drive > 0 ? weight / drive : 0, st.kick * Math.exp(-dt / KICK_TAU));
  const intensity = s.loudness + KICK_SHARE * st.kick;
  if (!st.primed) {
    st.fast = st.slow = intensity;
    st.primed = true;
  }
  // Paused, the loudness sinks to the resting arch; the measures hold, so a resume does not read as a build.
  if (playing) {
    st.fast = easeEnvelope(st.fast, intensity, dt, FAST_TAU);
    st.slow = easeEnvelope(st.slow, intensity, dt, SLOW_TAU);
  }
  const rel = Math.max(-1, Math.min(1, (st.fast - st.slow) / REL_SPAN));
  st.lv = drive === 0 ? 0 : Math.pow(clamp01((s.loudness - LOUD_LO) / (LOUD_HI - LOUD_LO)), LOUD_CURVE);
  if (live && s.cut > 0) st.sink = 1;
  st.sink = Math.max(0, st.sink - dt / SINK_SECS);
  st.lurch = Math.max(surge, st.lurch * Math.exp(-dt / LURCH_TAU));
  const lively = drive > LIVELY_DRIVE;
  const body = lively ? PACE_BODY_LIVELY : PACE_BODY_BALANCED;
  const [calmer, building] = lively ? SWING_LIVELY : SWING_BALANCED;
  const swing = rel < 0 ? 1 + (1 - calmer) * rel : 1 + (building - 1) * rel;
  // Calm and paused aim the spring at the cruise, so leaving or entering them eases the pace instead of stepping it.
  const target =
    drive === 0
      ? CALM_PACE
      : (PACE_QUIET + (body - PACE_QUIET) * st.lv * swing) *
        (1 + MID_PACE * midM) *
        (1 + LURCH_PACE * st.lurch) *
        (1 - 0.5 * st.sink);
  // The spring speeds up firmly, coasts down, and sinks faster after a cut; a drop is felt within about half a second.
  const up = target > st.speed;
  const [stiff, damp] = st.sink > 0 ? [9, 6] : up ? [6, 4.9] : [3.5, 3.7];
  st.vel += ((target - st.speed) * stiff - st.vel * damp) * dt;
  st.speed = Math.max(0.05, st.speed + st.vel * dt);
  // A kick pushes the orbit on, and the push eases out over PUSH_FALL.
  st.pushHold = Math.max(weight, st.pushHold * Math.exp(-dt / PUSH_FALL));
  // Two eases in a row start the push gently, so the pace never steps.
  st.pushIn = easeEnvelope(st.pushIn, st.pushHold, dt, PUSH_RISE);
  st.push = easeEnvelope(st.push, st.pushIn, dt, PUSH_RISE);
  st.pace = paceKnee(st.speed * (1 + PUSH_PACE * st.push * (1 - st.sink)));
  const omega = OMEGA * st.pace;
  st.phi += omega * dt;
  st.radius = easeEnvelope(st.radius, 1 - INSPIRAL * st.lv * Math.min(1, drive), dt, 0.8);
  const waveTarget = drive === 0 ? WAVE_BASE : WAVE_QUIET + (WAVE_LOUD - WAVE_QUIET) * st.lv + WAVE_BASS * bassM;
  st.waveA = easeEnvelope(st.waveA, waveTarget, dt, st.sink > 0 ? 0.12 : waveTarget > st.waveA ? 0.3 : 0.5);
  st.well = easeEnvelope(st.well, WELL_BASE + WELL_BASS * bassM, dt, 0.35);
  st.turb = easeEnvelope(st.turb, midM, dt, 0.4);
  st.high = easeEnvelope(st.high, highM, dt, 0.35);
  st.spin += dt * DISC_SPIN * (1 + 0.4 * st.turb);
  st.shine = easeEnvelope(st.shine, clamp01(s.level * 1.6), dt, 1.0);
  // Beat: a crest rides out at the wave's own speed, and a knot climbs each jet.
  const c = (2 * omega) / WAVE_K;
  for (const k of st.crests) {
    k.r += c * dt;
    k.age += dt;
  }
  // A beat's crest takes the highest weight while the beat is held, and is dropped if the final weight is slight.
  for (const k of st.crests) {
    if (!k.held) continue;
    k.h = Math.max(k.h, Math.min(1.5, weight));
    if (k.age >= WEIGHT_HOLD) k.held = false;
    else st.knotH = k.h;
  }
  st.crests = st.crests.filter((k) => k.age < CREST_LIFE && (k.held || k.h >= CREST_MIN));
  if (surge > 0) {
    // A surge sends one great wave, taller than any beat crest, and holds the beat crests back for the gap.
    st.lastCrest = st.clock;
    if (st.crests.length === CREST_SLOTS) st.crests.shift();
    const h = Math.min(SURGE_MAX, SURGE_CREST * surge);
    st.crests.push({ r: st.radius * 1.1, age: 0, h, held: false });
    st.knotAge = 0;
    st.knotH = Math.min(1.5, h);
  } else if (beat > 0 && st.clock - st.lastCrest >= CREST_GAP) {
    st.lastCrest = st.clock;
    if (st.crests.length === CREST_SLOTS) st.crests.shift();
    const h = Math.min(1.5, weight);
    st.crests.push({ r: st.radius * 1.1, age: 0, h, held: true });
    st.knotAge = 0;
    st.knotH = h;
  }
  st.crest.fill(0);
  const sunk = 1 - 0.8 * st.sink;
  st.crests.forEach((k, i) => {
    const fin = Math.min(1, k.age / 0.35);
    st.crest[i * 2] = k.r;
    st.crest[i * 2 + 1] = k.h * sunk * fin * fin * (3 - 2 * fin) * Math.exp(-k.age / 4);
  });
  st.knotAge += dt;
  const ka = st.knotAge / KNOT_LIFE;
  const kin = Math.min(1, st.knotAge / 0.15);
  st.knot[0] = ka;
  st.knot[1] = ka < 1 ? st.knotH * kin * (1 - ka) * 0.8 : 0;
}

const GRAVITATIONAL_WAVES_PROGRAM: ProgramSource = { name: "gravitational-waves", vs: FS_VS, fs: FS };
/** The programs gravitational-waves compiles, for warming the shader cache ahead of the stage. */
export const GRAVITATIONAL_WAVES_PROGRAMS: readonly ProgramSource[] = [GRAVITATIONAL_WAVES_PROGRAM];

export function createGravitationalWaves(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const st = createGravitationalWavesState();

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
      stepGravitationalWaves(st, f.sig, f.dt, f.playing);
      const p = kit.program(GRAVITATIONAL_WAVES_PROGRAM);
      setScene(kit, p, f, 0, null, art.tex);
      kit.set1(p, "uPhi", st.phi);
      kit.set1(p, "uOrbR", st.radius);
      kit.set1(p, "uWaveA", st.waveA);
      kit.set1(p, "uWell", st.well);
      kit.set1(p, "uSpin", st.spin);
      kit.set1(p, "uShine", st.shine);
      kit.set1(p, "uTurb", st.turb);
      kit.set1(p, "uHighE", st.high);
      kit.set1(p, "uWaveK", WAVE_K);
      kit.gl.uniform2fv(kit.uniform(p, "uCrest"), st.crest);
      kit.set2(p, "uKnot", st.knot[0], st.knot[1]);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
