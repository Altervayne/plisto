/*
 * Liquid: the cover as a liquid surface. A noise flow whose depth swells with the eased bass, and a soft
 * lens that draws the art inward as the swell rises, so the cover breathes with the music. Behind it a
 * blurred liquid copy of the cover drifts across the whole stage, in ambient and the Player alike. Ambient
 * fades it toward the screen edges; the Player keeps it flat to the panel's edges, under the queue too.
 *
 * The motion channel rides on top: the bass envelope punches the depth and the lens, each beat drops one
 * smooth ring from the centre, the mids speed the flow and the highs add a fine shimmer to the refraction
 * only, never the lighting. No channel split. Under Calm every one of these terms is zero.
 */

// -- Local Imports --
import { createCoverTexture } from "./coverTexture";
import { FS_VS, PRELUDE } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// -- Tunables: how the surface moves with the music --
// Surface depth and lens pull added per unit of bass envelope.
const PUNCH_DEPTH = 1.3;
const PUNCH_LENS = 0.07;
// Flow speed added per unit of mid envelope, on top of the level-driven base.
const FLOW_MID = 0.35;
// The high shimmer: its scale across the cover and its refraction per unit of high envelope.
const SHIMMER_SCALE = 34;
const SHIMMER_AMP = 0.004;
// The beat ripple: rings alive at once, their life in seconds, outward speed and width in cover widths,
// fade-in in seconds, and height per unit of beat strength.
const RIPPLE_MAX = 3;
const RIPPLE_LIFE = 1.2;
const RIPPLE_SPEED = 0.6;
const RIPPLE_WIDTH = 0.06;
const RIPPLE_RISE = 0.08;
const RIPPLE_HEIGHT = 0.2;

const FS = `${PRELUDE}
uniform sampler2D uCoverTex;
uniform float uLight;
uniform float uEdge;
uniform float uFlow;
uniform float uSwell;
uniform float uPunchDepth;
uniform float uPunchLens;
uniform float uShimmer;
// Per ring: its radius and its height.
uniform vec2 uRipple[${RIPPLE_MAX}];
float heightAt(vec2 q) {
  float h = (vnoise(q * 2.6 + vec2(uFlow * 0.5, -uFlow * 0.35)) - 0.5);
  h += (vnoise(q * 5.0 + vec2(-uFlow * 0.3, uFlow * 0.45) + 7.3) - 0.5) * 0.4;
  h *= 0.35 + uSwell * 1.2 + uPunchDepth;
  float d = length(q);
  for (int i = 0; i < ${RIPPLE_MAX}; i++) {
    float x = (d - uRipple[i].x) / ${RIPPLE_WIDTH.toFixed(4)};
    h += uRipple[i].y * exp(-x * x);
  }
  return h;
}
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 lp = (fc - uCover.xy) / uCover.zw;
  vec2 q = lp - 0.5;
  float e = 0.004;
  float h0 = heightAt(q);
  vec2 grad = vec2(heightAt(q + vec2(e, 0.0)) - h0, heightAt(q + vec2(0.0, e)) - h0) / e;
  // The lens draws the art slightly inward toward the centre as the swell rises, so the cover breathes.
  vec2 lens = -q * (0.012 + uSwell * 0.05 + uPunchLens) * (1.0 - smoothstep(0.0, 0.75, length(q)));
  vec2 sq = q * ${SHIMMER_SCALE.toFixed(1)} + uFlow * 2.0;
  vec2 shimmer = (vec2(vnoise(sq), vnoise(sq + 17.1)) - 0.5) * uShimmer;
  vec2 uv = clamp(lp + grad * 0.0035 + lens + shimmer, 0.001, 0.999);
  vec3 col = texture(uCoverTex, uv).rgb;
  vec3 n = normalize(vec3(-grad * 0.35, 1.0));
  vec3 l = normalize(vec3(-0.45, 0.6, 0.66));
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  col += spec * 0.12;
  float sd = sdRound(fc - coverCenter(), uCover.zw * 0.5, uRadius);
  float a = clamp(0.5 - sd, 0.0, 1.0);
  vec2 su = fc / uRes;
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 bq = (su - 0.5) * aspect / 1.35 + 0.5;
  vec2 w = vec2(vnoise(bq * 2.0 + uFlow * 0.08), vnoise(bq * 2.0 + 5.2 - uFlow * 0.07)) - 0.5;
  w += (vec2(vnoise(bq * 4.0 - uFlow * 0.12), vnoise(bq * 4.0 + 9.1 + uFlow * 0.1)) - 0.5) * 0.4;
  bq += w * (0.38 + uSwell * 0.25);
  vec3 bd = textureLod(uCoverTex, fract(bq), 4.6).rgb;
  float v = mix(1.0, smoothstep(1.15, 0.2, length((su - 0.5) * vec2(1.1, 1.0))), uEdge);
  bd = uLight > 0.5 ? mix(vec3(1.0), bd, 0.46 * v + 0.1) : bd * (0.2 + 0.42 * v) * (0.92 + uRms * 0.2);
  outColor = vec4(mix(bd, col, a), 1.0);
}`;

