/*
 * Ink: the cover's colours bleed out of its edges like ink dropped in still water and drift across the
 * stage as slow curling plumes that thin and fade. Light draws true ink on paper, each pigment absorbing
 * its complement; dark draws the same plumes as luminous colour in deep water.
 *
 * A half-size dye buffer is advected each frame: rgb is pigment, a is density. The velocity is curl noise,
 * so it swirls with no pressure solve, plus a slow outward drift from the cover's rim. The bass envelope
 * pushes harder out of the rim, which lifts a new plume; each beat adds a radial pressure front that also
 * bends the view of the dye as it passes; the mids hurry the drift. Dye enters at a few slowly wandering
 * spots on the rim at a rate set by the eased level only.
 */

// -- Local Imports --
import { createCoverTexture } from "./coverTexture";
import { createRings, FLUID_PRELUDE, setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit, Target } from "./kit";

// The pre-roll a fresh dye buffer runs so the stage opens with plumes already drifting: steps, step
// length in seconds, and the resting level and swell it runs on.
const PREROLL_STEPS = 240;
const PREROLL_DT = 1 / 20;
const PREROLL_LEVEL = 0.4;
const PREROLL_SWELL = 0.2;
// The longest advection step, so a stalled frame never tears the plumes.
const MAX_STEP = 1 / 20;

const ADVECT_FS = `${FLUID_PRELUDE}
uniform sampler2D uPrev;
uniform vec2 uTexSize;
uniform float uScale;
uniform float uDt;
uniform float uPush;
uniform float uInject;
vec2 velocity(vec2 P) {
  vec2 q = coverQ(P);
  vec2 nq = q * 0.95 + vec2(uFlow * 0.045, -uFlow * 0.03);
  float e = 0.03;
  float n0 = fbm(nq), nx = fbm(nq + vec2(e, 0.0)), ny = fbm(nq + vec2(0.0, e));
  vec2 curl = vec2(ny - n0, n0 - nx) / e;
  float d = length(q);
  vec2 dir = q / max(d, 1e-3);
  float near = exp(-max(d - 0.55, 0.0) * 1.6);
  vec2 v = curl * 0.16 + dir * (0.07 + uPush * near);
  v += dir * rings(d, 0.75, 0.12);
  return v * uCover.z;
}
void main() {
  vec2 P = gl_FragCoord.xy * uScale;
  vec2 back = (P - velocity(P) * uDt) / uScale / uTexSize;
  float inside = step(0.0, back.x) * step(back.x, 1.0) * step(0.0, back.y) * step(back.y, 1.0);
  vec4 dye = texture(uPrev, back) * inside * exp(-uDt / 9.0);
  float sd = sdRound(P - coverCenter(), uCover.zw * 0.5, uRadius) / uCover.z;
  vec2 q = coverQ(P);
  vec2 dir = q / max(length(q), 1e-3);
  float rim = exp(-pow(max(sd, 0.0) / 0.05, 2.0)) * step(-0.01, sd);
  float spot = smoothstep(0.38, 0.75, vnoise(dir * 2.6 + vec2(uFlow * 0.07, 3.0 - uFlow * 0.05)));
  float amt = uInject * uDt * rim * spot;
  vec2 cuv = clamp((P - uCover.xy) / uCover.zw, 0.03, 0.97);
  dye += vec4(textureLod(uCoverTex, cuv, 3.5).rgb * amt, amt);
  dye *= step(0.0, sd);
  outColor = min(dye, vec4(2.0));
}`;

