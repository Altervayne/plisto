/*
 * Halftone: a field of round dots on a staggered print grid, colored from the cover palette, resting on
 * the seek bar and filling the stage above it. Only the dot size moves: the bass envelope swells the dots
 * near the bottom centre, the high envelope runs a slow outward ripple through the upper and outer dots,
 * and each beat rolls a size wave out from the cover. At rest the field is a halftone ramp, full near the
 * floor and fine toward the top. Behind the source line and the title the dots shrink under the hush, so
 * the words keep a quiet ground.
 */

// -- Local Imports --
import { createDots, DOT_FS, DOT_PRELUDE } from "./dots";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// Grid pitch in CSS pixels, in ambient and in the Player.
const PITCH_AMBIENT = 19;
const PITCH_PLAYER = 15;

const VS = `${DOT_PRELUDE}
uniform vec2 uOrigin;
uniform float uPitch;
uniform int uCols;
uniform vec4 uField;
uniform vec2 uBassC;
uniform float uScale;
void main() {
  int gx = gl_InstanceID % uCols, gy = gl_InstanceID / uCols;
  // Staggered rows: the hexagonal packing of a printed halftone.
  vec2 c = uOrigin + vec2(float(gx) + float(gy % 2) * 0.5, float(gy) * 0.8660254) * uPitch;
  if (c.x < uField.x - uPitch || c.x > uField.z + uPitch || c.y > uField.w + uPitch) { hide(); return; }
  vec2 q = (c - uBassC) / uScale;
  float bassW = exp(-(q.x * q.x * 1.5 + q.y * q.y * 3.0));
  float up = clamp((c.y - uField.y) / (uField.w - uField.y), 0.0, 1.0);
  float side = clamp(abs(c.x - uBassC.x) / ((uField.z - uField.x) * 0.5), 0.0, 1.0);
  float highW = smoothstep(0.25, 0.95, max(up, side));
  // The highs ride a ripple that travels outward, under 1 Hz at any one dot.
  float rip = 0.5 + 0.5 * sin(length(q) * 24.0 - uTime * 5.0);
  float n = vnoise(q * 3.0 + vec2(uTime * 0.06, -uTime * 0.045));
  float s = 0.05 + 0.15 * pow(1.0 - up, 1.3) + 0.07 * n;
  s += 0.22 * uEnvB * bassW + 0.16 * uEnvH * highW * rip + 0.05 * uEnvM * (1.0 - bassW);
  s += 0.16 * beatWave(length(c - coverCenter()) / uScale, 0.95, 0.07, 1.4);
  s = clamp(s * mix(1.0, 0.4, hushAt(c)), 0.04, 0.5);
  vec3 col = pal(side * 1.25 + up * 0.55 + (n - 0.5) * 0.6);
  if (uLight > 0.5) emit(c, s * uPitch, ink(col), 0.6 + 0.3 * uRms, 0.0);
  else emit(c, s * uPitch, col * (0.3 + 0.45 * uRms), 1.0, 0.35);
}`;

export function createHalftone(kit: Kit): Candidate {
  const dots = createDots(kit);

  return {
    mode: "glow",
    bloom: 0.45,
    exposure: 1.4,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      const { w: W, h: H, dpr } = kit.size;
      const { mask, cover } = kit.geo;
      const pitch = (f.ambient ? PITCH_AMBIENT : PITCH_PLAYER) * dpr;
      const rowH = pitch * 0.8660254;
      const x0 = mask ? mask[0] : 0;
      const x1 = mask ? mask[0] + mask[2] : W;
      const y0 = dots.floorY();
      const cx = f.ambient ? W * 0.5 : cover[0] + cover[2] / 2;
      // The grid is anchored on the bass centre so a dot column always runs straight through it.
      const ox = cx - pitch * Math.ceil((cx - x0) / pitch + 1);
      const cols = Math.ceil((x1 - ox) / pitch) + 1;
      const rows = Math.max(0, Math.ceil((H - y0) / rowH) + 1);
      const p = kit.program("halftone", VS, DOT_FS);
      dots.begin(p, f);
      kit.set2(p, "uOrigin", ox, y0 + pitch * 0.5);
      kit.set1(p, "uPitch", pitch);
      kit.seti(p, "uCols", cols);
      kit.set4(p, "uField", [x0, y0, x1, H]);
      kit.set2(p, "uBassC", cx, y0);
      kit.set1(p, "uScale", Math.max(1, H - y0));
      dots.draw(cols * rows, !f.light);
    },
    dispose() {
      dots.dispose();
    },
  };
}