export function createLiquid(kit: Kit): Candidate {
  const { gl } = kit;
  const cover = createCoverTexture(gl);
  let flow = 0;
  // Live rings, oldest first: age in seconds and beat strength.
  const rings: { age: number; strength: number }[] = [];
  const ripple = new Float32Array(RIPPLE_MAX * 2);

  // Ages the rings, drops a new one on a beat, and packs radius and height for the shader. A ring fades
  // in, then falls to nothing at the end of its life, so neither end pops.
  const stepRings = (dt: number, beat: number) => {
    for (const ring of rings) ring.age += dt;
    while (rings.length > 0 && rings[0].age >= RIPPLE_LIFE) rings.shift();
    if (beat > 0) {
      if (rings.length === RIPPLE_MAX) rings.shift();
      rings.push({ age: 0, strength: Math.min(1.5, beat) });
    }
    ripple.fill(0);
    rings.forEach((ring, i) => {
      const fadeIn = Math.min(1, ring.age / RIPPLE_RISE);
      const fadeOut = (1 - ring.age / RIPPLE_LIFE) ** 2;
      ripple[i * 2] = ring.age * RIPPLE_SPEED;
      ripple[i * 2 + 1] = ring.strength * RIPPLE_HEIGHT * fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut;
    });
  };

  return {
    mode: "image",
    bloom: 0.12,
    exposure: 1,
    inkGain: 1,
    trail: null,
    draw(f: Frame) {
      if (!f.cover) return;
      cover.sync(f.cover);
      const s = f.sig;
      // Flow speed rides the eased level, so the surface drifts a little faster in loud passages.
      flow += f.dt * (0.1 + s.level * 0.14 + s.midMotion * FLOW_MID);
      stepRings(f.dt, s.beat);
      const p = kit.program("liquid", FS_VS, FS);
      kit.setCommon(p, f);
      kit.bindTex(p, "uCoverTex", 0, cover.tex);
      kit.set1(p, "uLight", f.light ? 1 : 0);
      kit.set1(p, "uEdge", f.ambient ? 1 : 0);
      kit.set1(p, "uFlow", flow);
      kit.set1(p, "uSwell", Math.min(1, s.swell * 1.6));
      kit.set1(p, "uPunchDepth", s.bassMotion * PUNCH_DEPTH);
      kit.set1(p, "uPunchLens", s.bassMotion * PUNCH_LENS);
      kit.set1(p, "uShimmer", s.highMotion * SHIMMER_AMP);
      gl.uniform2fv(kit.uniform(p, "uRipple"), ripple);
      kit.drawQuad();
    },
    dispose() {
      cover.dispose();
    },
  };
}
