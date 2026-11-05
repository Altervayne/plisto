/*
 * Liquid: the cover as a slow liquid surface. A gentle noise flow whose depth swells with the eased bass,
 * and a soft lens that draws the art inward as the swell rises, so the cover breathes with the music. In
 * ambient a blurred liquid copy of the cover drifts across the stage behind it. Calm by design: no
 * per-beat ripple, no channel split, every motion term well under 3 Hz.
 */

// -- Local Imports --
import { FS_VS, PRELUDE } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const FS = `${PRELUDE}
uniform sampler2D uCoverTex;
uniform float uLight;
uniform float uBackdrop;
uniform float uFlow;
uniform float uSwell;
float heightAt(vec2 q) {
  float h = (vnoise(q * 2.6 + vec2(uFlow * 0.5, -uFlow * 0.35)) - 0.5);
  h += (vnoise(q * 5.0 + vec2(-uFlow * 0.3, uFlow * 0.45) + 7.3) - 0.5) * 0.4;
  return h * (0.35 + uSwell * 1.2);
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
  vec2 lens = -q * (0.012 + uSwell * 0.05) * (1.0 - smoothstep(0.0, 0.75, length(q)));
  vec2 uv = clamp(lp + grad * 0.0035 + lens, 0.001, 0.999);
  vec3 col = texture(uCoverTex, uv).rgb;
  vec3 n = normalize(vec3(-grad * 0.35, 1.0));
  vec3 l = normalize(vec3(-0.45, 0.6, 0.66));
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  col += spec * 0.12;
  float sd = sdRound(fc - coverCenter(), uCover.zw * 0.5, uRadius);
  float a = clamp(0.5 - sd, 0.0, 1.0);
  vec3 outc = col * a;
  float outa = a;
  if (uBackdrop > 0.5) {
    vec2 su = fc / uRes;
    vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
    vec2 bq = (su - 0.5) * aspect / 1.35 + 0.5;
    vec2 w = vec2(vnoise(bq * 2.0 + uFlow * 0.08), vnoise(bq * 2.0 + 5.2 - uFlow * 0.07)) - 0.5;
    w += (vec2(vnoise(bq * 4.0 - uFlow * 0.12), vnoise(bq * 4.0 + 9.1 + uFlow * 0.1)) - 0.5) * 0.4;
    bq += w * (0.38 + uSwell * 0.25);
    vec3 bd = textureLod(uCoverTex, fract(bq), 4.6).rgb;
    float v = smoothstep(1.15, 0.2, length((su - 0.5) * vec2(1.1, 1.0)));
    bd = uLight > 0.5 ? mix(vec3(1.0), bd, 0.46 * v + 0.1) : bd * (0.2 + 0.42 * v) * (0.92 + uRms * 0.2);
    outc = mix(bd, col, a);
    outa = 1.0;
  }
  outColor = vec4(outc, outa);
}`;

export function createLiquid(kit: Kit): Candidate {
  const { gl } = kit;
  const tex = gl.createTexture();
  if (!tex) throw new Error("texture allocation failed");
  let uploaded: ImageBitmap | null = null;
  let flow = 0;

  // The bitmap arrives flipped for GL, so it uploads as is; a new cover re-uploads once.
  const upload = (bitmap: ImageBitmap) => {
    uploaded = bitmap;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  };

  return {
    mode: "image",
    bloom: 0.12,
    exposure: 1,
    inkGain: 1,
    trail: null,
    draw(f: Frame) {
      if (!f.cover) return;
      if (f.cover !== uploaded) upload(f.cover);
      // Flow speed rides the eased level, so the surface drifts a little faster in loud passages.
      flow += f.dt * (0.1 + f.sig.level * 0.14);
      const p = kit.program("liquid", FS_VS, FS);
      kit.setCommon(p, f);
      kit.bindTex(p, "uCoverTex", 0, tex);
      kit.set1(p, "uLight", f.light ? 1 : 0);
      kit.set1(p, "uBackdrop", f.ambient ? 1 : 0);
      kit.set1(p, "uFlow", flow);
      kit.set1(p, "uSwell", Math.min(1, f.sig.swell * 1.6));
      kit.drawQuad();
    },
    dispose() {
      gl.deleteTexture(tex);
    },
  };
}
