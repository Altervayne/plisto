/*
 * Bloom: a polar spectrum around the cover. A mirrored full-spectrum outline, six counter-rotating
 * petals and a fine twelve-point crown, drawn as glowing lines. Each frame feeds back slightly zoomed and
 * turned, so the petals leave blooming trails; a beat kicks the zoom and the petal reach, never the
 * brightness.
 */

// -- Local Imports --
import { FS_VS, PRELUDE } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const FS = `${PRELUDE}
uniform float uSpin;
void main() {
  vec2 c = coverCenter();
  float unit = uCover.z * 0.5;
  vec2 p = (gl_FragCoord.xy - c) / unit;
  float r = length(p);
  float th = atan(p.y, p.x);
  float m1 = abs(mod(th - uSpin + PI, TAU) - PI) / PI;
  float r1 = 1.28 + band(m1) * 1.55 * (1.0 + uKick * 0.4);
  float l1 = exp(-pow((r - r1) * 10.0, 2.0)) * 1.3;
  vec3 col = mix(uPal[0], uPal[2], m1) * l1;
  float a2 = (th + uSpin * 1.7) * 6.0 / TAU;
  float m2 = abs(fract(a2) * 2.0 - 1.0);
  float r2 = 1.12 + band(m2) * 1.05 * (0.8 + uMid * 0.8);
  float l2 = exp(-pow((r - r2) * 14.0, 2.0)) * 0.9;
  col += uPal[1] * l2 * 1.2;
  float a3 = (th - uSpin * 0.6) * 12.0 / TAU;
  float m3 = abs(fract(a3) * 2.0 - 1.0);
  float r3 = 1.9 + band(0.45 + m3 * 0.55) * 1.6 * (0.6 + uHigh * 1.4);
  float l3 = exp(-pow((r - r3) * 22.0, 2.0)) * 0.55;
  col += mix(uPal[2], vec3(1.0), 0.35) * l3;
  // Low per-frame emission: the feedback pass integrates roughly ten frames of it.
  col *= 0.06 + uRms * 0.12;
  outColor = vec4(col, 1.0);
}`;

export function createBloom(kit: Kit): Candidate {
  const { gl } = kit;
  let spin = 0;

  return {
    mode: "glow",
    bloom: 0.6,
    exposure: 1.1,
    inkGain: 0.8,
    trail: { decay: 0.82, zoom: 1.006, rot: 0.0025 },
    draw(f: Frame) {
      spin += f.dt * (0.05 + f.sig.rms * 0.12);
      const p = kit.program("bloom", FS_VS, FS);
      kit.setCommon(p, f);
      kit.set1(p, "uSpin", spin);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      kit.drawQuad();
      gl.disable(gl.BLEND);
    },
    trailCenter: () => {
      const c = kit.geo.cover;
      return [c[0] + c[2] / 2, c[1] + c[3] / 2];
    },
    trailZoom: (f: Frame) => 1.004 + f.sig.rms * 0.005 + f.sig.kick * 0.022,
    dispose() {},
  };
}
