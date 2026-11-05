/*
 * Silk: the cover's palette woven into a slowly billowing silk sheet, lit softly from the upper left. Two
 * families of folds warped by noise make the sheet; the eased bass and the bass envelope lift them, the
 * mids set the drift, and each beat sends one soft wave front across the cloth from left to right. The
 * colour shifts between two palette blends with the fold's slope, the way shot silk changes between its
 * warp and weft. Light is pale silk with a quiet sheen; dark is deep satin with a coloured sheen.
 *
 * The fold lift changes shading contrast, not mean brightness: the lit and shaded sides of a fold balance.
 * Silk works from the palette alone, so it never waits on cover pixels.
 */

// -- Local Imports --
import { createRings, FLUID_PRELUDE, RING_SLOTS, setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const FS = `${FLUID_PRELUDE}
uniform float uLift;
// The palette as a soft dye field across the sheet: its three colours blended by broad, slow noise, so
// it reads like a heavily blurred cover.
vec3 dye(vec2 uv) { return pal(clamp((fbm(uv * 1.5 + 1.3) - 0.5) * 3.0 + 1.0, 0.0, 2.0)); }
float heightAt(vec2 p) {
  vec2 w = vec2(fbm(p * 1.6 + vec2(uFlow * 0.05, 0.0)), fbm(p * 1.6 + vec2(4.3, uFlow * 0.045))) - 0.5;
  float a = p.x * 15.0 + p.y * 7.0 + w.x * 9.0 + uFlow * 0.6;
  float b = -p.x * 6.0 + p.y * 16.0 + w.y * 8.0 - uFlow * 0.45;
  float h = sin(a) * 0.55 + sin(b) * 0.3 + sin(a * 1.85 + b * 0.35 + 1.3) * 0.1;
  h *= uLift;
  float s = dot(p, normalize(vec2(0.94, 0.34)));
  for (int i = 0; i < ${RING_SLOTS}; i++) {
    float x = (s + 1.1 - uRings[i].x * 0.85) / 0.22;
    h += uRings[i].y * exp(-x * x);
  }
  return h;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (fc - uRes * 0.5) / uRes.y;
  float hu = hushAt(fc);
  float e = 0.004;
  float h0 = heightAt(p);
  vec2 grad = vec2(heightAt(p + vec2(e, 0.0)) - h0, heightAt(p + vec2(0.0, e)) - h0) / e;
  grad *= 1.0 - 0.6 * hu;
  vec3 n = normalize(vec3(-grad * 0.06, 1.0));
  vec3 L = normalize(vec3(-0.5, 0.62, 0.6));
  float diff = dot(n, L) * 0.5 + 0.5;
  vec3 hv = normalize(L + vec3(0.0, 0.0, 1.0));
  float sheen = pow(max(dot(n, hv), 0.0), 28.0) * 0.7 + pow(max(dot(n, hv), 0.0), 6.0) * 0.3;
  vec2 cuv = stageUv(fc) + grad * 0.005;
  vec3 warp = dye(cuv);
  vec3 weft = dye(vec2(1.0) - cuv.yx * 0.8);
  vec3 shot = mix(warp, weft, smoothstep(0.15, 0.85, length(grad) * 0.05));
  vec3 col;
  if (uLight > 0.5) {
    vec3 base = mix(vec3(0.975), shot, 0.42);
    col = base * (0.56 + 0.52 * diff) + sheen * 0.24;
    col = mix(col, mix(uGround, base, 0.4), hu * 0.5);
  } else {
    vec3 base = shot * (0.5 + 0.2 * uRms);
    col = base * (0.14 + 1.05 * diff * diff) + sheen * (shot * 0.6 + 0.06);
    col = mix(col, mix(uGround, base * 0.5, 0.5), hu * 0.55);
  }
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createSilk(kit: Kit): Candidate {
  const rings = createRings(3.2, 0.3, 0.35);
  let flow = 0;

  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    fullBleed: true,
    draw(f: Frame) {
      const s = f.sig;
      flow += f.dt * (0.55 + s.level * 0.3 + s.midMotion * 1.1);
      rings.step(f.dt, s.beat);
      const p = kit.program("silk", FS_VS, FS);
      setFluid(kit, p, f, flow, rings.packed, null);
      kit.set1(p, "uLift", 0.6 + Math.min(1, s.swell * 1.6) * 0.3 + s.bassMotion * 0.35);
      kit.drawQuad();
    },
    dispose() {},
  };
}
