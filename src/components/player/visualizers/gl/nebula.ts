/*
 * Nebula: smoke rather than dust. A few thousand large, very soft particles orbit three attractors that
 * drift in 3D; they overlap into one continuous density, and the feedback trail turns their paths into
 * silk ribbons. Each attractor pulls with its band group and eases into a push on a beat, so the smoke
 * billows out and gathers again. The physics runs on the CPU and streams one buffer per frame.
 *
 * The motion channel rides on top: each beat breathes the cloud outward and lets it drift back, the bass
 * envelope adds pull, the mids speed the swirl and the orbits, and the highs stir the edges. The trail
 * shortens as the motion rises so it reads, and stretches in quiet passages; the emission scales against
 * the trail so its length never changes the brightness. Under Calm every one of these terms is zero.
 */

// -- Local Imports --
import { easeEnvelope, restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const COUNT = 3000;

// -- Tunables: how the smoke moves with the music --
// The beat breath: how far the cloud swells per unit of beat strength, its rise in seconds and its fall
// time constant (the whole breath lasts about the rise plus three falls), and the outward push it puts on
// the particles.
const BREATH_SCALE = 0.18;
const BREATH_RISE = 0.1;
const BREATH_FALL = 0.2;
const BREATH_PUSH = 6;
// Attractor pull added per unit of bass envelope.
const PULL_BASS = 0.9;
// Swirl and orbit speed added per unit of mid envelope, as a fraction of their base speed.
const SWIRL_MID = 1.2;
const ORBIT_MID = 1.5;
// Edge turbulence per unit of high envelope, and the spatial frequency of its field.
const TURB_HIGH = 5;
const TURB_SCALE = 5;
// The trail's per-frame decay: its base, how much longer it runs in quiet passages, how much shorter per
// unit of motion, its bounds, and the time constant of the motion that sets it.
const TRAIL_DECAY = 0.93;
const TRAIL_QUIET = 0.025;
const TRAIL_LOUD = 0.09;
const TRAIL_MIN = 0.8;
const TRAIL_MAX = 0.96;
const TRAIL_TAU = 0.25;
// The Player's cloud scale as a share of the cover width, and its cap as a share of the hero column width.
// The cover stops growing at 320 px while the column keeps narrowing with the window, so the cap holds the
// cloud inside a narrow column. A column wider than about 850 px never reaches it.
const COVER_UNIT = 1.2;
const COLUMN_UNIT = 0.45;

interface Attractor {
  orbit: number;
  speed: number;
  phase: number;
  lift: number;
  axis: [number, number, number];
  lo: number;
  hi: number;
  swirl: number;
}

const ATTRACTORS: Attractor[] = [
  { orbit: 0.85, speed: 0.21, phase: 0.0, lift: 0.35, axis: [0.2, 1, 0.1], lo: 0, hi: 6, swirl: 1.3 },
  { orbit: 0.95, speed: -0.17, phase: 2.1, lift: -0.45, axis: [1, 0.3, 0.2], lo: 6, hi: 15, swirl: -1.1 },
  { orbit: 0.8, speed: 0.13, phase: 4.2, lift: 0.6, axis: [0.1, 0.5, 1], lo: 15, hi: 24, swirl: 1.0 },
].map((a) => {
  const n = Math.hypot(...a.axis);
  return { ...a, axis: a.axis.map((v) => v / n) as [number, number, number] };
});

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aMeta;
uniform vec2 uCenter;
uniform vec2 uScale;
uniform float uYaw;
uniform float uPitch;
uniform float uPoint;
uniform float uLevel;
uniform vec3 uPal[3];
out vec3 vCol;
void main() {
  vec3 p = aPos;
  float cy = cos(uYaw), sy = sin(uYaw), cp = cos(uPitch), sp = sin(uPitch);
  p = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  float persp = 2.6 / (p.z + 3.0);
  gl_Position = vec4(uCenter + p.xy * persp * uScale, 0.0, 1.0);
  gl_PointSize = min(uPoint * persp, 160.0);
  float x = clamp(aMeta.x, 0.0, 2.0);
  vec3 col = x < 1.0 ? mix(uPal[0], uPal[1], x) : mix(uPal[1], uPal[2], x - 1.0);
  vCol = col * aMeta.y * persp * (0.55 + uLevel * 0.7);
}`;

const FS = `#version 300 es
precision highp float;
uniform float uGain;
in vec3 vCol;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.0) * (1.0 - r2);
  outColor = vec4(vCol * a * uGain, 1.0);
}`;

export function createNebula(kit: Kit): Candidate {
  const { gl } = kit;
  const P = new Float32Array(COUNT * 3);
  const V = new Float32Array(COUNT * 3);
  const A = new Float32Array(COUNT);
  const L = new Float32Array(COUNT);
  const data = new Float32Array(COUNT * 5);
  // The motion channel's state: the breath, its start and peak and age, the extra orbit phase the mids
  // have added, and the eased motion that sets the trail.
  let breath = 0;
  let breathFrom = 0;
  let breathPeak = 0;
  let breathAge = Infinity;
  let orbitShift = 0;
  let trailMotion = 0;
  let decay = TRAIL_DECAY;

  const attractorPos = (t: number) =>
    ATTRACTORS.map((a) => {
      const ph = a.phase + a.speed * t;
      return [Math.cos(ph) * a.orbit, Math.sin(ph * 1.3) * a.orbit * a.lift, Math.sin(ph) * a.orbit];
    });

  const spawn = (i: number, pos: number[][]) => {
    const k = Math.floor(Math.random() * 3);
    const a = pos[k];
    const ax = ATTRACTORS[k].axis;
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = 0.15 + Math.random() * 0.45;
    const dx = s * Math.cos(th) * r;
    const dy = u * r;
    const dz = s * Math.sin(th) * r;
    const j = i * 3;
    P[j] = a[0] + dx;
    P[j + 1] = a[1] + dy;
    P[j + 2] = a[2] + dz;
    // Start tangential to the attractor's axis so the particle enters an orbit, not a fall.
    const tx = ax[1] * dz - ax[2] * dy;
    const ty = ax[2] * dx - ax[0] * dz;
    const tz = ax[0] * dy - ax[1] * dx;
    const v = (0.9 + Math.random() * 0.6) / Math.max(0.2, Math.sqrt(r));
    V[j] = tx * v;
    V[j + 1] = ty * v;
    V[j + 2] = tz * v;
    A[i] = k;
    L[i] = 0;
  };

  const simulate = (dt: number, t: number, s: VisualSignal) => {
    const pos = attractorPos(t + orbitShift);
    const g = ATTRACTORS.map((a) => {
      let e = 0;
      for (let i = a.lo; i < a.hi; i++) e += s.bands[i];
      e /= a.hi - a.lo;
      // Each attractor pulls with its band group and eases into a push on a beat: a motion accent.
      return 0.55 + 1.3 * e - 1.0 * s.kick * s.kick * (a.lo === 0 ? 1.2 : 0.8) + PULL_BASS * s.bassMotion;
    });
    const swirl = 1 + SWIRL_MID * s.midMotion;
    const push = BREATH_PUSH * breath;
    const turb = TURB_HIGH * s.highMotion;
    const damp = Math.exp(-dt * 2.5);
    for (let i = 0; i < COUNT; i++) {
      const j = i * 3;
      const px = P[j];
      const py = P[j + 1];
      const pz = P[j + 2];
      let fx = -px * 0.1;
      let fy = -py * 0.1;
      let fz = -pz * 0.1;
      let best = 0;
      let bestD = 1e9;
      for (let k = 0; k < 3; k++) {
        const a = pos[k];
        const ax = ATTRACTORS[k].axis;
        const sw = ATTRACTORS[k].swirl;
        const dx = a[0] - px;
        const dy = a[1] - py;
        const dz = a[2] - pz;
        const r2 = dx * dx + dy * dy + dz * dz + 0.04;
        const inv = 1 / Math.sqrt(r2);
        if (r2 < bestD) {
          bestD = r2;
          best = k;
        }
        const pull = g[k] * inv * inv * 2.0;
        const spin = ((sw * inv * 1.5) / (r2 + 0.1)) * swirl;
        fx += dx * pull + (ax[1] * dz - ax[2] * dy) * spin;
        fy += dy * pull + (ax[2] * dx - ax[0] * dz) * spin;
        fz += dz * pull + (ax[0] * dy - ax[1] * dx) * spin;
      }
      if (push > 0) {
        fx += px * push;
        fy += py * push;
        fz += pz * push;
      }
      // The highs stir a smooth field, weighted toward the particles far from their attractor.
      if (turb > 0) {
        const edge = Math.min(1, bestD * 4) * turb;
        fx += Math.sin(py * TURB_SCALE + t * 1.7) * edge;
        fy += Math.sin(pz * TURB_SCALE + t * 1.3) * edge;
        fz += Math.sin(px * TURB_SCALE + t * 2.1) * edge;
      }
      const fm = Math.hypot(fx, fy, fz);
      if (fm > 30) {
        const k = 30 / fm;
        fx *= k;
        fy *= k;
        fz *= k;
      }
      const vx = (V[j] + fx * dt) * damp;
      const vy = (V[j + 1] + fy * dt) * damp;
      const vz = (V[j + 2] + fz * dt) * damp;
      const nx = px + vx * dt;
      const ny = py + vy * dt;
      const nz = pz + vz * dt;
      if (nx * nx + ny * ny + nz * nz > 7 || Math.random() < 0.0015) {
        spawn(i, pos);
      } else {
        P[j] = nx;
        P[j + 1] = ny;
        P[j + 2] = nz;
        V[j] = vx;
        V[j + 1] = vy;
        V[j + 2] = vz;
      }
      A[i] += (best - A[i]) * 0.04;
      L[i] += dt;
      const o = i * 5;
      data[o] = P[j];
      data[o + 1] = P[j + 1];
      data[o + 2] = P[j + 2];
      data[o + 3] = A[i];
      // A fresh particle fades in over a second so a respawn never pops.
      data[o + 4] = Math.min(1, L[i]);
    }
  };

  const initial = attractorPos(0);
  for (let i = 0; i < COUNT; i++) {
    spawn(i, initial);
    L[i] = 2;
  }
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);
  const rest = restSignal();
  for (let k = 0; k < 120; k++) simulate(1 / 60, k / 60, rest);

  // Starts a breath on a beat, from wherever the last one is, so a quick second beat never snaps back.
  const stepMotion = (dt: number, s: VisualSignal) => {
    if (s.beat > 0) {
      breathFrom = breath;
      breathPeak = Math.max(breath, Math.min(1.5, s.beat));
      breathAge = 0;
    } else {
      breathAge += dt;
    }
    if (breathAge < BREATH_RISE) {
      const k = breathAge / BREATH_RISE;
      breath = breathFrom + (breathPeak - breathFrom) * k * k * (3 - 2 * k);
    } else {
      breath = breathPeak * Math.exp(-(breathAge - BREATH_RISE) / BREATH_FALL);
    }
    orbitShift += dt * ORBIT_MID * s.midMotion;
    const motion = (s.bassMotion + s.midMotion + s.highMotion) / 3;
    trailMotion = easeEnvelope(trailMotion, motion, dt, TRAIL_TAU);
  };

  return {
    mode: "glow",
    bloom: 0.45,
    exposure: 1.3,
    inkGain: 2.4,
    trail: { decay: TRAIL_DECAY, zoom: 1.0, rot: 0 },
    draw(f: Frame) {
      const dt = Math.min(f.dt, 1 / 30);
      stepMotion(dt, f.sig);
      simulate(dt, f.t, f.sig);
      const p = kit.program("nebula", VS, FS);
      gl.useProgram(p.handle);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      const { w: W, h: H } = kit.size;
      const c = kit.geo.cover;
      let cx: number;
      let cy: number;
      let unit: number;
      // In ambient the smoke centres low on the stage, under the title, so the text keeps a calm ground.
      if (f.ambient) {
        cx = W * 0.55;
        cy = H * 0.3;
        unit = H * 0.44;
      } else {
        cx = c[0] + c[2] / 2;
        cy = c[1] + c[3] / 2;
        const column = kit.geo.mask ? kit.geo.mask[2] : W;
        unit = Math.min(c[2] * COVER_UNIT, column * COLUMN_UNIT);
      }
      kit.set2(p, "uCenter", (cx / W) * 2 - 1, (cy / H) * 2 - 1);
      const swell = 1 + BREATH_SCALE * breath;
      kit.set2(p, "uScale", ((unit * 2) / W) * swell, ((unit * 2) / H) * swell);
      kit.set1(p, "uYaw", f.t * 0.06);
      kit.set1(p, "uPitch", 0.35 + Math.sin(f.t * 0.05) * 0.15);
      kit.set1(p, "uPoint", unit * 0.16);
      kit.set1(p, "uLevel", f.sig.level);
      // The trail integrates the emission, so the gain follows the decay to hold the same brightness.
      kit.set1(p, "uGain", (f.light ? 0.022 : 0.007) * ((1 - decay) / (1 - TRAIL_DECAY)));
      gl.uniform3fv(kit.uniform(p, "uPal"), f.palette);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, COUNT);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
    trailCenter: () => [kit.size.w / 2, kit.size.h / 2],
    trailDecay: (f: Frame) => {
      const d = TRAIL_DECAY + TRAIL_QUIET * Math.min(1, f.sig.drive) - TRAIL_LOUD * trailMotion;
      decay = Math.min(TRAIL_MAX, Math.max(TRAIL_MIN, d));
      return decay;
    },
    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(vbo);
    },
  };
}
