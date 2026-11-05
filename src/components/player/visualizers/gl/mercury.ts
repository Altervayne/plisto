/*
 * Mercury: the stage as a pool of liquid chrome mirroring a blurred cover. Broad swells roll slowly, their
 * depth riding the eased bass; the bass envelope raises a smooth swell around the cover; each beat drops
 * one glossy wave packet that runs out from the cover. The highs add a fine tension shimmer to the normals
 * only. Slopes facing the light catch the sky, so the chrome reads as moving bands of the cover's colour:
 * bright silver on light, black mercury with luminous bands on dark.
 *
 * Chrome turns slope into brightness, so the bass envelope may only lift the local swell around the cover.
 * A stage-wide depth on it would pump the overall luminance on the beat.
 */

// -- Local Imports --
import { createCoverTexture } from "./coverTexture";
import { createRings, FLUID_PRELUDE, RING_SLOTS, setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const FS = `${FLUID_PRELUDE}
float heightAt(vec2 q) {
  vec2 f = vec2(uFlow * 0.16, -uFlow * 0.11);
  float h = (fbm(q * 0.8 + f) - 0.5) * (0.55 + uSwell * 0.7);
  h += (vnoise(q * 1.9 - f * 1.4 + 3.1) - 0.5) * 0.16;
  float d = length(q);
  h += uBassM * 0.12 * exp(-pow((d - 0.75) / 0.45, 2.0));
  for (int i = 0; i < ${RING_SLOTS}; i++) {
    float x = (d - 0.55 - uRings[i].x * 0.62) / 0.07;
    h += uRings[i].y * sin(x * 1.6) * exp(-x * x * 0.9);
  }
  return h;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 q = coverQ(fc);
  float hu = hushAt(fc);
  float e = 0.012;
  float h0 = heightAt(q);
  vec2 grad = vec2(heightAt(q + vec2(e, 0.0)) - h0, heightAt(q + vec2(0.0, e)) - h0) / e;
  vec2 sq = q * 26.0 + vec2(uFlow * 0.9, -uFlow * 0.7);
  grad += (vec2(vnoise(sq), vnoise(sq + 9.1)) - 0.5) * uHighM * 0.22;
  grad *= 1.0 - 0.85 * hu;
  vec3 n = normalize(vec3(-grad * 0.6, 1.0));
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  vec3 sky = textureLod(uCoverTex, stageUv(fc) + r.xy * 0.5, 4.2).rgb;
  vec2 L = normalize(vec2(-0.5, 0.8));
  float t = dot(r.xy, L) * 2.4;
  float glint = pow(max(dot(r, normalize(vec3(-0.35, 0.55, 0.76))), 0.0), 90.0);
  vec3 col;
  if (uLight > 0.5) {
    vec3 silver = mix(vec3(luma(sky)), sky, 0.45);
    vec3 hi = mix(vec3(0.97), silver * 0.35 + 0.68, 0.55);
    vec3 lo = mix(silver * 0.8 + 0.16, vec3(0.66, 0.67, 0.71), 0.5);
    col = mix(lo, hi, smoothstep(-0.32, 0.06, t + 0.12));
    col += glint * 0.12;
    col = mix(col, mix(uGround, hi, 0.5), hu * 0.7);
  } else {
    vec3 tint = mix(vec3(luma(sky)), sky, 0.85) * 1.25;
    vec3 hi = tint * (0.55 + 0.25 * uRms);
    vec3 lo = uGround + sky * 0.05;
    col = mix(lo, hi, smoothstep(-0.02, 0.4, t - 0.08));
    col += glint * tint * 0.35;
    col = mix(col, mix(uGround, hi, 0.25), hu * 0.7);
  }
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createMercury(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const rings = createRings(1.6, 0.12, 0.05);
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
      if (!f.cover) return;
      art.sync(f.cover);
      const s = f.sig;
      flow += f.dt * (0.22 + s.level * 0.16 + s.midMotion * 0.35);
      rings.step(f.dt, s.beat);
      const p = kit.program("mercury", FS_VS, FS);
      setFluid(kit, p, f, flow, rings.packed, art.tex);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
