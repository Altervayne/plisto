/*
 * Warp: flying through rings that open from behind the cover. Speed follows the level, the spectrum
 * pushes each ring outward around its circumference, and streaks stretch with speed. A beat is a surge
 * of speed with a soft attack, and the bass envelope adds its own surge under any reactivity but Calm;
 * ring brightness follows only the eased level.
 */

// -- Local Imports --
import { FS_VS, PRELUDE } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// -- Tunables: how the flight moves with the music --
// Speed added per unit of bass envelope, before the surge's soft attack.
const SURGE_BASS = 0.9;

const FS = `${PRELUDE}
uniform float uTravel;
uniform float uSpeed;
void main() {
  vec2 c = coverCenter();
  float unit = uRes.y * 0.5;
  vec2 p = (gl_FragCoord.xy - c) / unit;
  float r = length(p);
  float th = atan(p.y, p.x);
  float z = 0.35 / max(r, 0.02);
  float fog = smoothstep(0.04, 0.55, r) * smoothstep(3.2, 1.2, r);
  float m = abs(th) / PI;
  float spec = band(m);
  // Rings: evenly spaced in depth; the spectrum pushes each ring outward around its circumference,
  // a change of shape rather than of brightness.
  float rz = z * 5.0 * (1.0 - spec * 0.22) + uTravel * 3.0;
  float f = fract(rz);
  float w = fwidth(rz) * 1.2;
  float ring = smoothstep(w + 0.04, 0.0, abs(f - 0.5) - 0.0);
  float seg = smoothstep(0.5, 0.15, abs(fract(th * 48.0 / TAU) - 0.5));
  float ringLit = ring * (0.3 + 0.7 * seg) * (0.55 + uRms * 0.5) * fog * smoothstep(0.4, 0.12, w);
  float sectors = 160.0;
  float sid = floor((th / TAU + 0.5) * sectors);
  float h = hash21(vec2(sid, 3.1));
  float sz = z * 1.2 + uTravel * 1.6 + h * 10.0;
  float cell = floor(sz);
  float on = step(0.86 - uRms * 0.18, hash21(vec2(sid, cell)));
  float len = 0.05 + uSpeed * 0.22;
  float fs = fract(sz);
  float streak = on * smoothstep(0.0, 0.02, fs) * smoothstep(len + 0.02, len, fs);
  float across = abs(fract((th / TAU + 0.5) * sectors) - 0.5);
  streak *= smoothstep(0.12, 0.0, across) * fog * smoothstep(0.08, 0.6, r);
  float hue = fract(z * 0.12 + uTravel * 0.04);
  vec3 ringCol = pal(hue * 2.0);
  vec3 streakCol = mix(pal(hash21(vec2(sid, 7.7)) * 2.0), vec3(1.0, 0.95, 0.88), 0.1);
  vec3 col = ringCol * ringLit * 0.5 + streakCol * streak * (0.3 + uRms * 0.2);
  col += pal(1.0 + m) * exp(-r * 2.4) * 0.3 * (0.4 + uRms);
  outColor = vec4(col, 1.0);
}`;

export function createWarp(kit: Kit): Candidate {
  const { gl } = kit;
  let travel = 0;
  let speed = 0;

  return {
    mode: "glow",
    bloom: 0.75,
    exposure: 1.35,
    inkGain: 2.6,
    trail: null,
    draw(f: Frame) {
      // A beat is a surge of speed with a soft attack, felt as motion; brightness never follows it.
      const target = 0.25 + f.sig.level * 1.1 + f.sig.kick * 1.4 + f.sig.bassMotion * SURGE_BASS;
      speed += (target - speed) * (target > speed ? 0.1 : 0.03);
      travel += f.dt * speed;
      const p = kit.program("warp", FS_VS, FS);
      kit.setCommon(p, f);
      kit.set1(p, "uTravel", travel);
      kit.set1(p, "uSpeed", Math.min(1.5, speed));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      kit.drawQuad();
      gl.disable(gl.BLEND);
    },
    dispose() {},
  };
}
