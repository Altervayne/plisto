/*
 * Record: a close-up of a vinyl record turning on a walnut desk, with the cover as its label. The label art
 * is the cover printed on paper and turning with the disc. Two soft bow-tie lobes of light, warm and cool,
 * slide across the grooves; a little dust and lint ride the record; a tonearm rests in the groove and
 * travels from the lead-in to the run-out as the track plays, lifting clear when it has to jump.
 *
 * The eased level sets how strongly the grooves catch the light. The bass envelope only nudges where the
 * lobes sit and makes the arm tremble (position). The turn is a fixed 33 1/3 rpm.
 *
 * Photosensitivity: brightness follows only the eased level (uRms); beats and the bass envelope move
 * things without changing their luminance.
 */

// -- Local Imports --
import { createCoverTexture } from "./coverTexture";
import { clamp01, COZY_PRELUDE } from "./cozy";
import { setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// Revolutions per second at 33 1/3 rpm.
const SPIN_RATE = 33.3333 / 60;
// The stylus radius as a share of the record: the lead-in groove and the run-out groove.
const ARM_START = 0.965;
const ARM_END = 0.65;
// Arm easing time constants in seconds: a long move, then a settled follow. The gap that tells them apart.
const ARM_TAU_FAR = 0.8;
const ARM_TAU_NEAR = 0.15;
const ARM_FAR = 0.05;
// The arm lifts clear while it is further than this from its target, easing with this time constant.
const LIFT_GAP = 0.03;
const LIFT_TAU = 0.5;

/** The stylus radius for a track position in 0..1; null (unknown) parks the arm at the lead-in. */
export function armTarget(progress: number | null | undefined): number {
  if (progress == null) return ARM_START;
  return ARM_START + (ARM_END - ARM_START) * clamp01(progress);
}

const FS = `${COZY_PRELUDE}
uniform float uSpin;     // record angle, radians
uniform float uArmR;     // stylus radius, share of the record: the track position
uniform float uLift;     // 0 resting in the groove, 1 lifted clear
// -- Tunables --
const float RECORD_R = 1.28;     // record radius in cover widths
const float LABEL_R = 0.76;      // label radius in cover widths
const float SHEEN_DARK = 0.42;
const float SHEEN_LIGHT = 0.5;
const float LOBE_SHARP = 16.0;   // higher is a narrower bow-tie
const float DUST = 1.0;
const float ARM_LEN = 0.6;      // tonearm length, in record radii
const vec3 WALNUT = vec3(0.36, 0.22, 0.12);   // light-theme desk

float seg(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 pa = p - a, ba = b - a;
  t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}
// Soft shadow-free wood: planks with a long grain, lit by a lamp pool.
vec3 desk(vec2 p, vec2 sz, float lamp) {
  float plank = floor(p.y / 118.0);
  float grain = fbm(vec2(p.x * 0.004 + hash21(vec2(plank, 2.0)) * 20.0, p.y * 0.35));
  float seam = smoothstep(1.4, 0.0, abs(fract(p.y / 118.0) - 0.0) * 118.0) * 0.5;
  vec3 base = uLight > 0.5 ? WALNUT : vec3(0.075, 0.048, 0.03);
  vec3 col = base * (0.86 + 0.28 * grain) * (0.94 + 0.12 * hash21(vec2(plank, 5.0)));
  col *= 1.0 - seam * (uLight > 0.5 ? 0.4 : 0.6);
  col *= uLight > 0.5 ? (0.72 + 0.6 * lamp) : (0.5 + 1.5 * lamp);
  if (uLight < 0.5) col += vec3(1.0, 0.62, 0.3) * 0.05 * lamp * lamp;
  return col;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, sz = uRes / uDpr;
  float hu = hushAt(fc);
  float lit = uLight > 0.5 ? 1.0 : 0.0;
  vec2 cc = coverCenter() / uDpr;
  float z = uCover.z / uDpr;
  float R = RECORD_R * z, Rl = LABEL_R * z;
  vec2 q = p - cc;
  float r = length(q);
  float th = atan(q.y, q.x);
  float lamp = exp(-pow(length((p - sz * vec2(0.12, 0.92)) / (sz.y * 0.95)), 2.0));
  vec3 col = desk(p, sz, lamp);
  // The record's shadow on the desk and the platter rim.
  float shadow = smoothstep(R + 34.0, R - 6.0, length(q - vec2(10.0, -16.0)));
  col *= 1.0 - shadow * (lit > 0.5 ? 0.3 : 0.55);
  float platter = smoothstep(R + 9.0, R + 7.0, r) * smoothstep(R - 1.0, R + 1.0, r + 0.0);
  col = mix(col, (lit > 0.5 ? vec3(0.62, 0.62, 0.64) : vec3(0.1, 0.1, 0.11)) * (0.8 + 0.5 * lamp), platter);
  if (r < R) {
    float rr = r / R;
    // Vinyl: near black, with a fine groove texture and lanes between tracks.
    vec3 vinyl = lit > 0.5 ? vec3(0.07, 0.07, 0.08) : vec3(0.02, 0.02, 0.024);
    float groove = 0.5 + 0.5 * sin(r * 2.4 + 1.7 * vnoise(vec2(r * 0.05, 0.0)));
    float lane = 0.0;
    lane += smoothstep(2.6, 0.4, abs(rr - 0.58) * R);
    lane += smoothstep(2.6, 0.4, abs(rr - 0.72) * R);
    lane += smoothstep(2.6, 0.4, abs(rr - 0.85) * R);
    float deadWax = smoothstep(Rl + 4.0, Rl + 60.0, r) * 0.0 + smoothstep(Rl * 1.05 + 22.0, Rl * 1.05 + 2.0, r);
    // Scuffs ride the record, so the turn shows even where the grooves are uniform.
    float ts = th - uSpin;
    float scuff = vnoise(vec2(r * 0.18, ts * r * 0.012)) * vnoise(vec2(r * 0.05 + 7.0, ts * 3.0));
    // Two bow-tie lobes of light, warm and cool, sliding across.
    float phiA = 0.75 + 0.42 * sin(uTime * 0.055) + 0.06 * uBassM + (rr - 0.6) * 0.22;
    float phiB = 2.55 + 0.38 * sin(uTime * 0.043 + 1.3) - 0.05 * uBassM + (rr - 0.6) * -0.2;
    float lobeA = pow(max(cos(2.0 * (th - phiA)), 0.0), LOBE_SHARP);
    float lobeB = pow(max(cos(2.0 * (th - phiB)), 0.0), LOBE_SHARP * 1.4);
    float e0 = Rl * 1.08 / R;
    float env = smoothstep(e0, e0 + 0.1, rr) * smoothstep(1.0, 0.8, rr);
    float amp = (lit > 0.5 ? SHEEN_LIGHT : SHEEN_DARK) * (0.7 + 0.6 * uRms);
    float fine = 0.65 + 0.35 * groove;
    float roughen = 0.8 + 0.4 * scuff;
    vec3 sheen = (vec3(1.0, 0.78, 0.52) * lobeA + vec3(0.6, 0.76, 1.0) * lobeB * 0.8) * env * amp * fine * roughen * (1.0 - 0.7 * lane);
    vinyl *= 0.85 + 0.3 * groove;
    vinyl += sheen;
    // A soft ring of light at the lead-in edge.
    vinyl += (lit > 0.5 ? 0.06 : 0.03) * smoothstep(3.0, 0.0, abs(rr - 0.975) * R) * (0.4 + lamp);
    vinyl *= 1.0 - lane * 0.5;
    // Dust and lint, turning with the record.
    float marks = 0.0;
    if (r > Rl * 1.08 && r < R * 0.98) {
      for (int i = 0; i < 18; i++) {
        float fi = float(i);
        float h1 = hash21(vec2(fi, 3.0)), h2 = hash21(vec2(fi, 8.0)), h3 = hash21(vec2(fi, 13.0));
        float rad = mix(Rl * 1.12, R * 0.96, h1);
        float a = h2 * 6.2831 + uSpin;
        vec2 c = rad * vec2(cos(a), sin(a));
        vec2 d = q - c;
        if (i < 10) {
          marks += smoothstep(1.7 + h3, 0.0, length(d)) * (0.5 + 0.5 * h3);
        } else {
          float ang = h3 * 6.2831 + uSpin;
          vec2 u = vec2(cos(ang), sin(ang));
          vec2 loc = vec2(dot(d, u), dot(d, vec2(-u.y, u.x)));
          float len = 9.0 + 10.0 * h1;
          loc.y -= 0.09 * loc.x * loc.x / len * (h2 > 0.5 ? 1.0 : -1.0);
          marks += smoothstep(1.1, 0.2, abs(loc.y)) * smoothstep(len, len - 3.0, abs(loc.x)) * 0.8;
        }
      }
    }
    vinyl += marks * DUST * (lit > 0.5 ? vec3(0.5, 0.5, 0.52) : vec3(0.42, 0.4, 0.38)) * (1.0 - 0.8 * hu);
    // The label: the cover's colours, printed on paper, turning.
    float labelM = smoothstep(Rl + 1.2, Rl - 1.2, r);
    vec2 lq = mat2(cos(uSpin), -sin(uSpin), sin(uSpin), cos(uSpin)) * q;
    vec3 art = textureLod(uCoverTex, 0.5 + lq / (Rl * 2.1), 1.6).rgb;
    vec3 paper = lit > 0.5 ? mix(vec3(0.95, 0.93, 0.88), art, 0.82) : art * 0.7 + vec3(0.02);
    float printRing = smoothstep(1.3, 0.2, abs(r - Rl * 0.96));
    paper = mix(paper, lit > 0.5 ? vec3(0.96, 0.94, 0.9) : vec3(0.85, 0.8, 0.7), printRing * 0.35);
    paper *= lit > 0.5 ? 1.0 : 0.62 + 0.25 * uRms;
    paper = mix(paper, lit > 0.5 ? vec3(0.96, 0.95, 0.93) : paper * 0.7, hu * 0.55);
    vec3 rec = mix(vinyl, paper, labelM);
    float edge = smoothstep(R - 2.0, R, r);
    rec *= 1.0 - edge * 0.35;
    rec += edge * (lit > 0.5 ? 0.12 : 0.05) * lamp;
    col = mix(col, rec, smoothstep(R + 0.8, R - 0.8, r));
  }
  // The deck's front lip, under the transport: the record ends behind it.
  float fp = uFloor / uDpr + 30.0;
  col *= 1.0 - 0.4 * smoothstep(fp + 22.0, fp, p.y);
  float panel = smoothstep(fp + 0.8, fp - 0.8, p.y);
  float pg = fbm(vec2(p.x * 0.004, p.y * 0.3 + 9.0));
  vec3 lip = lit > 0.5 ? WALNUT * 1.3 * (0.92 + 0.2 * pg) * (0.85 + 0.4 * lamp) : vec3(0.058, 0.038, 0.027) * (0.8 + 0.5 * pg) * (0.6 + 1.2 * lamp);
  lip += (lit > 0.5 ? 0.05 : 0.05) * smoothstep(3.0, 0.0, abs(p.y - fp + 1.5));
  col = mix(col, lip, panel);
  // The tonearm: a tube from a pivot beyond the record to a headshell resting in the groove.
  vec2 pivot = cc + R * vec2(0.45, 1.15);
  // The stylus sits where a circle round the pivot (the arm length) meets the circle of its groove radius.
  vec2 pv = pivot - cc;
  float dl = length(pv), rg = uArmR * R, AL = ARM_LEN * R;
  float ia = (rg * rg - AL * AL + dl * dl) / (2.0 * dl);
  float ih = sqrt(max(rg * rg - ia * ia, 0.0));
  vec2 tip = cc + pv / dl * ia - vec2(-pv.y, pv.x) / dl * ih;
  vec2 dir = normalize(pivot - tip);
  vec2 bend = tip + dir * 40.0 + vec2(-dir.y, dir.x) * 5.0;
  vec2 tremble = vec2(0.0, 1.0) * uBassM * 1.4;
  float t1, t2, t3;
  float dTube = seg(p, pivot + tremble, bend + tremble, t1);
  float dHead = seg(p, bend + tremble, tip + tremble, t2);
  float tube = smoothstep(6.0, 4.4, dTube + 0.0 * t1);
  float head = smoothstep(10.0, 8.2, dHead) * (1.0 - tube);
  vec2 off = mix(vec2(14.0, -20.0), vec2(34.0, -50.0), uLift);
  float sdTube = seg(p - off, pivot, bend, t3);
  float armShadow = smoothstep(11.0, 2.0, min(sdTube, seg(p - off, bend, tip, t3)));
  col *= 1.0 - armShadow * mix(0.3, 0.16, uLift) * (1.0 - tube) * (lit > 0.5 ? 0.8 : 1.0);
  float shade = 0.55 + 0.45 * smoothstep(-3.5, 3.5, dot(p - (pivot + (bend - pivot) * t1), vec2(-dir.y, dir.x)) * -1.0);
  vec3 metal = lit > 0.5 ? mix(vec3(0.45, 0.45, 0.47), vec3(0.95, 0.95, 0.96), shade) : mix(vec3(0.2, 0.2, 0.22), vec3(0.8, 0.76, 0.72), shade);
  vec3 headCol = lit > 0.5 ? vec3(0.16, 0.16, 0.17) : vec3(0.04, 0.04, 0.045) + vec3(0.2, 0.15, 0.1) * 0.12 * lamp;
  col = mix(col, headCol, head);
  col = mix(col, metal, tube);
  // Motes floating in the lamp light above it all.
  float motes = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float h1 = hash21(vec2(fi, 21.0)), h2 = hash21(vec2(fi, 34.0)), h3 = hash21(vec2(fi, 55.0));
    vec2 c = sz * vec2(h1, fract(h2 + uTime * (0.006 + 0.01 * h3))) + vec2(sin(uTime * 0.3 + fi * 2.0) * 14.0, 0.0);
    float inLight = exp(-pow(length((c - sz * vec2(0.12, 0.92)) / (sz.y * 0.9)), 2.0));
    motes += smoothstep(2.2 + 1.4 * h3, 0.0, length(p - c)) * inLight * (0.4 + 0.6 * h3);
  }
  col += motes * (lit > 0.5 ? vec3(0.0) : vec3(1.0, 0.85, 0.62) * 0.5) * (1.0 - hu * 0.8);
  outColor = vec4(settle(col, fc), 1.0);
}`;


export function createRecord(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  let spin = 0;
  let arm = ARM_START;
  let lift = 0;
  let started = false;

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
      spin += f.dt * SPIN_RATE * 2 * Math.PI;
      const target = armTarget(f.progress);
      if (!started) {
        started = true;
        arm = target;
      }
      const gap = Math.abs(target - arm);
      arm += (target - arm) * (1 - Math.exp(-f.dt / (gap > ARM_FAR ? ARM_TAU_FAR : ARM_TAU_NEAR)));
      lift += ((gap > LIFT_GAP ? 1 : 0) - lift) * (1 - Math.exp(-f.dt / LIFT_TAU));
      const p = kit.program("record", FS_VS, FS);
      setFluid(kit, p, f, 0, null, art.tex);
      kit.set1(p, "uSpin", spin);
      kit.set1(p, "uArmR", arm);
      kit.set1(p, "uLift", lift);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
