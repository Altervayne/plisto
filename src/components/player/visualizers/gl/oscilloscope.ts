/*
 * Oscilloscope: the front of a bench oscilloscope whose beam draws a programme of figures over the song. One
 * full-screen opaque pass. The step evaluates the current figure (or the morph between two) as a curve over one
 * beam period, resamples it into a polyline that is dense where the curve turns, and gives every segment its
 * share of the period's time. The shader spreads that time along the segment, so the light per unit length is
 * 1/speed: turning points glow, fast strokes are faint, and the light on the glass is the same whatever the
 * figure. The same polyline from a tenth of a second earlier is drawn again, wide and dim, as the afterglow. The
 * glass fills the stage inside a thin frame; the cover sits on it as a paper label wherever the stage puts it, and
 * the beam passes behind it.
 *
 * Loudness sets the figure's size and depth, the spin and the beam's power, so a near-silent passage is a small,
 * slow, dim figure and a loud one fills the glass. Intensity's place in the range of the last 45 s picks the pool
 * of figures. A figure holds on a long timer or until the song changes section, then folds or blooms into the
 * next; a surge cuts to a new, larger figure, a cut squashes it toward a flat line for a moment. Bass deepens the
 * figure, mids set its harmonic, highs add fine detail, hits push those shape terms at once. A beat kicks the
 * phase, jumps the size and re-strikes the harmonograph by its weight.
 *
 * Photosensitivity: the beam's power follows the eased loudness (uPower); the phosphor bloom (uBloom), large-area
 * light, follows only the beat weight's envelope and a surge's slow lift, so it swells at most three times a
 * second. Hits move the thin trace, never the amount of light. Calm and paused zero every beat, hit and shift term.
 */

// -- Local Imports --
import { clamp01, createRng } from "./cozy";
import { CYBER_KIT, cyberGain } from "./cyber";
import { createCoverTexture } from "./coverTexture";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Geometry, Kit, ProgramSource } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** The beam, the programme and the reactions. */
export const SCOPE = {
  // Beam segments per frame, segments per culling box, curve samples before the resampling; the shader's NSEG and CH match.
  // The program needs about 445 fragment uniform vectors (uP, uD, uBox, uGlowP scale with NSEG): above the WebGL2
  // floor of 224, under the 1024 that Windows contexts give. Raising NSEG moves that ceiling.
  NSEG: 256,
  CHUNK: 8,
  FINE: 320,
  // Px of path a radian of turning is worth in the resampling, so tight curves get points.
  TURN_PX: 14,
  // Coarse beam samples for the wide glow (two per vec4), and how far they trail the beam, s.
  GLOW_N: 24,
  GLOW_TAU: 0.2,
  // Px the halo and the afterglow reach beyond a segment at beam scale 1; pads the culling boxes.
  REACH: 32,
  // Glass half height at which the beam's widths are drawn as written, and the clamp on that scale.
  BEAM_REF: 250,
  BEAM_SCALE: [0.8, 1.2],
  // Seconds behind the beam the afterglow path is taken from.
  GHOST_AGE: 0.11,
  // Share of the glass half size a unit figure spans, and the widest an X-Y figure is drawn against its height.
  FILL: 0.93,
  ASPECT: 2,
  // The frame round the glass, px: the bezel, the gap to the stage sides, the top strip and the control row above the floor.
  BEZEL: 14,
  EDGE: 14,
  TOP_ROOM: 26,
  FLOOR_ROOM: 48,
  // Intensity against its 17 s mean, and the song's range held over about 45 s for the density.
  FAST_TAU: 1,
  SLOW_TAU: 17,
  REL_SPAN: 0.25,
  RANGE_TAU: 45,
  DENSITY_TAU: 2.5,
  // Seconds a figure holds on the long timer, the shortest hold before a section change can cut in, and morph lengths.
  HOLD: [17, 25],
  HOLD_CALM: [28, 36],
  MIN_HOLD: 8,
  MORPH: 2.8,
  MORPH_SECTION: 2.0,
  MORPH_CALM: 3.6,
  // A surge cuts to a new figure once the current one has held this long, with this morph.
  SURGE_HOLD: 2,
  MORPH_SURGE: 1.1,
  // Motion caps: spin and phase drift in rad/s, the phase kick per unit of beat weight and its ease.
  SPIN: [0.06, 0.6],
  DRIFT: [0.06, 0.75],
  KICK: 0.75,
  KICK_TAU: 0.28,
  // Figure size against the glass: near silence to loud, the jump a full-weight beat adds, and its fall.
  // The quiet end keeps the figure round the label on the Player stage.
  SIZE: [0.66, 0.86],
  POP: 0.22,
  POP_TAU: 0.3,
  // Above this size the figure is eased toward 1, so a kick on a loud figure stays on the glass.
  KNEE: 0.88,
  // A surge's lift on the size and its fall; a cut's squash across and up, its rise and fall.
  SURGE_SIZE: 0.25,
  SURGE_TAU: 2.5,
  CUT_X: 0.55,
  CUT_Y: 0.94,
  CUT_UP: 0.06,
  CUT_TAU: 1,
  // Hit envelopes' fall, and the phosphor bloom's fall after a beat.
  HIT_TAU: 0.12,
  BLOOM_TAU: 0.25,
  // Beam power: at silence and the share loudness adds.
  POWER: [0.25, 0.95],
  // Harmonograph strike: decay time, resting scale, and the shortest gap between re-strikes (under the beat gap).
  STRIKE_TAU: 5,
  STRIKE_REST: 0.74,
  STRIKE_GAP: 0.28,
} as const;

const RNG_SEED = 1234567;
const TAU = Math.PI * 2;
// Frames of past paths kept for the afterglow.
const HISTORY = 16;
// How fast each of the three phase offsets drifts and takes the beat kick, relative to the main phase.
const WPH_DRIFT = [0.6, 0.9, 1.4] as const;
const WPH_KICK = [0.5, 0.8, 1.2] as const;

type Figure = "trace" | "lissajous" | "rings" | "rose" | "spiro" | "harmono" | "coil" | "octa" | "wool";

// Figure pools by the song's density: quiet intros, the build, the drop.
const POOLS: readonly (readonly Figure[])[] = [
  ["trace", "rings", "lissajous", "harmono"],
  ["rose", "lissajous", "harmono", "octa", "rings"],
  ["spiro", "coil", "wool", "lissajous", "octa"],
];
const FIGURES: readonly Figure[] = ["trace", "lissajous", "rings", "rose", "spiro", "harmono", "coil", "octa", "wool"];
const RATIOS = [[1, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6], [5, 7]] as const;
const SPIRO = [[1, 5], [2, 9], [2, 7], [3, 10], [3, 11], [1, 6]] as const;
const OCTA = [0, 2, 1, 3, 4, 1, 5, 2, 4, 0, 3, 5, 0] as const;
const OCTA_V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const WOOL_W = [1, 1.37, 1.93, 2.71, 3.4] as const;
const WOOL_A = [1, 0.72, 0.55, 0.42, 0.3] as const;

/** A figure picked for the song, with the settings it was picked with. */
export type Instance =
  | { fig: "trace" | "rings" | "octa" | "wool" }
  | { fig: "lissajous"; base: number }
  | { fig: "rose"; k: number }
  | { fig: "spiro"; pq: readonly [number, number] }
  | { fig: "harmono"; f: readonly [number, number] }
  | { fig: "coil"; w: number };

/** The eased drivers every figure reads: bands, phases, spin and the figure's own ratios. */
export interface Drivers {
  bass: number;
  mid: number;
  high: number;
  midSlow: number;
  // Loudness 0..1, and the hit envelopes 0..1.
  loud: number;
  bh: number;
  mh: number;
  hh: number;
  // The figure's size against the glass, the beat's jump on it, a surge's lift and a cut's squash.
  size: number;
  pop: number;
  surge: number;
  cut: number;
  cutTo: number;
  // The phosphor bloom after a beat.
  bloom: number;
  spin: number;
  phase: number;
  spinV: number;
  driftV: number;
  kick: number;
  kickTo: number;
  wph: [number, number, number];
  slow: number;
  strike: number;
  strikeTo: number;
  hp: number;
  hpTo: number;
  rings: number;
  ringR: [number, number, number, number];
  la: number;
  lb: number;
  cs3: number;
  sn3: number;
}

/** The programme: the figure on the glass, the one morphing in, and how far along the morph is. */
export interface Programme {
  cur: Instance;
  next: Instance | null;
  s: number;
  kind: "fold" | "bloom";
  dur: number;
  held: number;
  hold: number;
  wasUp: boolean;
  wasDown: boolean;
}

/** A point of the unit box and whether the beam is on there (0..1). */
interface BeamPoint {
  x: number;
  y: number;
  b: number;
}

