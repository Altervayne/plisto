/*
 * Snowfall: a window onto a snowfall, the cover as the view outside, slightly out of focus. Big slow flakes
 * drift past in four depths, the nearest soft and large, the farthest small and crisp. A wooden frame, a
 * curtain in the cover's warm colour and a sill with a heap of snow make it a room looking out. Dark is a blue
 * night with the near flakes catching a warm lamp; light is a soft overcast.
 *
 * The bass envelope winds two opposite eddies into the flurry and they relax over about two seconds. A beat
 * raises a gust target that the flakes ease toward and away from, so nothing steps. The swell sets how many
 * cells hold a flake, fading in and out. The nearest flake radius is capped so none reads as a blob. The
 * sill snow starts exactly at the sill top at every stage size.
 *
 * Photosensitivity: brightness follows only the eased level (uRms). The gust, the eddies and the fall rate
 * move the flakes and never add light, and all of them are zero or slow under Calm.
 */

// -- Local Imports --
import { clamp01, COZY_PRELUDE } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** The eased motion of the flurry. */
export interface SnowState {
  fall: number;
  gust: number;
  target: number;
  rate: number;
  density: number;
  swirl: number;
}

/** A fresh flurry at rest. */
export function createSnowState(): SnowState {
  return { fall: 0, gust: 0, target: 0, rate: 1, density: 0.4, swirl: 0 };
}

/**
 * Advances the flurry by `dt` seconds. A beat raises the gust target, the gust eases toward it and the
 * target relaxes. The eddies wind up with the bass envelope over about 0.6 s and unwind over about 2 s;
 * Calm has no envelope, so no eddies.
 */
export function stepSnow(st: SnowState, s: VisualSignal, dt: number): void {
  const k = (tau: number) => 1 - Math.exp(-dt / tau);
  if (s.beat > 0) st.target += 9 * Math.min(1.5, s.beat);
  st.target *= Math.exp(-dt / 0.9);
  st.gust += (st.target - st.gust) * k(0.35);
  st.rate += (1 + 0.3 * s.level + 0.3 * s.midMotion - st.rate) * k(1.5);
  st.fall += dt * st.rate;
  const want = clamp01(0.28 + 0.55 * Math.min(1, s.swell * 1.6) + 0.18 * s.bassMotion);
  st.density += (want - st.density) * k(2.2);
  const wind = 1.5 * Math.min(1.6, s.bassMotion);
  st.swirl += (wind - st.swirl) * k(wind > st.swirl ? 0.6 : 2.0);
}