const FS = `${FLUID_PRELUDE}
uniform sampler2D uDye;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 q = coverQ(fc);
  float d = length(q);
  vec2 dir = q / max(d, 1e-3);
  vec2 lens = dir * rings(d, 0.75, 0.1) * 0.035 * uCover.z;
  vec4 dye = texture(uDye, (fc - lens) / uRes);
  float h = hushAt(fc);
  float a = dye.a * (1.0 - 0.82 * h);
  vec3 hue = dye.rgb / max(dye.a, 1e-3);
  // The pigment is the hue at full strength, so a dark navy rim still inks blue rather than grey.
  vec3 pigment = clamp(hue / max(max(hue.r, max(hue.g, hue.b)), 0.05), 0.0, 1.0);
  pigment = clamp(mix(vec3(luma(pigment)), pigment, 1.15), 0.0, 1.0);
  float wash = exp(-d * 0.9);
  vec3 col;
  if (uLight > 0.5) {
    vec3 ground = mix(uGround, mix(uGround, pigment, 0.08), wash * 0.5);
    vec3 absorb = (1.0 - pigment) * 2.3 + 0.22;
    col = ground * exp(-absorb * a * (0.9 + 0.2 * uRms));
  } else {
    vec3 ground = uGround + pigment * 0.03 * wash;
    float glow = 1.0 - exp(-a * 2.0);
    col = ground + mix(hue, pigment, 0.75) * glow * (0.5 + 0.28 * uRms);
  }
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createInk(kit: Kit): Candidate {
  const { gl } = kit;
  const art = createCoverTexture(gl);
  const rings = createRings(2.2, 0.15, 0.55);
  // The dye ping-pong pair at half the stage size: the latest state first.
  let dye: [Target, Target] | null = null;
  let flow = 0;

  const freeDye = () => {
    if (!dye) return;
    kit.freeTarget(dye[0]);
    kit.freeTarget(dye[1]);
    dye = null;
  };

  const advect = (f: Frame, dt: number) => {
    if (!dye) return;
    const s = f.sig;
    flow += dt * (0.25 + s.level * 0.25 + s.midMotion * 0.5);
    const [src, dst] = dye;
    const p = kit.program("inkAdvect", FS_VS, ADVECT_FS);
    kit.bindTarget(dst);
    gl.disable(gl.BLEND);
    setFluid(kit, p, f, flow, rings.packed, art.tex);
    kit.bindTex(p, "uPrev", 1, src.tex);
    kit.set2(p, "uTexSize", dst.w, dst.h);
    kit.set1(p, "uScale", kit.size.w / dst.w);
    kit.set1(p, "uDt", dt);
    kit.set1(p, "uPush", Math.min(1, s.swell * 1.6) * 0.08 + s.bassMotion * 0.4);
    kit.set1(p, "uInject", 1.6 + s.level * 1.4);
    kit.drawQuad();
    dye = [dst, src];
  };

  // A new stage size or a new cover starts the dye over and pre-rolls it on a resting signal.
  const ensure = (f: Frame, newCover: boolean) => {
    const w = Math.max(1, kit.size.w >> 1);
    const h = Math.max(1, kit.size.h >> 1);
    if (dye && !newCover && dye[0].w === w && dye[0].h === h) return;
    freeDye();
    rings.clear();
    dye = [kit.makeTarget(w, h), kit.makeTarget(w, h)];
    const rest = {
      ...f,
      sig: { ...f.sig, bassMotion: 0, midMotion: 0, highMotion: 0, beat: 0, level: PREROLL_LEVEL, swell: PREROLL_SWELL },
    };
    for (let i = 0; i < PREROLL_STEPS; i++) advect(rest, PREROLL_DT);
  };

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
      const scene = kit.boundTarget();
      ensure(f, art.sync(f.cover));
      rings.step(f.dt, f.sig.beat);
      advect(f, Math.min(f.dt, MAX_STEP));
      if (!dye) return;
      kit.bindTarget(scene);
      const p = kit.program("ink", FS_VS, FS);
      setFluid(kit, p, f, flow, rings.packed, art.tex);
      kit.bindTex(p, "uDye", 1, dye[0].tex);
      kit.drawQuad();
    },
    dispose() {
      freeDye();
      art.dispose();
    },
  };
}