/** A past frame's path, kept for the afterglow. */
interface PathSlot {
  t: number;
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
}

// -- The figures. Each maps beam time u (0..1, one period) to a point of the unit box and the beam on (b). --

function wave(s: number, ch: number, P: Drivers): number {
  const w = P.wph;
  if (ch === 0) {
    return (
      (0.08 + 0.14 * P.bass + 0.1 * P.loud + 0.2 * P.bh) * Math.sin(TAU * 1.5 * s + w[0]) +
      (0.03 + 0.08 * P.mid + 0.11 * P.mh) * (Math.sin(TAU * 5 * s + w[1]) + 0.5 * Math.sin(TAU * 7.5 * s - w[1] * 1.3)) +
      (0.008 + 0.035 * P.high + 0.06 * P.hh) * Math.sin(TAU * 19 * s + w[2])
    );
  }
  return (
    (0.12 + 0.12 * P.bass + 0.1 * P.loud + 0.2 * P.bh) * Math.sin(TAU * s + w[0] * 0.7 + 1.1) +
    (0.03 + 0.07 * P.mid + 0.12 * P.mh) * Math.sin(TAU * 3 * s - w[1] * 0.8) +
    (0.006 + 0.03 * P.high + 0.05 * P.hh) * Math.sin(TAU * 13 * s - w[2])
  );
}

// A 3D point turned about the vertical axis by spin and tilted toward the viewer, with a little perspective.
function project(x: number, y: number, z: number, spin: number, tilt: number, o: BeamPoint): void {
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  const x1 = x * cs - y * sn;
  const y1 = x * sn + y * cs;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const y2 = y1 * ct - z * st;
  const z2 = y1 * st + z * ct;
  const f = 1 / (1 + 0.22 * z2);
  o.x = x1 * f;
  o.y = y2 * f;
}

type FigureFn<I> = (u: number, I: I, P: Drivers, o: BeamPoint) => void;

const FIG: { [K in Instance["fig"]]: FigureFn<Extract<Instance, { fig: K }>> } = {
  // Y-T: the time base sweeps two channels, above and below the label, with the retrace blanked.
  trace(u, _I, P, o) {
    const ch = u < 0.5 ? 0 : 1;
    const v = (u - ch * 0.5) * 2;
    const base = ch ? -0.64 : 0.64;
    if (v < 0.93) {
      const s = v / 0.93;
      o.x = -1 + 2 * s;
      o.y = base + wave(s, ch, P);
      o.b = 1;
    } else {
      const s = (v - 0.93) / 0.07;
      const e = s * s * (3 - 2 * s);
      const y0 = base + wave(1, ch, P);
      const y1 = (ch ? 0.64 : -0.64) + wave(0, 1 - ch, P);
      o.x = 1 - 2 * e;
      o.y = y0 + (y1 - y0) * e;
      o.b = 0;
    }
  },
  // Lissajous: the ratio glides between whole numbers (open while it slides), the phase drifts so it tumbles.
  lissajous(u, _I, P, o) {
    const a = P.la;
    const b = P.lb;
    const th = TAU * u;
    const lo = 0.1 * P.bass + 0.16 * P.bh;
    o.x = Math.sin(a * th + P.phase) * (1 - 0.06 * P.mh) + 0.018 * P.high * Math.sin(31 * th) + 0.06 * P.mh * Math.sin(3 * a * th - P.phase);
    o.y = Math.sin(b * th) * (1 - lo) + lo * Math.sin(2 * b * th + 0.6) + 0.03 * P.hh * Math.sin(23 * th);
    o.b = 1;
  },
  // Nested rings drawn as one stroke, each with its own ripple; they split from one another as the music fills.
  rings(u, _I, P, o) {
    const K = 4;
    const k = Math.min(K - 1, Math.floor(u * K));
    const v = u * K - k;
    const R = P.ringR;
    const rip = (j: number, th: number) =>
      j === 0
        ? (0.05 * P.bass + 0.12 * P.bh) * Math.sin(3 * th + P.spin * 2)
        : j === 1
          ? (0.035 * P.mid + 0.08 * P.mh) * Math.sin(6 * th - P.phase)
          : j === 2
            ? (0.02 * P.high + 0.05 * P.hh) * Math.sin(13 * th + P.phase * 1.5)
            : (0.03 + 0.04 * P.loud) * Math.sin(2 * th + P.spin);
    const rot = (k & 1 ? -1 : 1) * P.spin * (0.6 + 0.2 * k);
    if (v < 0.9) {
      const th = (TAU * v) / 0.9 + rot;
      const r = R[k] * (1 + rip(k, th));
      o.x = r * Math.cos(th);
      o.y = r * Math.sin(th);
      o.b = 1;
    } else {
      // Between rings the beam slides out to the next; from the outermost it returns blanked.
      const s = (v - 0.9) / 0.1;
      const e = s * s * (3 - 2 * s);
      const k2 = (k + 1) % K;
      const th0 = TAU + rot;
      const th1 = (k2 & 1 ? -1 : 1) * P.spin * (0.6 + 0.2 * k2);
      const dth = th1 - th0 - TAU * Math.round((th1 - th0) / TAU);
      const th = th0 + dth * e;
      const r = R[k] * (1 + rip(k, th0)) * (1 - e) + R[k2] * (1 + rip(k2, th1)) * e;
      o.x = r * Math.cos(th);
      o.y = r * Math.sin(th);
      o.b = k === K - 1 ? 0 : 1;
    }
  },
  // A woven rose: two passes of petals, the second set between the first, the petals' depth from the bass,
  // the loudness and the bass hits.
  rose(u, I, P, o) {
    const pass = u < 0.5 ? 0 : 1;
    const th = TAU * (u * 2 - pass) + P.spin * 0.5;
    const depth = 0.13 + 0.08 * P.bass + 0.1 * P.loud + 0.16 * P.bh;
    const r = (pass ? 0.78 : 0.72) + depth * Math.cos(I.k * th + pass * Math.PI + P.phase * 0.5 + 0.4 * P.mh);
    o.x = r * Math.cos(th);
    o.y = r * Math.sin(th);
    o.b = 1;
  },
  // A spirograph (epitrochoid): a wheel rolled round the outside of a ring, its pen past the rim so it loops; the
  // wheel's ratio picked with the figure, the pen's reach from the bass, the loudness and the bass hits.
  spiro(u, I, P, o) {
    const [p, q] = I.pq;
    const r = p / q;
    const R = 1 + r;
    const d = r * (1.1 + 0.4 * P.bass + 0.3 * P.loud + 0.6 * P.bh);
    const t = TAU * p * u;
    const n = 1 / (R + d);
    const rot = P.spin * 0.4;
    const x = R * Math.cos(t) - d * Math.cos((R / r) * t);
    const y = R * Math.sin(t) - d * Math.sin((R / r) * t);
    o.x = (x * Math.cos(rot) - y * Math.sin(rot)) * n;
    o.y = (x * Math.sin(rot) + y * Math.cos(rot)) * n;
    o.b = 1;
  },
  // A harmonograph: two pendulums per axis, slightly detuned, decaying inward; struck again on a beat.
  harmono(u, I, P, o) {
    const [fa, fb] = I.f;
    const C = 8 / Math.max(fa, fb);
    const tau = TAU * C * u;
    const env = Math.exp(-1.0 * u) * P.strike * 1.08;
    const det = 0.03 + 0.02 * Math.sin(P.slow * 0.05) + 0.04 * P.mh;
    // A bass hit shifts weight onto the second pendulum.
    const w2 = 0.38 + 0.16 * P.bh;
    o.x = env * ((1 - w2) * Math.sin(fa * tau + P.phase) + w2 * Math.sin((fb + det) * tau + P.hp));
    o.y = env * ((1 - w2) * Math.sin(fb * tau) + w2 * Math.sin((fa - det) * tau + P.hp * 0.7 + 1.3));
    o.b = 1;
  },
  // A rotating wireframe torus coil, one continuous stroke round the tube as it goes round the ring.
  coil(u, I, P, o) {
    const phi = TAU * u;
    const psi = TAU * I.w * u + P.phase;
    const rt = 0.18 + 0.04 * P.high + 0.06 * P.loud + 0.1 * P.mh;
    const rm = 0.74;
    const x = (rm + rt * Math.cos(psi)) * Math.cos(phi);
    const y = (rm + rt * Math.cos(psi)) * Math.sin(phi);
    const z = rt * Math.sin(psi);
    project(x, y, z, P.spin * 0.5, 0.78 + 0.22 * P.bass + 0.3 * P.bh + 0.15 * Math.sin(P.slow * 0.11), o);
    o.b = 1;
  },
  // A rotating octahedron drawn edge after edge on its Euler circuit; the beam slows into each corner.
  octa(u, _I, P, o) {
    const e = Math.min(11, Math.floor(u * 12));
    const s0 = u * 12 - e;
    const s = s0 + 0.7 * (s0 * s0 * (3 - 2 * s0) - s0);
    const a = OCTA_V[OCTA[e]];
    const b = OCTA_V[OCTA[e + 1]];
    const k = 0.9 + 0.06 * P.bass + 0.18 * P.bh;
    project(
      (a[0] + (b[0] - a[0]) * s) * k,
      (a[1] + (b[1] - a[1]) * s) * k,
      (a[2] + (b[2] - a[2]) * s) * k,
      P.spin * 0.7,
      0.55 + 0.25 * Math.sin(P.slow * 0.09) + 0.25 * P.mh,
      o,
    );
    o.b = 1;
  },
  // A stereo vectorscope: mid up, side across. Five partials at odd ratios wind a ball of wool; highs widen the stereo.
  wool(u, _I, P, o) {
    const tau = TAU * 5 * u;
    const w = 1.3 + 1.1 * P.high + 0.8 * P.hh;
    let L = 0;
    let R = 0;
    for (let k = 0; k < 5; k++) {
      const om = WOOL_W[k];
      const a = WOOL_A[k];
      const ph = P.wph[k % 3] * (1 + 0.3 * k) + k * 1.7;
      L += a * Math.sin(om * tau + ph);
      R += a * Math.sin(om * tau + ph + w * (0.5 + 0.35 * k));
    }
    // The strands are drawn out toward a sphere's rim, so the ball shows round the label.
    const m = (L + R) * 0.5 * (0.85 + 0.25 * P.bass + 0.35 * P.bh);
    const sd = (L - R) * 0.5;
    const rr = Math.sqrt(m * m + sd * sd) + 1e-6;
    const k = Math.tanh(1.0 * rr) / rr;
    const c = P.cs3;
    const sn = P.sn3;
    o.x = (sd * c - m * sn) * k;
    o.y = (sd * sn + m * c) * k;
    o.b = 1;
  },
};

