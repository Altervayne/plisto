/*
 * Glass: the cover, large and soft, seen through a pane of rippled frosted glass. Fine condensation beads
 * come and go on the pane; larger drops run down in stick-slip steps and wipe a clear trail through the
 * beads. Every drop is a small lens that shows the art sharper and upside down. The eased bass and the
 * bass envelope deepen the pane's ripple and the lensing, the mids hurry the drops, and a beat gives them
 * a small slip that eases out. Light is a milky pane with clear drops; dark is smoked glass.
 *
 * Drop and bead sizes are in CSS pixels, and each pixel tests only its own cell, so the cost does not grow
 * with the drop count.
 */

// -- Local Imports --
import { createCoverTexture } from "./coverTexture";
import { FLUID_PRELUDE, setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// Drop momentum added per unit of beat strength, and how fast it eases out, in seconds.
const SLIP_KICK = 1.6;
const SLIP_TAU = 0.35;

const FS = `${FLUID_PRELUDE}
uniform float uRefract;
// Running drops, one per column, in CSS pixels. Returns the lens offset in xy, the drop mask in z and the
// clear trail in w.
vec4 runners(vec2 p) {
  float cw = 74.0;
  float col = floor(p.x / cw);
  float r1 = hash21(vec2(col, 1.7)), r2 = hash21(vec2(col, 8.3)), r3 = hash21(vec2(col, 3.1));
  float span = uRes.y / uDpr + 260.0;
  float period = 11.0 + 13.0 * r1;
  float ph = fract(uFlow / period + r2);
  // Stick-slip: progress pauses and lurches, as a drop does when it gathers and lets go.
  float k = 7.0 + floor(r3 * 5.0);
  float prog = ph - sin(ph * 6.2831 * k) / (6.2831 * k) * 0.92;
  float y = span - prog * span - 130.0;
  float x = (col + 0.5) * cw + sin(y * 0.021 + r1 * 6.0) * cw * 0.16;
  float rad = 7.0 + 6.0 * r2;
  vec2 d = (p - vec2(x, y)) / vec2(rad, rad * 1.18);
  float l = length(d);
  float m = smoothstep(1.0, 0.82, l);
  vec4 res = vec4(d * m, m, 0.0);
  // The trail: small beads left behind above the drop, shrinking and thinning with distance.
  float above = p.y - y;
  if (above > 0.0 && above < 240.0) {
    float tx = (col + 0.5) * cw + sin(p.y * 0.021 + r1 * 6.0) * cw * 0.16;
    res.w = smoothstep(rad * 1.1, rad * 0.5, abs(p.x - tx)) * smoothstep(240.0, 60.0, above);
    float cell = 16.0;
    float cy = (floor(above / cell) + 0.5) * cell;
    float br = rad * 0.32 * smoothstep(260.0, 0.0, cy) * step(0.35, hash21(vec2(col, floor(above / cell))));
    vec2 bd = (p - vec2(tx, y + cy)) / max(br, 0.01);
    float bm = smoothstep(1.0, 0.75, length(bd)) * step(0.5, br);
    if (bm > res.z) res = vec4(bd * bm, bm, res.w);
  }
  return res;
}
// Condensation beads on a fine grid, each fading in and out over its own slow cycle.
vec3 beads(vec2 p) {
  float cell = 20.0;
  vec2 id = floor(p / cell);
  vec2 rnd = vec2(hash21(id), hash21(id + 7.7));
  vec2 c = (id + 0.25 + rnd * 0.5) * cell;
  float life = fract(uTime / (9.0 + 9.0 * rnd.x) + rnd.y);
  float rad = (1.6 + 3.2 * rnd.y) * smoothstep(0.0, 0.3, life) * smoothstep(1.0, 0.7, life) * step(0.62, hash21(id + 3.3));
  vec2 d = (p - c) / max(rad, 0.01);
  float m = smoothstep(1.0, 0.7, length(d)) * step(0.4, rad);
  return vec3(d * m, m);
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  float hu = hushAt(fc);
  vec2 uv = stageUv(fc);
  // The pane's own ripple: a slow low-frequency wave, like old poured glass.
  vec2 rip = vec2(fbm(p * 0.006 + vec2(0.0, uFlow * 0.01)), fbm(p * 0.006 + vec2(4.2, 1.0))) - 0.5;
  uv += rip * 0.05 * uRefract;
  vec4 run = runners(p);
  vec3 bead = beads(p) * (1.0 - run.w);
  float dropMask = max(run.z, bead.z * 0.6) * (1.0 - 0.9 * hu);
  vec2 lensV = run.z > bead.z ? run.xy : bead.xy;
  float strength = (run.z > bead.z ? 0.09 : 0.035) * uRefract;
  vec3 frost = textureLod(uCoverTex, uv, mix(4.8, 4.0, run.w)).rgb;
  vec3 clear = textureLod(uCoverTex, uv - lensV * strength * 1.4 + vec2(0.0, 0.01), 1.4).rgb;
  float rimShade = smoothstep(0.35, 1.0, length(lensV)) * dropMask;
  float glint = smoothstep(0.42, 0.0, length(lensV - vec2(-0.32, 0.38))) * dropMask;
  vec3 col;
  if (uLight > 0.5) {
    vec3 pane = mix(vec3(0.985), frost, 0.48 + 0.1 * run.w);
    pane = mix(pane, uGround, hu * 0.45);
    vec3 drop = mix(vec3(0.96), clear, 0.58);
    col = mix(pane, drop, dropMask) * (1.0 - rimShade * 0.14) + glint * 0.2;
  } else {
    vec3 pane = frost * (0.26 + 0.1 * uRms + 0.04 * run.w);
    pane = mix(pane, uGround, hu * 0.5);
    vec3 drop = clear * (0.42 + 0.12 * uRms);
    col = mix(pane, drop, dropMask) * (1.0 - rimShade * 0.35) + glint * 0.08;
  }
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createGlass(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  let flow = 0;
  let slip = 0;

  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    fullBleed: true,
    draw(f: Frame) {
      if (!f.cover) return;
      art.sync(f.cover);
      const s = f.sig;
      // A beat adds momentum that eases out, so the drops lurch and settle.
      if (s.beat > 0) slip += s.beat * SLIP_KICK;
      slip *= Math.exp(-f.dt / SLIP_TAU);
      flow += f.dt * (1 + s.level * 0.6 + s.midMotion * 1.4 + slip);
      const p = kit.program("glass", FS_VS, FS);
      setFluid(kit, p, f, flow, null, art.tex);
      kit.set1(p, "uRefract", 0.8 + Math.min(1, s.swell * 1.6) * 0.5 + s.bassMotion * 0.7);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