const FS = `${COZY_PRELUDE}
uniform float uFall;      // fall clock
uniform float uGust;      // wind offset, css px, from the beats
uniform float uDensity;   // 0..1, how many cells hold a flake
uniform float uSwirl;     // eddy strength, radians of turn at an eddy's heart, eased from the bass envelope
// -- Backdrop tunables (the scenery: the view outside, the frame, the curtain, the sill and its snow) --
const float FRAME = 16.0;       // window frame width, css px
const float SILL_TOP = 40.0;    // top edge of the sill, css px from the stage bottom
const float CURTAIN = 0.09;     // curtain width, share of the stage
const float VIEW_LOD = 2.6;     // how out of focus the outside is
const float OUT_GROUND = 0.22;  // where the snowy field meets the pines outside, share of the stage above the sill
const float CABIN_X = 0.19;     // the cabin across the field, share of the stage width
const float FENCE_END = 0.26;   // where the yard fence in front of the cabin ends, share of the stage width
const float OUT_SOFT = 3.0;     // edge softness of everything outside, css px (it is out of focus)
const float OUT_SCALE = 1.5;    // size of the pines, the cabin and the fence outside
// -- Effect tunables (the flakes) --
// Depth layers: cell, radius, softness, fall speed (px per fall second).
const vec4 L0 = vec4(40.0, 2.7, 0.5, 20.0);
const vec4 L1 = vec4(72.0, 5.6, 0.7, 32.0);
const vec4 L2 = vec4(132.0, 13.0, 0.9, 48.0);
const vec4 L3 = vec4(210.0, 15.0, 1.0, 66.0);   // the nearest layer: capped so no flake reads as a blob

// ===== BACKDROP: the scenery. =====
// Room lamp, low on the left: warms the frame, the curtain and the sill in the dark (and the near flakes).
float lampAt(vec2 p, vec2 sz) { return exp(-length((p - sz * vec2(0.08, 0.05)) / (sz.y * 0.9))); }
// The view outside, out of focus: the cover is the sky, its brightest part the one light (a low sun by day, the
// moon by night); below it a far wood, pines and a cabin on the rise, and a split-rail yard fence closer in.
vec3 view(vec2 p, vec2 sz, vec2 fc) {
  vec2 su = stageUv(fc);
  vec3 cv = mix(textureLod(uCoverTex, su, VIEW_LOD).rgb, textureLod(uCoverTex, su, VIEW_LOD + 1.8).rgb, 0.5);
  float halo = smoothstep(0.55, 0.9, luma(textureLod(uCoverTex, su, VIEW_LOD + 4.0).rgb));
  float hi = smoothstep(0.62, 0.92, luma(cv));
  float t = p.y / sz.y;
  bool day = uLight > 0.5;
  float s = OUT_SOFT;
  vec3 sky;
  if (day) {
    // A pale overcast: the cover comes through as a muted cast that thins out overhead, and only its brightest
    // part glows warm.
    vec3 base = mix(vec3(0.80, 0.83, 0.87), vec3(0.90, 0.91, 0.93), smoothstep(0.0, 1.0, t));
    sky = mix(base, mix(vec3(luma(cv)), cv, 0.3) * 1.08 + 0.12, 0.4 * (1.0 - 0.55 * smoothstep(0.45, 1.0, t)));
    sky = mix(sky, vec3(1.0, 0.95, 0.86), 0.45 * hi) + vec3(1.0, 0.86, 0.66) * 0.07 * halo;
  } else {
    // A blue night: the cover's brightest part becomes a soft moon in a halo, tinted by the sky around it.
    sky = mix(vec3(luma(cv)), cv, 0.85) * vec3(0.62, 0.74, 0.98) * (0.34 + 0.1 * uRms);
    vec3 moon = mix(sky * 2.2, vec3(0.78, 0.84, 0.98), 0.5);
    sky = mix(sky, moon * (0.8 + 0.2 * uRms), 0.6 * hi) + vec3(0.5, 0.6, 0.85) * 0.06 * halo;
  }
  vec3 snow = day ? vec3(0.93, 0.945, 0.97) : vec3(0.24, 0.3, 0.44) * (0.7 + 0.2 * uRms) + cv * 0.04;
  float sc = OUT_SCALE;
  float gy = SILL_TOP + (sz.y - SILL_TOP) * OUT_GROUND;
  // Distance: snowy hills, half lost in the falling snow, and a soft far wood along the rise.
  float hill = gy + 34.0 * sc + sz.y * 0.06 * vnoise(vec2(p.x * 0.0028, 2.0)) + 8.0 * vnoise(vec2(p.x * 0.009, 5.0));
  vec3 col = mix(sky, mix(sky, snow, 0.5), smoothstep(s, -s, p.y - hill));
  vec3 pineCol = day ? vec3(0.30, 0.38, 0.38) : vec3(0.025, 0.035, 0.065) * (0.8 + 0.25 * uRms);
  float woodTop = gy + (12.0 + 26.0 * smoothstep(0.3, 0.7, vnoise(vec2(p.x * 0.004, 6.0)))) * sc + 6.0 * vnoise(vec2(p.x * 0.04, 2.0));
  col = mix(col, mix(pineCol, sky, day ? 0.45 : 0.35), smoothstep(s, -s, p.y - woodTop));
  // Mid-ground: pines along the rise, tiered, in groves with gaps, dusted with snow.
  float pine = 0.0, pk = 0.0;
  float cell = 26.0 * sc;
  float cid = floor(p.x / cell);
  for (int i = -1; i <= 1; i++) {
    float id = cid + float(i);
    vec2 r = vec2(hash21(vec2(id, 2.2)), hash21(vec2(id, 6.1)));
    float grove = smoothstep(0.25, 0.6, vnoise(vec2(id * 0.21, 1.7)));
    float h = (44.0 + 60.0 * r.x) * sc * (0.4 + 0.6 * grove);
    float k = (p.y - gy + 4.0) / h;
    float halfW = h * 0.3 * (1.0 - k) * (1.0 - 0.22 * fract(k * 3.2));
    float m = smoothstep(s, -s, abs(p.x - (id + 0.5 + 0.5 * (r.y - 0.5)) * cell) - halfW) * step(0.1, grove + 0.25 * r.x);
    pk = m > pine ? k : pk;
    pine = max(pine, m);
  }
  pineCol = mix(pineCol, snow, 0.18 + 0.28 * (1.0 - fract(pk * 3.2)) * step(0.0, pk));
  col = mix(col, mix(pineCol, sky, day ? 0.16 : 0.08), pine);
  // The cabin on the rise: dark timber, a snow-laden roof, a chimney, two windows (lit at night, dim by day).
  float cs = 1.25 * sc;
  vec2 q = (p - vec2(sz.x * CABIN_X, gy - 6.0)) / cs;
  float body = smoothstep(s, -s, sdRound(q - vec2(0.0, 15.0), vec2(30.0, 15.0), 1.0) * cs);
  float roof = smoothstep(s, -s, (abs(q.x) - 38.0 * (1.0 - (q.y - 27.0) / 21.0)) * cs) * smoothstep(-s, s, (q.y - 26.0) * cs);
  float chim = smoothstep(s, -s, sdRound(q - vec2(16.0, 44.0), vec2(3.5, 9.0), 0.5) * cs);
  vec3 timber = day ? vec3(0.36, 0.28, 0.25) : vec3(0.035, 0.03, 0.04);
  col = mix(col, mix(timber, sky, day ? 0.12 : 0.05), max(body, chim));
  col = mix(col, mix(snow, sky, 0.06) * (0.9 + 0.1 * smoothstep(27.0, 46.0, q.y)), roof);
  vec2 w1 = q - vec2(-14.0, 14.0), w2 = q - vec2(6.0, 14.0);
  float win = smoothstep(s * 0.5, -s * 0.5, min(sdRound(w1, vec2(5.0, 6.0), 1.0), sdRound(w2, vec2(5.0, 6.0), 1.0)) * cs);
  vec3 warm = vec3(1.0, 0.72, 0.4);
  col = mix(col, day ? mix(timber, warm, 0.4) : warm, win * body);
  col += warm * (day ? 0.0 : 0.3) * (exp(-dot(w1, w1) / 260.0) + exp(-dot(w2, w2) / 260.0));
  // The field, reaching from the rise to the sill, with soft drifts; warm light from the cabin falls on it at night.
  float fieldTop = gy - 2.0 + 4.0 * vnoise(vec2(p.x * 0.01, 3.0));
  vec3 field = snow * (0.95 + 0.07 * vnoise(vec2(p.x * 0.004, p.y * 0.02)));
  field += warm * (day ? 0.0 : 0.09) * exp(-pow((p.x - sz.x * CABIN_X) / (60.0 * sc), 2.0) - pow((p.y - gy + 14.0) / 18.0, 2.0));
  col = mix(col, field, smoothstep(s, -s, p.y - fieldTop));
  // Foreground: a split-rail yard fence, half buried, ending on a corner post where it turns toward the window.
  float sp = 36.0 * sc;
  float fy = gy - 30.0 * sc;
  float fcell = floor(p.x / sp);
  float fx = p.x - (fcell + 0.5) * sp;
  float fenceEnd = floor(sz.x * FENCE_END / sp - 0.5) * sp + sp * 0.5;
  float has = step(fcell * sp + sp * 0.5, fenceEnd + 1.0);
  float postH = (15.0 + 3.0 * hash21(vec2(fcell, 4.0)) + 4.0 * step(fenceEnd - 1.0, fcell * sp + sp * 0.5)) * sc;
  float pw = 1.8 * sc;
  float post = smoothstep(s, -s, abs(fx + 0.05 * (p.y - fy)) - pw) * smoothstep(s, -s, p.y - fy - postH) * has;
  float cap = smoothstep(s, -s, length(vec2(fx + 0.05 * postH, p.y - fy - postH) / (vec2(3.4, 2.2) * sc)) - 1.0) * has;
  float sag = sin(fract(p.x / sp + 0.5) * 3.1416) * sc;
  float run = smoothstep(fenceEnd + 2.5, fenceEnd + 1.0, p.x);
  float rail = max(smoothstep(s * 0.6, -s * 0.6, abs(p.y - fy - 12.0 * sc + sag) - sc), smoothstep(s * 0.6, -s * 0.6, abs(p.y - fy - 6.0 * sc + sag) - sc)) * run;
  // The return: two rails from the corner post toward the window, to one nearer, taller post.
  vec2 rp = vec2(fenceEnd - 16.0 * sc, fy - 13.0 * sc);
  float rH = 26.0 * sc;
  vec2 ra = p - vec2(fenceEnd, fy + 12.0 * sc), rb = rp + vec2(0.0, rH * 0.78) - vec2(fenceEnd, fy + 12.0 * sc);
  vec2 ra2 = p - vec2(fenceEnd, fy + 6.0 * sc), rb2 = rp + vec2(0.0, rH * 0.45) - vec2(fenceEnd, fy + 6.0 * sc);
  float seg = min(length(ra - rb * clamp(dot(ra, rb) / dot(rb, rb), 0.0, 1.0)), length(ra2 - rb2 * clamp(dot(ra2, rb2) / dot(rb2, rb2), 0.0, 1.0)));
  rail = max(rail, smoothstep(s * 0.6, -s * 0.6, seg - 1.2 * sc));
  post = max(post, smoothstep(s, -s, abs(p.x - rp.x) - pw * 1.2) * smoothstep(s, -s, p.y - rp.y - rH));
  cap = max(cap, smoothstep(s, -s, length((p - rp - vec2(0.0, rH)) / (vec2(4.0, 2.6) * sc)) - 1.0));
  vec3 wood = day ? vec3(0.38, 0.33, 0.31) : vec3(0.04, 0.04, 0.06);
  col = mix(col, mix(wood, sky, day ? 0.12 : 0.05), max(post, rail * 0.95));
  col = mix(col, mix(snow * 1.04, sky, 0.04), cap);
  // The snow the fence stands in: its line dips to bury the nearer post's foot.
  float drift = fy + 1.0 + 4.0 * vnoise(vec2(p.x * 0.015, 7.0));
  drift = mix(drift, rp.y + 1.5 + 2.0 * vnoise(vec2(p.x * 0.03, 2.0)), exp(-pow((p.x - rp.x) / (9.0 * sc), 2.0)));
  return mix(col, field, smoothstep(s, -s, p.y - drift));
}
// The room around the view: frost on the pane, the frame, the sill and its snow, the curtain on its rod.
vec3 furniture(vec3 col, vec2 p, vec2 sz) {
  float lit = uLight > 0.5 ? 1.0 : 0.0;
  float lamp = lampAt(p, sz);
  // Pane: a faint inner shade at the frame, and frost creeping in from the corners.
  float inner = min(min(p.x - FRAME, sz.x - FRAME - p.x), sz.y - FRAME - p.y);
  col *= 1.0 - 0.28 * smoothstep(34.0, 0.0, inner) * (1.0 - 0.4 * lit);
  vec2 e = vec2(min(p.x - FRAME, sz.x - FRAME - p.x), min(p.y - SILL_TOP, sz.y - FRAME - p.y));
  float corner = length(max(vec2(80.0) - e, 0.0)) / 80.0;
  float frost = smoothstep(0.72, 1.3, corner + 0.4 * (fbm(p * 0.05) - 0.5)) * (0.75 + 0.25 * vnoise(p * 0.35));
  vec3 frostCol = lit > 0.5 ? vec3(0.97, 0.98, 1.0) : mix(vec3(0.5, 0.58, 0.72), vec3(1.0, 0.86, 0.66), 0.5 * lamp) * (0.4 + 0.15 * uRms);
  col = mix(col, frostCol, frost * (lit > 0.5 ? 0.6 : 0.5));
  // Frame: wood, its inner edge bevelled toward the light.
  float fd = min(min(p.x, sz.x - p.x), sz.y - p.y);
  float frame = smoothstep(FRAME, FRAME - 1.5, fd);
  vec3 wood = lit > 0.5 ? vec3(0.93, 0.92, 0.9) : vec3(0.075, 0.05, 0.036) + vec3(0.5, 0.3, 0.14) * 0.14 * lamp;
  bool side = min(p.x, sz.x - p.x) < sz.y - p.y;
  wood *= 0.92 + 0.1 * vnoise(side ? vec2(p.x * 0.2, p.y * 0.01) : vec2(p.y * 0.2, p.x * 0.01));
  wood *= 1.0 + (lit > 0.5 ? 0.04 : 0.25) * smoothstep(FRAME - 5.0, FRAME - 1.5, fd) - 0.12 * smoothstep(4.0, 0.0, fd);
  col = mix(col, wood, frame);
  // The sill: a front face under a lit lip.
  float sill = smoothstep(SILL_TOP + 0.5, SILL_TOP - 0.5, p.y);
  vec3 sillWood = lit > 0.5 ? vec3(0.88, 0.85, 0.80) : vec3(0.09, 0.062, 0.045) + vec3(0.5, 0.3, 0.14) * 0.2 * lamp;
  sillWood *= 0.8 + 0.2 * smoothstep(0.0, SILL_TOP, p.y);
  sillWood *= 1.0 + (lit > 0.5 ? 0.05 : 0.3) * smoothstep(SILL_TOP - 6.0, SILL_TOP - 4.0, p.y) - 0.25 * smoothstep(3.0, 0.0, abs(p.y - SILL_TOP + 7.0));
  col = mix(col, sillWood, sill);
  // The snow settled on the sill: the heap starts exactly at SILL_TOP, drifts up against the frame at both ends,
  // lit on top and shaded underneath.
  float heap = SILL_TOP + 8.0 + 9.0 * fbm(vec2(p.x * 0.007, 3.0)) + 2.0 * vnoise(vec2(p.x * 0.025, 1.0))
             + 15.0 * exp(-max(p.x - FRAME, 0.0) / 45.0) + 13.0 * exp(-max(sz.x - FRAME - p.x, 0.0) / 45.0);
  float snow = smoothstep(heap, heap - 1.5, p.y) * smoothstep(SILL_TOP - 0.5, SILL_TOP + 0.5, p.y);
  float sh = clamp((p.y - SILL_TOP) / max(heap - SILL_TOP, 1.0), 0.0, 1.0);
  vec3 snowCol = lit > 0.5 ? mix(vec3(0.84, 0.88, 0.95), vec3(0.98, 0.985, 1.0), smoothstep(0.0, 0.7, sh))
                           : mix(vec3(0.5, 0.58, 0.72), vec3(1.0, 0.86, 0.66), 0.55 * lamp) * (0.42 + 0.12 * uRms) * (0.62 + 0.45 * smoothstep(0.0, 0.85, sh));
  vec2 gc = floor(p / 6.0);
  float glint = step(0.93, hash21(gc)) * smoothstep(1.1, 0.3, length(p - (gc + 0.3 + 0.4 * vec2(hash21(gc + 1.3), hash21(gc + 2.9))) * 6.0)) * smoothstep(0.4, 0.9, sh);
  snowCol += glint * (lit > 0.5 ? 0.0 : 0.25 * (0.4 + lamp));
  col = mix(col, snowCol, snow);
  // Curtain on the left, in the cover's warm colour, nearest the room: gathered by a tie-back, falling to the floor,
  // its folds following the drape. It casts a soft shadow on the glass beside it.
  float tieY = sz.y * 0.42;
  float tie = exp(-pow((p.y - tieY) / (sz.y * 0.16), 2.0));
  float below = smoothstep(tieY, 0.0, p.y);
  float cw = sz.x * CURTAIN * (1.0 - 0.32 * tie) + 22.0 * below * below + sin(p.y * 0.011 + 1.0) * 4.0 * (1.0 - tie);
  col *= 1.0 - (lit > 0.5 ? 0.1 : 0.3) * smoothstep(cw + 34.0, cw, p.x);
  float curt = smoothstep(cw + 1.5, cw - 1.5, p.x);
  float fu = p.x / cw;
  float f = 0.5 + 0.5 * sin(fu * 6.2831 * 4.0 + 1.3 * sin(fu * 7.0 + 1.3) + 0.5 * sin(fu * 13.0 + p.y * 0.004));
  float folds = pow(f, 0.6) * (1.0 - 0.4 * smoothstep(5.0, 0.0, cw - p.x)) + 0.25 * smoothstep(10.0, 4.0, cw - p.x) * smoothstep(0.0, 3.0, cw - p.x);
  vec3 cloth = lit > 0.5 ? mix(vec3(0.95, 0.91, 0.86), uPal[0], 0.22) * (0.8 + 0.24 * folds) * (0.88 + 0.14 * clamp(fu, 0.0, 1.0)) : uPal[0] * (0.08 + 0.15 * folds) * (0.5 + 0.7 * lamp);
  float band = smoothstep(7.0, 5.5, abs(p.y - tieY)) * curt;
  vec3 bandCol = lit > 0.5 ? mix(vec3(0.85, 0.78, 0.7), uPal[0], 0.35) : uPal[0] * 0.22 * (0.5 + 0.7 * lamp) + vec3(0.03, 0.02, 0.01);
  cloth = mix(cloth, bandCol * (0.9 + 0.15 * smoothstep(-6.0, 6.0, p.y - tieY)), band);
  col = mix(col, cloth, curt);
  // The rod it hangs from, across the top of the frame, a ball at its end.
  float rodEnd = sz.x * CURTAIN + 34.0;
  float rodY = sz.y - FRAME * 0.55;
  float rod = smoothstep(2.2, 1.2, abs(p.y - rodY)) * step(p.x, rodEnd);
  float ball = smoothstep(5.0, 4.0, length(p - vec2(rodEnd, rodY)));
  vec3 brass = lit > 0.5 ? vec3(0.42, 0.37, 0.33) : vec3(0.12, 0.08, 0.05) + vec3(0.6, 0.4, 0.2) * 0.25 * lamp;
  brass *= 1.0 + 0.35 * smoothstep(0.0, 1.5, p.y - rodY + 0.5) * (1.0 - ball * 0.0);
  col = mix(col, brass, max(rod, ball));
  return col;
}
vec3 backdrop(vec2 p, vec2 sz, vec2 fc) { return furniture(view(p, sz, fc), p, sz); }

// ===== EFFECTS: the flakes, layered between the view and the room. =====
// The bass eddies: two slow whirls turning opposite ways, set in main(). twistAt() is the turn at a point, in
// radians, strongest at an eddy's heart and zero midway between them; swirl() turns a point about the nearer eddy.
vec2 gE1, gE2;
float gEr;
float twistAt(vec2 p) {
  return uSwirl * (exp(-dot(p - gE1, p - gE1) / (gEr * gEr)) - exp(-dot(p - gE2, p - gE2) / (gEr * gEr)));
}
vec2 swirl(vec2 p, float a) {
  vec2 c = dot(p - gE1, p - gE1) < dot(p - gE2, p - gE2) ? gE1 : gE2;
  float cs = cos(a), sn = sin(a);
  vec2 d = p - c;
  return c + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
}
// One layer of flakes: rgb is the flake colour weight, a its coverage. The flakes fall straight in a space turned by
// the eddies (tw scales the turn for this depth), so on screen their paths curl around them; each flake is found
// through the turn but drawn round at its own turned-back centre, so none is smeared.
vec4 layer(vec2 p, vec4 spec, float wind, float seed, float share, float tw) {
  float cell = spec.x;
  vec2 drift = vec2(uGust * wind, uFall * spec.w);
  vec2 q = swirl(p, tw * twistAt(p)) + drift;
  vec2 id = floor(q / cell);
  vec3 r = vec3(hash21(id + seed), hash21(id + seed + 5.1), hash21(id + seed + 9.3));
  float on = smoothstep(r.x, r.x - 0.12, share);
  float ph = r.y * 6.2831;
  vec2 c = (id + 0.3 + 0.4 * r.yz) * cell;
  c.x += sin(uTime * (0.35 + 0.3 * r.z) + ph) * cell * 0.09;
  c.y += sin(uTime * (0.5 + 0.3 * r.y) + ph * 1.7) * cell * 0.04;
  vec2 cs = c - drift;
  vec2 cp = swirl(cs, -tw * twistAt(cs));
  float rad = spec.y * (0.7 + 0.6 * r.z);
  float d = length(p - cp) / rad;
  float a = (1.0 - smoothstep(1.0 - spec.z, 1.0, d)) * on;
  float core = (1.0 - smoothstep(0.0, 0.6, d)) * on;
  return vec4(core, a * (0.75 + 0.25 * r.z), r.y, 0.0);
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, sz = uRes / uDpr;
  float hu = hushAt(fc);
  float lit = uLight > 0.5 ? 1.0 : 0.0;
  vec3 col = view(p, sz, fc);
  float lamp = lampAt(p, sz);
  // Flakes, far to near. Each adds over the view, behind the frame, the curtain and the sill.
  // Two slow eddies, turning opposite ways, pull the flurry around with the bass; the nearer flakes turn most.
  gE1 = sz * vec2(0.3 + 0.04 * sin(uTime * 0.05), 0.58);
  gE2 = sz * vec2(0.72, 0.4 + 0.04 * sin(uTime * 0.04 + 1.0));
  gEr = 0.26 * sz.y;
  vec4 f0 = layer(p, L0, 0.35, 1.0, 0.5 + 0.35 * uDensity, 0.5);
  vec4 f1 = layer(p, L1, 0.6, 3.0, 0.42 + 0.34 * uDensity, 0.7);
  vec4 f2 = layer(p, L2, 0.9, 7.0, 0.30 + 0.28 * uDensity, 0.9);
  vec4 f3 = layer(p, L3, 1.2, 11.0, 0.22 + 0.2 * uDensity, 1.0);
  float calm = 1.0 - 0.85 * hu;
  vec3 coolFlake = uLight > 0.5 ? vec3(1.0) : vec3(0.66, 0.78, 1.0) * (0.55 + 0.4 * uRms);
  vec3 warmFlake = uLight > 0.5 ? vec3(1.0) : mix(vec3(1.0, 0.84, 0.58), vec3(0.8, 0.88, 1.0), 0.35) * (0.8 + 0.4 * uRms);
  float wl = clamp(0.55 + lamp * 0.9, 0.0, 1.0);
  col = mix(col, coolFlake, f0.y * 0.6 * calm);
  col = mix(col, coolFlake, f1.y * 0.62 * calm);
  col = mix(col, mix(coolFlake, warmFlake, wl), (f2.y * 0.55 + f2.x * 0.2) * calm);
  col = mix(col, mix(coolFlake, warmFlake, wl), (f3.y * 0.62 + f3.x * 0.14) * calm);
  if (lit > 0.5) col *= 1.0 - 0.06 * (f2.y + f3.y) * (1.0 - f2.x - f3.x);
  col = furniture(col, p, sz);
  col = mix(col, uGround, hu * (lit > 0.5 ? 0.4 : 0.5));
  outColor = vec4(settle(col, fc), 1.0);
}`;

export function createSnowfall(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const st = createSnowState();

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
      stepSnow(st, f.sig, f.dt);
      const p = kit.program("snowfall", FS_VS, FS);
      setFluid(kit, p, f, st.fall, null, art.tex);
      kit.set1(p, "uFall", st.fall);
      kit.set1(p, "uGust", st.gust);
      kit.set1(p, "uDensity", st.density);
      kit.set1(p, "uSwirl", st.swirl);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