function figureAt(I: Instance, u: number, P: Drivers, o: BeamPoint): void {
  (FIG[I.fig] as FigureFn<Instance>)(u, I, P, o);
}

const FS = `${SCENE_PRELUDE}${CYBER_KIT}
const int NSEG = ${SCOPE.NSEG};
const int CH = ${SCOPE.CHUNK};
const int NC = ${SCOPE.NSEG / SCOPE.CHUNK};
const int NG = ${SCOPE.GLOW_N / 2};
uniform vec4 uGlass;          // glass centre and half size, css px
uniform vec4 uP[${SCOPE.NSEG + 1}];  // beam path, css px from the glass centre: xy now, zw a moment ago
uniform vec4 uD[${SCOPE.NSEG / 2}];  // each segment's share of the beam's time: now, then; two segments per entry
uniform vec4 uBox[${SCOPE.NSEG / SCOPE.CHUNK}];  // culling box of each chunk of segments, padded by the reach
uniform vec4 uGlowP[${SCOPE.GLOW_N / 2}];  // coarse beam samples for the wide glow, two per entry
uniform float uPower;         // beam power: the eased loudness
uniform float uBloom;         // phosphor bloom: the beat envelope and a surge's lift, eased
uniform float uMode;          // 0 Y-T, 1 X-Y: the mode switch
uniform vec4 uKnobA;          // knob angles: X, Y, phase, time base
uniform vec2 uKnobB;          // intensity, programme
uniform float uSlow;          // seconds, for the lamps
// -- Tunables --
const float BEZEL = ${SCOPE.BEZEL.toFixed(1)};     // bezel width, px
const float TOP_ROOM = ${SCOPE.TOP_ROOM.toFixed(1)};  // the nameplate strip above the bezel, px
const float FLOOR_ROOM = ${SCOPE.FLOOR_ROOM.toFixed(1)};  // the control row below the bezel, px
const float BEAM_REF = ${SCOPE.BEAM_REF.toFixed(1)};  // glass half height at which the widths below hold
const vec2 BEAM_SCALE = vec2(${SCOPE.BEAM_SCALE[0].toFixed(2)}, ${SCOPE.BEAM_SCALE[1].toFixed(2)});
const float SIG = 1.3;        // beam core sigma at the centre of the glass, px
const float FOCUS = 0.6;      // core sigma growth toward the glass edge
const float HALO = 9.0;       // halo half width, px
const float HCUT = 0.08;      // halo floor removed so it ends at the reach (30 px)
const float GHO = 10.0;       // afterglow half width, px
const float GCUT = 0.10;      // (30 px)
const float GLOW_R = 120.0;   // reach of the wide glow that lights the glass and the graticule, px
const float K_CORE = 16.0;    // light of the core per unit of beam time per px
const float K_HALO = 2.6;
const float K_GHOST = 1.1;
const float K_GLOW = 0.075;
float edge(float x) { return x * inversesqrt(1.0 + x * x); }
// A cheaper end for the wide terms: linear over a width either side.
float ramp(float x) { return clamp(x, -1.0, 1.0); }
// The beam's light at q: the core, the halo and the afterglow, each spread along its segments as 1/speed.
vec3 beam(vec2 q, float sc, float bs) {
  float core = 0.0, halo = 0.0, ghost = 0.0;
  float hw = HALO * bs, gw = GHO * bs;
  float kc = 0.5 / (sc * sc), ic = 0.9 / sc, kh = 1.0 / (hw * hw), ih = 0.6 / hw, kg = 1.0 / (gw * gw), ig = 0.6 / gw;
  for (int c = 0; c < NC; c++) {
    vec4 bb = uBox[c];
    if (q.x < bb.x || q.y < bb.y || q.x > bb.z || q.y > bb.w) continue;
    for (int j = 0; j < CH; j++) {
      int i = c * CH + j;
      vec4 A = uP[i], B = uP[i + 1];
      vec4 dd = uD[i >> 1];
      vec2 w = (i & 1) == 0 ? dd.xy : dd.zw;
      vec2 ba = B.xy - A.xy, pa = q - A.xy;
      float L2 = dot(ba, ba) + 1e-3, il = inversesqrt(L2), L = L2 * il;
      float t = dot(pa, ba) * il, d2 = max(dot(pa, pa) - t * t, 0.0);
      float wn = w.x * il;
      core += wn * exp(-d2 * kc) * (edge(t * ic) + edge((L - t) * ic));
      halo += wn * max(1.0 / (1.0 + d2 * kh) - HCUT, 0.0) * (ramp(t * ih) + ramp((L - t) * ih));
      // The afterglow is wide and dim, so it is drawn on segments two at a time.
      if ((j & 1) == 0) {
        vec4 C = uP[i + 2];
        ba = C.zw - A.zw; pa = q - A.zw;
        L2 = dot(ba, ba) + 1e-3; il = inversesqrt(L2); L = L2 * il;
        t = dot(pa, ba) * il; d2 = max(dot(pa, pa) - t * t, 0.0);
        ghost += (dd.y + dd.w) * il * max(1.0 / (1.0 + d2 * kg) - GCUT, 0.0) * (ramp(t * ig) + ramp((L - t) * ig));
      }
    }
  }
  return vec3(core, halo, ghost);
}
// A metal control knob: a recess, a knurled body with a lit rim, a pointer and a ring of ticks.
vec4 knob(vec2 l, float ang, float R, bool dk) {
  float r = length(l);
  float rec = soft(r - R - 4.0, 0.7);
  float body = soft(r - R, 0.7);
  float a = atan(l.y, l.x);
  float knurl = 0.5 + 0.5 * sin(a * 26.0);
  vec3 metal = dk ? vec3(0.34, 0.35, 0.38) : vec3(0.20, 0.21, 0.24);
  float lit = clamp(dot(l / max(r, 1.0), normalize(vec2(-0.6, 0.8))), -1.0, 1.0);
  vec3 c = metal * (0.75 + 0.25 * lit + 0.12 * knurl * smoothstep(R * 0.55, R * 0.95, r));
  c = mix(c, metal * 1.25, soft(abs(r - R * 0.58) - 0.5, 0.5) * 0.5);
  vec2 pd = vec2(cos(ang), sin(ang));
  float ptr = soft(sdSeg(l, pd * R * 0.30, pd * R * 0.88) - 1.1, 0.6);
  c = mix(c, vec3(0.96, 0.96, 0.93), ptr);
  float tk = 0.0;
  for (int i = 0; i < 11; i++) {
    float ta = radians(-135.0 + 27.0 * float(i)) + 1.5707963;
    vec2 td = vec2(cos(ta), sin(ta));
    tk = max(tk, soft(sdSeg(l, td * (R + 5.5), td * (R + 8.0)) - 0.5, 0.5));
  }
  vec3 base = dk ? vec3(0.030, 0.032, 0.038) : vec3(0.52, 0.52, 0.52);
  vec3 out1 = mix(base, c, body);
  out1 = mix(out1, dk ? vec3(0.62, 0.64, 0.62) : vec3(0.12, 0.12, 0.13), tk * 0.7);
  return vec4(out1, max(rec, tk));
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, sz = uRes / uDpr, cc = coverCenter() / uDpr;
  float cw = uCover.z / uDpr;
  float hu = hushAt(fc);
  float det = 1.0 - 0.7 * hu;
  bool dk = uLight < 0.5;
  vec2 sc = uGlass.xy, hs = uGlass.zw;
  float rad = 0.10 * cw;
  vec2 lp = p - sc;
  float gd = sdRound(lp, hs, rad);
  float bz = sdRound(lp, hs + vec2(BEZEL), rad + BEZEL * 0.7);
  // -- Panel: brushed graphite (or light grey), with a faint grain along x --
  vec3 panel = dk ? vec3(0.072, 0.078, 0.095) : vec3(0.66, 0.74, 0.90);
  panel *= 0.94 + 0.12 * vnoise(vec2(p.x * 0.012, p.y * 1.4));
  panel *= 1.0 - 0.18 * smoothstep(0.6, 1.2, length((p / sz - 0.5) * vec2(1.0, 0.9)));
  vec3 col = panel;
  // -- Bezel: a bevel lit from the top left --
  // The bevel's normal by central differences, only where the bezel is.
  if (bz < 2.0 && gd > -4.0) {
    vec2 e = vec2(1.0, 0.0);
    vec2 nrm = normalize(vec2(sdRound(lp + e.xy, hs + vec2(BEZEL), rad + BEZEL * 0.7) - sdRound(lp - e.xy, hs + vec2(BEZEL), rad + BEZEL * 0.7), sdRound(lp + e.yx, hs + vec2(BEZEL), rad + BEZEL * 0.7) - sdRound(lp - e.yx, hs + vec2(BEZEL), rad + BEZEL * 0.7)) + 1e-5);
    float lit = dot(nrm, normalize(vec2(-0.55, 0.83)));
    float inner = smoothstep(0.0, BEZEL, -bz);
    vec3 bezc = (dk ? vec3(0.115, 0.122, 0.138) : vec3(0.66, 0.66, 0.65)) * (0.82 + 0.28 * lit * (1.0 - inner) - 0.30 * smoothstep(0.55, 1.0, inner));
    bezc *= 1.0 - 0.28 * smoothstep(-6.0, 0.0, gd) * step(0.0, gd);
    col = mix(col, bezc, soft(bz, 0.8));
    col += (dk ? 0.10 : 0.12) * exp(-pow(bz / 1.2, 2.0)) * smoothstep(-0.3, 0.8, lit) * soft(bz + 2.0, 0.5);
  }
  // The four screws at the bezel corners.
  if (abs(bz + BEZEL * 0.5) < BEZEL + 8.0) for (int k = 0; k < 4; k++) {
    vec2 sp = sc + vec2(k < 2 ? -1.0 : 1.0, (k & 1) == 0 ? -1.0 : 1.0) * (hs + vec2(BEZEL * 0.5 + 2.0)) * vec2(0.985, 0.985);
    vec2 d = p - sp;
    float sm = soft(length(d) - 4.4, 0.6);
    float slot = soft(sdBox(rot(0.5 + float(k)) * d, vec2(3.6, 0.6)), 0.4);
    vec3 sc3 = (dk ? vec3(0.42, 0.43, 0.46) : vec3(0.50, 0.50, 0.52)) * (0.85 + 0.2 * dot(d / 4.4, vec2(-0.6, 0.8)));
    col = mix(col, mix(sc3, vec3(0.05), slot), sm * step(bz, 0.0));
  }
  // -- Glass --
  if (gd < 2.0) {
    vec2 u = lp / hs;
    float rr = dot(u * vec2(0.8, 1.0), u * vec2(0.8, 1.0));
    vec2 g = u * (1.0 + 0.035 * rr);
    // The label covers the beam: it is paper stuck on the glass.
    vec2 ll = rot(0.022) * (p - cc);
    float lsd = sdBox(ll, vec2(0.5 * cw + 5.0)) - 1.5;
    // The beam, unless this pixel is under the label.
    vec3 bm = vec3(0.0);
    float wide = 0.0;
    if (lsd > -2.0) {
      float bs = clamp(hs.y / BEAM_REF, BEAM_SCALE.x, BEAM_SCALE.y);
      float sig0 = SIG * bs;
      float sig = sig0 * (1.0 + FOCUS * rr);
      bm = beam(lp, sig, bs);
      bm.x *= sig0 / sig;
      float gr = GLOW_R * bs;
      for (int k = 0; k < NG; k++) {
        vec4 gp = uGlowP[k];
        vec2 d1 = (lp - gp.xy) / gr, d2 = (lp - gp.zw) / gr;
        wide += 1.0 / (1.0 + dot(d1, d1) * 4.0) + 1.0 / (1.0 + dot(d2, d2) * 4.0);
      }
    }
    // The bloom swells the halo and the wide glow, the phosphor's large-area light.
    float pw = uPower * det;
    float eCore = bm.x * K_CORE * pw, eHalo = bm.y * K_HALO * pw * (1.0 + 0.7 * uBloom), eGhost = bm.z * K_GHOST * pw, eWide = wide * K_GLOW * pw * (1.0 + 1.4 * uBloom);
    vec3 glass = dk ? vec3(0.007, 0.013, 0.010) : vec3(0.90, 0.94, 0.91);
    // Under the middle of the label only the paper shows, so the glass is not shaded there.
    if (lsd > -7.0) {
    glass += (dk ? vec3(0.006, 0.034, 0.018) : vec3(-0.02, 0.0, -0.02)) * (1.0 - 0.7 * rr) * (0.6 + 0.8 * uPower);
    glass *= 1.0 - 0.35 * smoothstep(0.55, 1.1, rr * 0.8 + 0.1 * abs(u.x));
    // Graticule: eight divisions high and an even count across that keeps them near square, brighter centre
    // axes with fine ticks, lit a little by the trace nearby.
    vec2 ndv = vec2(2.0 * floor(4.0 * hs.x / hs.y + 0.5), 8.0);
    vec2 pdv = hs * 2.0 / ndv;
    vec2 gp = (g * 0.5 + 0.5) * ndv;
    float vline = 1.0 - smoothstep(0.35, 1.0, abs(fract(gp.x + 0.5) - 0.5) * pdv.x);
    float hline = 1.0 - smoothstep(0.35, 1.0, abs(fract(gp.y + 0.5) - 0.5) * pdv.y);
    float dotsV = step(0.5, fract(gp.y * 5.0));
    float dotsH = step(0.5, fract(gp.x * 5.0));
    float grid = max(vline * (0.45 + 0.55 * dotsV), hline * (0.45 + 0.55 * dotsH));
    float axis = max(1.0 - smoothstep(0.4, 1.2, abs(g.x * hs.x)), 1.0 - smoothstep(0.4, 1.2, abs(g.y * hs.y)));
    float tickLen = max((1.0 - smoothstep(2.5, 4.0, abs(g.y * hs.y))) * (1.0 - smoothstep(0.1, 0.18, abs(fract(gp.x * 5.0) - 0.5))), (1.0 - smoothstep(2.5, 4.0, abs(g.x * hs.x))) * (1.0 - smoothstep(0.1, 0.18, abs(fract(gp.y * 5.0) - 0.5))));
    float gm = clamp(grid * 0.16 + axis * 0.18 + tickLen * 0.35, 0.0, 0.6) * det;
    vec3 phos = vec3(0.28, 1.0, 0.42);
    if (dk) {
      glass = mix(glass, vec3(0.20, 0.55, 0.32), gm * (0.75 + 0.5 * uPower + 2.5 * clamp(eWide, 0.0, 0.4)));
      // Phosphor: a soft wide glow, the afterglow, the halo, then the core going from green to white-hot.
      glass += phos * (1.0 - exp(-eWide)) * 0.35;
      glass += vec3(0.20, 0.85, 0.35) * (1.0 - exp(-eGhost)) * 0.55;
      glass += phos * (1.0 - exp(-eHalo)) * 0.75;
      float hot = 1.0 - exp(-eCore);
      glass += mix(phos, vec3(0.88, 1.0, 0.90), smoothstep(0.35, 1.0, hot) * 0.85) * hot;
    } else {
      // Light: a pale display; the beam inks it a deep phosphor green, the halo and the afterglow tint it.
      glass = mix(glass, vec3(0.25, 0.45, 0.32), gm * (0.6 + 2.0 * clamp(eWide, 0.0, 0.4)));
      glass = mix(glass, vec3(0.70, 0.90, 0.78), clamp(1.0 - exp(-eWide), 0.0, 1.0) * 0.5);
      glass = mix(glass, vec3(0.30, 0.68, 0.52), (1.0 - exp(-(eGhost * 0.7 + eHalo * 0.6))) * 0.75);
      glass = mix(glass, vec3(0.0, 0.30, 0.20), (1.0 - exp(-eCore * 2.0)) * 0.95);
    }
    }
    // The paper label: the cover, stuck on the glass a little askew, with a white edge and a short shadow.
    if (lsd < 12.0) {
      glass *= 1.0 - 0.45 * soft(sdBox(rot(0.022) * (p - cc - vec2(2.0, -3.0)), vec2(0.5 * cw + 5.0)) - 1.5 - 2.0, 3.5) * (1.0 - soft(lsd, 0.7));
      vec3 paper = vec3(0.93, 0.92, 0.88) * (dk ? 0.86 : 1.0);
      vec3 art = coverAt(ll / (cw + 4.0) + 0.5, 0.0) * (dk ? 0.92 : 1.0);
      glass = mix(glass, paper, soft(lsd, 0.7));
      glass = mix(glass, art, soft(lsd + 5.0, 0.7));
    }
    // A soft reflection of the room across the upper left of the glass, fixed.
    float band = exp(-pow((dot(u, normalize(vec2(1.0, -0.9))) + 0.42) / 0.10, 2.0)) * 0.7 + exp(-pow((dot(u, normalize(vec2(1.0, -0.9))) + 0.12) / 0.05, 2.0)) * 0.3;
    glass += (dk ? vec3(0.55, 0.65, 0.75) : vec3(0.6)) * band * (dk ? 0.030 : 0.10) * (1.0 - hu * 0.5);
    col = mix(col, glass, soft(gd + 2.0, 0.8));
  }
  // -- Top strip: nameplate and three lamps --
  float topY = sc.y + hs.y + BEZEL + TOP_ROOM * 0.5;
  if (p.y > topY - 20.0) {
    vec2 np = vec2(sc.x - hs.x + 12.0, topY);
    float plate = soft(sdBox(p - (np + vec2(74.0, 0.0)), vec2(78.0, 10.0)) - 2.0, 0.7);
    col = mix(col, dk ? vec3(0.035, 0.038, 0.045) : vec3(0.66, 0.66, 0.64), plate);
    float txt = silkText(p, np + vec2(4.0, -2.5), 17.0, 11.0);
    col = mix(col, dk ? vec3(0.78, 0.80, 0.78) : vec3(0.10, 0.10, 0.12), txt * plate * 0.9);
    for (int k = 0; k < 3; k++) {
      vec2 lc = vec2(sc.x + hs.x - 30.0 - 26.0 * float(k), topY);
      float lm = soft(length(p - lc) - 4.0, 0.6);
      vec3 lcol = k == 0 ? vec3(0.25, 1.0, 0.35) : (k == 1 ? vec3(1.0, 0.7, 0.2) : vec3(0.3, 0.8, 1.0));
      float breath = 0.85 + 0.15 * sin(uSlow * 0.5 + float(k) * 2.0);
      col = mix(col, dk ? lcol * 0.9 * breath : lcol * 0.85, lm);
      col += lcol * exp(-pow(length(p - lc) / 7.0, 2.0)) * (dk ? 0.28 : 0.10) * breath;
    }
  }
  // -- Bottom strip: two BNC sockets (X and Y), six knobs, the Y-T / X-Y switch --
  float rowY = sc.y - hs.y - BEZEL - FLOOR_ROOM * 0.5;
  if (p.y < rowY + 26.0 && p.y > rowY - 26.0) {
    float x0 = sc.x - hs.x;
    for (int k = 0; k < 2; k++) {
      vec2 bc = vec2(x0 + 22.0 + 36.0 * float(k), rowY);
      vec2 d = p - bc;
      float ring = soft(length(d) - 10.0, 0.7);
      float hole = soft(length(d) - 6.0, 0.7);
      float pin = soft(length(d) - 1.8, 0.6);
      float nub = soft(sdBox(rot(0.8) * d, vec2(11.5, 1.5)), 0.5);
      vec3 mt = (dk ? vec3(0.50, 0.52, 0.55) : vec3(0.36, 0.37, 0.40)) * (0.8 + 0.25 * dot(d / 10.0, vec2(-0.6, 0.8)));
      col = mix(col, mt, max(ring, nub));
      col = mix(col, dk ? vec3(0.02) : vec3(0.08), hole);
      col = mix(col, mt * 1.3, pin);
    }
    float span = 2.0 * hs.x - 210.0;
    float gap = clamp(span / 6.0, 34.0, 62.0);
    for (int k = 0; k < 6; k++) {
      vec2 kc = vec2(x0 + 112.0 + gap * float(k), rowY);
      if (abs(p.x - kc.x) > 22.0) continue;
      float ang = k == 0 ? uKnobA.x : (k == 1 ? uKnobA.y : (k == 2 ? uKnobA.z : (k == 3 ? uKnobA.w : (k == 4 ? uKnobB.x : uKnobB.y))));
      vec4 kn = knob(p - kc, ang, 11.5, dk);
      col = mix(col, kn.rgb, kn.a);
      col = mix(col, kn.rgb, soft(length(p - kc) - 11.5, 0.7));
    }
    // The mode switch: a slide in a slot, an LED for each mode; the lit one follows the beam's mode.
    vec2 swc = vec2(sc.x + hs.x - 34.0, rowY - 4.0);
    float slotM = soft(sdBox(p - swc, vec2(16.0, 4.5)) - 2.0, 0.6);
    col = mix(col, dk ? vec3(0.015) : vec3(0.25), slotM);
    vec2 th = swc + vec2(mix(-8.0, 8.0, uMode), 0.0);
    float thumb = soft(sdBox(p - th, vec2(6.0, 6.0)) - 1.5, 0.6);
    col = mix(col, (dk ? vec3(0.62, 0.63, 0.66) : vec3(0.85, 0.85, 0.86)) * (0.85 + 0.25 * smoothstep(-6.0, 6.0, p.y - th.y)), thumb);
    for (int k = 0; k < 2; k++) {
      vec2 lc = swc + vec2(k == 0 ? -12.0 : 12.0, 14.0);
      float on = k == 0 ? 1.0 - uMode : uMode;
      float lm = soft(length(p - lc) - 2.6, 0.5);
      vec3 off = dk ? vec3(0.06, 0.10, 0.07) : vec3(0.35, 0.40, 0.36);
      col = mix(col, mix(off, vec3(0.35, 1.0, 0.45) * (dk ? 0.95 : 0.8), on), lm);
      col += vec3(0.35, 1.0, 0.45) * exp(-pow(length(p - lc) / 5.0, 2.0)) * on * (dk ? 0.22 : 0.06);
      col = mix(col, dk ? vec3(0.55, 0.58, 0.55) : vec3(0.15), silkText(p, lc + vec2(-6.0, -12.0), 3.0, 5.0 + float(k)) * 0.8);
    }
  }
  col = hushed(col, hu, 0.28);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** The scene's moving state. */
export interface OscilloscopeState {
  primed: boolean;
  fast: number;
  mean: number;
  hi: number;
  lo: number;
  rel: number;
  density: number;
  densNow: number;
  recent: Figure[];
  sinceStrike: number;
  ratioIdx: number;
  ratioAge: number;
  P: Drivers;
  prog: Programme;
  clock: number;
  // Whether a frame has been traced, so a frozen step can hold it.
  ready: boolean;
  // The glass: centre x and y, half width and half height, css px.
  glass: Float32Array;
  fine: { x: Float32Array; y: Float32Array; b: Float32Array; m: Float32Array };
  now: { x: Float32Array; y: Float32Array; u: Float32Array; w: Float32Array };
  hist: { head: number; buf: PathSlot[] };
  o: BeamPoint;
  oa: BeamPoint;
  ob: BeamPoint;
  // Coarse beam samples for the wide glow, x and y per sample.
  glow: Float32Array;
  // The uniform arrays: the beam's path, each segment's beam time, the culling boxes.
  uP: Float32Array;
  uD: Float32Array;
  uBox: Float32Array;
  knob: Float32Array;
  knobTo: Float32Array;
  mode: number;
  power: number;
  bloom: number;
  // The current beat's weight so far, 0 between beats; its rises are what a beat adds to the figure.
  bw: number;
}

export function createOscilloscopeState(): OscilloscopeState {
  const { NSEG, FINE, GLOW_N, CHUNK } = SCOPE;
  return {
    primed: false,
    fast: 0,
    mean: 0,
    hi: 0,
    lo: 0,
    rel: 0,
    density: 0,
    densNow: 0,
    // The opening figure counts as shown, so the first pick moves off it.
    recent: ["trace"],
    sinceStrike: 9,
    ratioIdx: 1,
    ratioAge: 9,
    P: {
      bass: 0,
      mid: 0,
      high: 0,
      midSlow: 0,
      loud: 0.3,
      bh: 0,
      mh: 0,
      hh: 0,
      size: SCOPE.SIZE[0],
      pop: 0,
      surge: 0,
      cut: 0,
      cutTo: 0,
      bloom: 0,
      spin: 0,
      phase: 0,
      spinV: 0.15,
      driftV: 0.15,
      kick: 0,
      kickTo: 0,
      wph: [0, 1, 2],
      slow: 0,
      strike: 0.9,
      strikeTo: 0.9,
      hp: 0,
      hpTo: 0,
      rings: 2,
      ringR: [0.72, 0.81, 0.81, 0.81],
      la: 1,
      lb: 2,
      cs3: 1,
      sn3: 0,
    },
    prog: { cur: { fig: "trace" }, next: null, s: 0, kind: "bloom", dur: 1, held: 0, hold: 14, wasUp: false, wasDown: false },
    clock: 0,
    ready: false,
    glass: Float32Array.of(400, 300, 300, 230),
    fine: { x: new Float32Array(FINE + 1), y: new Float32Array(FINE + 1), b: new Float32Array(FINE + 1), m: new Float32Array(FINE + 1) },
    now: { x: new Float32Array(NSEG + 1), y: new Float32Array(NSEG + 1), u: new Float32Array(NSEG + 1), w: new Float32Array(NSEG) },
    hist: {
      head: 0,
      buf: Array.from({ length: HISTORY }, () => ({
        t: -1,
        x: new Float32Array(NSEG + 1),
        y: new Float32Array(NSEG + 1),
        w: new Float32Array(NSEG),
      })),
    },
    o: { x: 0, y: 0, b: 1 },
    oa: { x: 0, y: 0, b: 1 },
    ob: { x: 0, y: 0, b: 1 },
    glow: new Float32Array(GLOW_N * 2),
    uP: new Float32Array((NSEG + 1) * 4),
    uD: new Float32Array(NSEG * 2),
    uBox: new Float32Array((NSEG / CHUNK) * 4),
    knob: new Float32Array(6),
    knobTo: new Float32Array(6),
    mode: 0,
    power: 0.6,
    bloom: 0,
    bw: 0,
  };
}

/**
 * Fits the glass to the stage into `out` (centre x and y, half width and half height, css px): the whole stage
 * less a frame of bezel, the nameplate strip on top and the control row above the floor. The cover stays where
 * the stage puts it and sits on the glass as a label, wherever that falls.
 */
export function fitGlass(geo: Geometry, size: { w: number; h: number; dpr: number }, out: Float32Array): void {
  const S = SCOPE;
  const d = size.dpr;
  const W = size.w / d;
  const H = size.h / d;
  const top = H - S.TOP_ROOM - S.BEZEL;
  const bottom = (geo.floor ?? 0) / d + S.FLOOR_ROOM + S.BEZEL;
  out[0] = W / 2;
  out[1] = (top + bottom) / 2;
  out[2] = W / 2 - S.EDGE - S.BEZEL;
  out[3] = (top - bottom) / 2;
}

/** The song's intensity: against its 17 s mean (rel, -1..1) and within the range it has covered lately (density, 0..1). */
function stepEnergy(st: OscilloscopeState, s: VisualSignal, dt: number, drive: number): void {
  const S = SCOPE;
  const x = s.level + (drive > 0 ? 0.15 * s.bassMotion : 0);
  if (!st.primed) {
    st.fast = x;
    st.mean = x;
    st.hi = x;
    st.lo = x;
    st.primed = true;
  }
  st.fast = easeEnvelope(st.fast, x, dt, S.FAST_TAU);
  st.mean = easeEnvelope(st.mean, x, dt, S.SLOW_TAU);
  st.hi = Math.max(st.fast, easeEnvelope(st.hi, st.mean, dt, S.RANGE_TAU));
  st.lo = Math.min(st.fast, easeEnvelope(st.lo, st.mean, dt, S.RANGE_TAU));
  st.rel = Math.max(-1, Math.min(1, (st.fast - st.mean) / S.REL_SPAN));
  st.densNow = clamp01((st.fast - st.lo) / Math.max(st.hi - st.lo, 0.12));
  st.density = easeEnvelope(st.density, st.densNow, dt, S.DENSITY_TAU);
}

// A figure picked for the song's density, with its own settings.
function instanceOf(st: OscilloscopeState, rng: () => number, fig: Figure): Instance {
  const D = st.densNow;
  const r = rng();
  if (fig === "lissajous") return { fig, base: Math.min(7, Math.floor(D * 5 + r * 2)) };
  if (fig === "rose") return { fig, k: [3, 4, 5, 6, 7][Math.min(4, Math.floor(D * 3 + r * 2))] };
  if (fig === "spiro") return { fig, pq: SPIRO[Math.min(5, Math.floor(r * 6))] };
  if (fig === "harmono") return { fig, f: ([[1, 1], [1, 2], [2, 3], [3, 2], [3, 4]] as const)[Math.min(4, Math.floor(D * 3 + r * 2))] };
  if (fig === "coil") return { fig, w: [9, 12, 14][Math.floor(r * 3)] };
  return { fig };
}

// Picks the next figure from the pool for the current density, avoiding the last two shown.
function pick(st: OscilloscopeState, rng: () => number): Instance {
  const pool = POOLS[st.densNow < 0.36 ? 0 : st.densNow < 0.7 ? 1 : 2].filter((f) => !st.recent.includes(f));
  const fig = pool[Math.floor(rng() * pool.length)] || "lissajous";
  st.recent = [fig, ...st.recent].slice(0, 2);
  return instanceOf(st, rng, fig);
}

// Dense passages turn over sooner than quiet ones.
function holdFor(st: OscilloscopeState, rng: () => number, calm: boolean): number {
  const [a, b] = calm ? SCOPE.HOLD_CALM : SCOPE.HOLD;
  const k = calm ? 1 : 1 - 0.45 * st.density;
  return (a + (b - a) * rng()) * k;
}

// The programme: a figure holds on a long timer or until the song changes section, then morphs into the next.
// A surge cuts straight to a new figure with a short bloom.
function stepProgramme(st: OscilloscopeState, dt: number, drive: number, rng: () => number, surge: number): void {
  const S = SCOPE;
  const calm = drive === 0;
  const pr = st.prog;
  pr.held += dt;
  if (!calm && surge > 0 && !pr.next && pr.held > S.SURGE_HOLD) {
    pr.next = pick(st, rng);
    pr.kind = "bloom";
    pr.dur = S.MORPH_SURGE;
    pr.s = 0;
    return;
  }
  if (pr.next) {
    pr.s += dt / pr.dur;
    if (pr.s >= 1) {
      pr.cur = pr.next;
      pr.next = null;
      pr.s = 0;
      pr.held = 0;
      pr.hold = holdFor(st, rng, calm);
    }
    return;
  }
  const up = st.rel > 0.55;
  const down = st.rel < -0.45;
  const section = !calm && ((up && !pr.wasUp) || (down && !pr.wasDown)) && pr.held > S.MIN_HOLD;
  pr.wasUp = up;
  pr.wasDown = down;
  if (section || pr.held > pr.hold) {
    pr.next = pick(st, rng);
    pr.kind = pr.kind === "fold" ? "bloom" : "fold";
    pr.dur = calm ? S.MORPH_CALM : section ? S.MORPH_SECTION : S.MORPH;
    pr.s = 0;
  }
}

// Eased drivers: each band has one job; loudness sets the size and the pace; beats, hits and shifts act on top.
function stepDrivers(st: OscilloscopeState, s: VisualSignal, dt: number, drive: number): void {
  const S = SCOPE;
  const P = st.P;
  const on = drive > 0;
  const ease2 = (prev: number, target: number, up: number, down: number) => easeEnvelope(prev, target, dt, target > prev ? up : down);
  P.bass = ease2(P.bass, on ? clamp01(s.bassMotion * 0.9) : 0, 0.14, 0.6);
  P.mid = ease2(P.mid, on ? clamp01(s.midMotion) : 0, 0.25, 0.8);
  P.high = ease2(P.high, on ? clamp01(s.highMotion) : 0, 0.2, 0.7);
  P.midSlow = easeEnvelope(P.midSlow, P.mid, dt, 1.5);
  P.loud = clamp01(s.loudness);
  // Hits push the figure's shape at once and fall on their own decay.
  const fall = Math.exp(-dt / S.HIT_TAU);
  P.bh = Math.max(on ? Math.min(1, s.bassHit) : 0, P.bh * fall);
  P.mh = Math.max(on ? Math.min(1, s.midHit) : 0, P.mh * fall);
  P.hh = Math.max(on ? Math.min(1, s.highHit) : 0, P.hh * fall);
  // Spin and drift: mostly the loudness, partly the intensity against its mean; a fixed idle under Calm.
  const rel = on ? 0.7 * P.loud + 0.15 * (st.rel + 1) : 0.3;
  const spinRate = S.SPIN[0] + (S.SPIN[1] - S.SPIN[0]) * rel;
  const driftRate = S.DRIFT[0] + (S.DRIFT[1] - S.DRIFT[0]) * rel;
  P.spinV = easeEnvelope(P.spinV, spinRate, dt, 1.2);
  P.driftV = easeEnvelope(P.driftV, driftRate, dt, 1.2);
  // A beat's weight rises over its first frames; each rise kicks the phase, jumps the size and strikes the
  // harmonograph by that much, so a loud kick turns the figure over and a soft onset barely moves it.
  const w = on ? s.beatWeight : 0;
  const first = w > 0 && st.bw === 0;
  const rise = Math.max(0, w - st.bw);
  st.bw = w > 0 ? Math.max(st.bw, w) : 0;
  P.kickTo += S.KICK * rise;
  P.pop = Math.max(S.POP * Math.min(1.2, st.bw), P.pop * Math.exp(-dt / S.POP_TAU));
  P.bloom = Math.max(Math.min(1, st.bw), P.bloom * Math.exp(-dt / S.BLOOM_TAU));
  // A surge lifts the figure and the bloom for a few seconds; a cut squashes it toward a flat line for a moment.
  if (on && s.surge > 0) P.surge = Math.max(P.surge, Math.min(1, s.surge));
  P.surge *= Math.exp(-dt / S.SURGE_TAU);
  P.cutTo = Math.max(on ? Math.min(1, s.cut) : 0, P.cutTo * Math.exp(-dt / S.CUT_TAU));
  P.cut = ease2(P.cut, P.cutTo, S.CUT_UP, S.CUT_TAU);
  const grow = (S.SIZE[0] + (S.SIZE[1] - S.SIZE[0]) * P.loud) * (1 + P.pop + S.SURGE_SIZE * P.surge);
  P.size = grow <= S.KNEE ? grow : S.KNEE + (1 - S.KNEE) * Math.tanh((grow - S.KNEE) / (1 - S.KNEE));
  const k0 = P.kick;
  P.kick = easeEnvelope(P.kick, P.kickTo, dt, S.KICK_TAU);
  P.spin += dt * P.spinV;
  P.phase += dt * P.driftV + (P.kick - k0);
  for (let i = 0; i < 3; i++) P.wph[i] += dt * P.driftV * WPH_DRIFT[i] + (P.kick - k0) * WPH_KICK[i];
  P.slow += dt;
  P.cs3 = Math.cos(P.spin * 0.3);
  P.sn3 = Math.sin(P.spin * 0.3);
  // The harmonograph's strike: it decays toward rest and a beat strikes it again by its weight, then its second
  // pendulum moves on. A surge strikes it in full.
  st.sinceStrike += dt;
  P.strikeTo = easeEnvelope(P.strikeTo, S.STRIKE_REST, dt, S.STRIKE_TAU);
  if (rise > 0) P.strikeTo = Math.max(P.strikeTo, Math.min(1, S.STRIKE_REST + 0.3 * st.bw));
  if (on && s.surge > 0) P.strikeTo = 1;
  if (first && st.sinceStrike > S.STRIKE_GAP) {
    st.sinceStrike = 0;
    P.hpTo += 0.6;
  }
  if (!on) P.strikeTo = easeEnvelope(P.strikeTo, 0.9, dt, 2);
  P.strike = ease2(P.strike, P.strikeTo, 0.25, 0.8);
  P.hp = easeEnvelope(P.hp, P.hpTo, dt, 0.4);
  // Rings split as the music fills: two at rest, up to four with the mids over the song's density.
  P.rings = easeEnvelope(P.rings, 1.6 + 1.6 * st.density + (on ? 0.8 * P.midSlow : 0), dt, 1.5);
  for (let j = 0, r = 0.72; j < 4; j++) {
    if (j) r += 0.09 * Math.min(1, Math.max(0, P.rings - j));
    P.ringR[j] = r;
  }
  // The Lissajous ratio: the figure's base for the density, stepped by the mids, re-aimed at most every 5 s.
  const cur = st.prog.next || st.prog.cur;
  st.ratioAge += dt;
  if (cur.fig === "lissajous" && st.ratioAge > 5) {
    const idx = Math.max(0, Math.min(RATIOS.length - 1, cur.base + Math.round((P.midSlow - 0.35) * 3)));
    if (idx !== st.ratioIdx) {
      st.ratioIdx = idx;
      st.ratioAge = 0;
    }
  }
  const [ta, tb] = RATIOS[st.ratioIdx];
  P.la = easeEnvelope(P.la, ta, dt, 1.4);
  P.lb = easeEnvelope(P.lb, tb, dt, 1.4);
}

const ease5 = (k: number) => k * k * k * (k * (k * 6 - 15) + 10);

// The beam's point at time u: the current figure, or the morph from it into the next. Morphs run in polar
// coordinates about the label, so no point of the path cuts in behind it on the way. A fold turns and stretches each
// point of one figure onto the matching point of the next; a bloom draws the figure out onto a circle round the
// label, turns the circle over to the next figure's angles, and lets the next figure grow out of it.
function beamAt(st: OscilloscopeState, u: number, o: BeamPoint): void {
  const pr = st.prog;
  const P = st.P;
  const a = st.oa;
  const b = st.ob;
  figureAt(pr.cur, u, P, a);
  if (!pr.next) {
    o.x = a.x;
    o.y = a.y;
    o.b = a.b;
    return;
  }
  figureAt(pr.next, u, P, b);
  const ra = Math.sqrt(a.x * a.x + a.y * a.y);
  const rb = Math.sqrt(b.x * b.x + b.y * b.y);
  const ta = Math.atan2(a.y, a.x);
  const tb = Math.atan2(b.y, b.x);
  let dth = tb - ta;
  dth -= TAU * Math.round(dth / TAU);
  let r: number;
  let th: number;
  if (pr.kind === "bloom") {
    const s = pr.s;
    const C = 0.9;
    if (s < 0.4) {
      const k = ease5(s / 0.4);
      r = ra + (C - ra) * k;
      th = ta;
    } else if (s < 0.6) {
      r = C;
      th = ta + dth * ease5((s - 0.4) / 0.2);
    } else {
      const k = ease5((s - 0.6) / 0.4);
      r = C + (rb - C) * k;
      th = tb;
    }
  } else {
    const k = ease5(pr.s);
    r = ra + (rb - ra) * k;
    th = ta + dth * k;
  }
  const k = ease5(pr.s);
  o.x = r * Math.cos(th);
  o.y = r * Math.sin(th);
  o.b = a.b + (b.b - a.b) * k;
}

// Samples the beam's path finely, then resamples it to NSEG segments spaced by length plus turning, each carrying
// its share of the beam's time (blanked spans carry none).
function traceBeam(st: OscilloscopeState, sx: number, sy: number, dt: number): void {
  const S = SCOPE;
  const M = S.FINE;
  const N = S.NSEG;
  const f = st.fine;
  const o = st.o;
  for (let j = 0; j <= M; j++) {
    beamAt(st, j / M, o);
    f.x[j] = o.x * sx;
    f.y[j] = o.y * sy;
    f.b[j] = Math.max(0, Math.min(1, o.b));
  }
  let tot = 0;
  let pdx = 0;
  let pdy = 0;
  f.m[0] = 0;
  for (let j = 0; j < M; j++) {
    const dx = f.x[j + 1] - f.x[j];
    const dy = f.y[j + 1] - f.y[j];
    const len = Math.sqrt(dx * dx + dy * dy) + 1e-6;
    const ux = dx / len;
    const uy = dy / len;
    const tx = ux - pdx;
    const ty = uy - pdy;
    const turn = j ? Math.sqrt(tx * tx + ty * ty) : 0;
    pdx = ux;
    pdy = uy;
    tot += (0.15 + 0.85 * Math.min(f.b[j], f.b[j + 1])) * (len + S.TURN_PX * turn);
    f.m[j + 1] = tot;
  }
  const out = st.now;
  let j = 0;
  for (let k = 0; k <= N; k++) {
    const m = (tot * k) / N;
    while (j < M - 1 && f.m[j + 1] < m) j++;
    const span = f.m[j + 1] - f.m[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (m - f.m[j]) / span)) : 0;
    out.x[k] = f.x[j] + (f.x[j + 1] - f.x[j]) * t;
    out.y[k] = f.y[j] + (f.y[j + 1] - f.y[j]) * t;
    out.u[k] = (j + t) / M;
  }
  for (let k = 0; k < N; k++) {
    const um = (out.u[k] + out.u[k + 1]) / 2;
    const jm = Math.min(M, Math.round(um * M));
    out.w[k] = (out.u[k + 1] - out.u[k]) * N * f.b[jm];
  }
  // The wide glow: coarse samples at equal beam time; blanked ones are moved off the glass. It is large-area
  // light, so its samples trail the beam by GLOW_TAU and a hit's jump in the trace never moves it at once.
  const g = st.glow;
  const k1 = st.ready ? 1 - Math.exp(-dt / S.GLOW_TAU) : 1;
  for (let k = 0; k < S.GLOW_N; k++) {
    const jj = Math.round((k * M) / S.GLOW_N);
    const on = f.b[jj] > 0.5;
    const i = k * 2;
    if (!on) {
      g[i] = 1e5;
      g[i + 1] = 1e5;
    } else if (g[i] > 1e4) {
      g[i] = f.x[jj];
      g[i + 1] = f.y[jj];
    } else {
      g[i] += (f.x[jj] - g[i]) * k1;
      g[i + 1] += (f.y[jj] - g[i + 1]) * k1;
    }
  }
}

// Packs the path now and a moment ago, each segment's beam time, and the culling box of each chunk of segments.
function packBeam(st: OscilloscopeState, reach: number): void {
  const S = SCOPE;
  const N = S.NSEG;
  const now = st.now;
  const H = st.hist;
  const slot = H.buf[H.head];
  slot.t = st.clock;
  slot.x.set(now.x);
  slot.y.set(now.y);
  slot.w.set(now.w);
  H.head = (H.head + 1) % H.buf.length;
  // The afterglow: the path as it was GHOST_AGE ago, from the ring of recent frames.
  let gh = slot;
  for (let i = 1; i < H.buf.length; i++) {
    const c = H.buf[(H.head - 1 - i + H.buf.length * 2) % H.buf.length];
    if (c.t < 0 || c.t > st.clock) break;
    gh = c;
    if (st.clock - c.t >= S.GHOST_AGE) break;
  }
  const { uP, uD, uBox } = st;
  for (let k = 0; k <= N; k++) {
    const i = k * 4;
    uP[i] = now.x[k];
    uP[i + 1] = now.y[k];
    uP[i + 2] = gh.x[k];
    uP[i + 3] = gh.y[k];
  }
  for (let k = 0; k < N; k++) {
    uD[k * 2] = now.w[k];
    uD[k * 2 + 1] = gh.w[k];
  }
  for (let c = 0; c < N / S.CHUNK; c++) {
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    let lit = 0;
    for (let k = c * S.CHUNK; k < (c + 1) * S.CHUNK; k++) lit += uD[k * 2] + uD[k * 2 + 1];
    // A chunk the beam crosses blanked is never drawn.
    if (lit < 1e-4) {
      uBox[c * 4] = 1e6;
      uBox[c * 4 + 1] = 1e6;
      uBox[c * 4 + 2] = -1e6;
      uBox[c * 4 + 3] = -1e6;
      continue;
    }
    for (let k = c * S.CHUNK, i = k * 4; k <= (c + 1) * S.CHUNK; k++, i += 4) {
      const ax = uP[i];
      const ay = uP[i + 1];
      const bx = uP[i + 2];
      const by = uP[i + 3];
      if (ax < x0) x0 = ax;
      if (bx < x0) x0 = bx;
      if (ax > x1) x1 = ax;
      if (bx > x1) x1 = bx;
      if (ay < y0) y0 = ay;
      if (by < y0) y0 = by;
      if (ay > y1) y1 = ay;
      if (by > y1) y1 = by;
    }
    const i = c * 4;
    uBox[i] = x0 - reach;
    uBox[i + 1] = y0 - reach;
    uBox[i + 2] = x1 + reach;
    uBox[i + 3] = y1 + reach;
  }
}

const isXY = (fig: Figure) => (fig === "trace" ? 0 : 1);

// The panel follows the beam: the mode switch, and knobs for X, Y, phase, time base, intensity and programme.
function stepPanel(st: OscilloscopeState, dt: number): void {
  const pr = st.prog;
  const P = st.P;
  const cur = pr.next && pr.s > 0.5 ? pr.next : pr.cur;
  const modeTo = pr.next ? isXY(pr.cur.fig) + (isXY(pr.next.fig) - isXY(pr.cur.fig)) * Math.min(1, Math.max(0, pr.s * 2 - 0.5)) : isXY(pr.cur.fig);
  st.mode = easeEnvelope(st.mode, modeTo, dt, 0.15);
  const kt = st.knobTo;
  kt[0] = (P.la - 3) * 0.45 + P.bass * 0.4;
  kt[1] = (P.lb - 3.5) * 0.4 + P.mid * 0.4;
  kt[2] = Math.sin(P.phase * 0.25) * 2.0;
  kt[3] = cur.fig === "trace" ? -1.4 : 0.9 + 0.3 * P.high;
  kt[4] = -2.0 + 3.2 * P.loud;
  kt[5] = -2.1 + (4.2 * FIGURES.indexOf(cur.fig)) / (FIGURES.length - 1);
  for (let i = 0; i < 6; i++) st.knob[i] = easeEnvelope(st.knob[i], kt[i] - Math.PI / 2 + Math.PI, dt, 0.35);
}

/**
 * Advances the scene by dt at motion gain `drive` (0 under Calm and while paused), with the glass fitted to the
 * stage as `glass` (see fitGlass). `rng` picks the figures and their settings. A frozen frame (dt 0) after the
 * first holds the last one as it was.
 */
export function stepOscilloscope(
  st: OscilloscopeState,
  s: VisualSignal,
  dt: number,
  drive: number,
  rng: () => number,
  glass: Float32Array,
): void {
  if (dt === 0 && st.ready) return;
  st.glass.set(glass);
  st.clock += dt;
  stepEnergy(st, s, dt, drive);
  stepProgramme(st, dt, drive, rng, drive > 0 ? s.surge : 0);
  stepDrivers(st, s, dt, drive);
  const S = SCOPE;
  const P = st.P;
  const [, , hx, hy] = st.glass;
  // Y-T sweeps the full width at any size; an X-Y figure is held to ASPECT and scales with the size both ways.
  const m = st.mode;
  const fx = (1 - m + m * P.size) * (1 - S.CUT_X * P.cut);
  const fy = P.size * (1 - S.CUT_Y * P.cut);
  const ax = hx * (1 - m) + Math.min(hx, hy * S.ASPECT) * m;
  traceBeam(st, ax * S.FILL * fx, hy * S.FILL * fy, dt);
  packBeam(st, S.REACH * Math.min(S.BEAM_SCALE[1], Math.max(S.BEAM_SCALE[0], hy / S.BEAM_REF)));
  stepPanel(st, dt);
  st.power = S.POWER[0] + S.POWER[1] * P.loud;
  st.bloom = Math.max(P.bloom, 0.8 * P.surge);
  st.ready = true;
}

const OSCILLOSCOPE_PROGRAM: ProgramSource = { name: "oscilloscope", vs: FS_VS, fs: FS };
/** The programs the oscilloscope compiles, for warming the shader cache ahead of the stage. */
export const OSCILLOSCOPE_PROGRAMS: readonly ProgramSource[] = [OSCILLOSCOPE_PROGRAM];

export function createOscilloscope(kit: Kit): Candidate {
  const { gl } = kit;
  const art = createCoverTexture(gl);
  const rng = createRng(RNG_SEED);
  const st = createOscilloscopeState();
  const glass = new Float32Array(4);

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
      fitGlass(kit.geo, kit.size, glass);
      stepOscilloscope(st, f.sig, f.dt, cyberGain(f.sig, f.playing), rng, glass);
      const p = kit.program(OSCILLOSCOPE_PROGRAM);
      setScene(kit, p, f, 0, null, art.tex);
      gl.uniform4fv(kit.uniform(p, "uGlass"), st.glass);
      gl.uniform4fv(kit.uniform(p, "uP"), st.uP);
      gl.uniform4fv(kit.uniform(p, "uD"), st.uD);
      gl.uniform4fv(kit.uniform(p, "uBox"), st.uBox);
      gl.uniform4fv(kit.uniform(p, "uGlowP"), st.glow);
      kit.set1(p, "uPower", st.power);
      kit.set1(p, "uBloom", st.bloom);
      kit.set1(p, "uMode", st.mode);
      gl.uniform4f(kit.uniform(p, "uKnobA"), st.knob[0], st.knob[1], st.knob[2], st.knob[3]);
      kit.set2(p, "uKnobB", st.knob[4], st.knob[5]);
      kit.set1(p, "uSlow", st.P.slow);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
