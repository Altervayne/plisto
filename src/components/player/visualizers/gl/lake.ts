/*
 * Lake: a moonlit lake, or a pale daytime moon by day. A moon with a halo hangs over layered hills; the
 * cover tints the hills and is mirrored in the water with the ranges, where a glittering moon path runs
 * toward the viewer. Spruces, reeds and rocks frame the bank at the bottom left. Two layers of clouds drift
 * across and dim the moon as they pass, and stars twinkle in the clear dark. The eased level sets the
 * moonlight strength, eased again over about two seconds; the mids drift the clouds and the ripple. The
 * highs, eased up over 0.25 s and down over 0.8 s, widen the moon path by up to 40% and seed more sparkles
 * that twinkle faster, each dimmer as they multiply. A strong beat sends a faint ring across the water that
 * bends the reflections, and any beat nudges the clouds a few pixels. The glitter fades out above the seek
 * row and stays off the land.
 *
 * Photosensitivity: brightness follows only the eased level. The path keeps its total light as the
 * sparkles multiply, and the rings and the nudge move or bend the scene without adding light.
 */

// -- Local Imports --
import { COZY_PRELUDE, clamp01 } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { createRings, setFluid } from "./fluid";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

// Strong-beat rings: life and fade-in in seconds, and height per unit of beat.
const RING_LIFE = 4.5;
const RING_RISE = 0.4;
const RING_HEIGHT = 1;
// The beat strength that sends a ring across the water.
const RING_MIN_BEAT = 0.7;
// Time constants of the highs envelope (up, down) and of the moonlight strength, in seconds.
const HIGH_UP_TAU = 0.25;
const HIGH_DOWN_TAU = 0.8;
const MOON_TAU = 2.2;
// Time constants of the mid speed easing and of the cloud nudge gliding to its target, in seconds.
const MID_TAU = 0.5;
const NUDGE_TAU = 0.12;

const FS = `${COZY_PRELUDE}
uniform float uMoon;
uniform float uCloudT;
uniform float uNudge;
uniform float uWave;
uniform float uSparkle;               // the eased highs envelope, 0..1
uniform float uGlitT;              // glitter twinkle phase, quicker with the highs
// -- Backdrop tunables (the scenery; the cloud and glitter effects are separate) --
const vec2 MOON_AT = vec2(0.125, 0.80); // stage fractions
const float HORIZON = 0.27;        // shoreline of the far water, in stage heights
const float MOON_PX = 34.0;        // moon radius, CSS px
const float HALO_PX = 300.0;
const float RING_PX = 190.0;
const float PATH_W = 16.0;         // moon path half width at the horizon, CSS px
const float PATH_SPREAD = 110.0;   // widening toward the viewer
const float BANK_X = 0.30;         // where the near bank at the left runs into the water, stage fractions
const float BANK_Y = 0.06;         // bank height at the left edge, in stage heights
const float PINE_X = 0.24;         // share of the bank, from the left, holding the tall spruces
const float PINE_CELL = 30.0;      // pine spacing on the bank, CSS px
const float STAR_CELL = 46.0;
const vec2 LAKE_RING_AT = vec2(0.45, 0.20); // where beat rings start on the water, stage fractions
const float LAKE_RING = 0.40;      // how strongly a ring (a crest and a trough) bends the reflections
const vec3 MOON_TINT = vec3(0.78, 0.90, 1.12);
// One mountain: a slightly rounded summit over concave flanks.
// A smooth blur of the cover: nine taps one texel apart at the given mip, so the bilinear steps of a small
// bitmap never show as blocks.
vec3 coverBlur(vec2 uv, float lod) {
  vec2 o = exp2(lod) / vec2(textureSize(uCoverTex, 0));
  vec3 c = textureLod(uCoverTex, uv, lod).rgb * 4.0;
  c += (textureLod(uCoverTex, uv + vec2(o.x, 0.0), lod).rgb + textureLod(uCoverTex, uv - vec2(o.x, 0.0), lod).rgb
      + textureLod(uCoverTex, uv + vec2(0.0, o.y), lod).rgb + textureLod(uCoverTex, uv - vec2(0.0, o.y), lod).rgb) * 2.0;
  c += textureLod(uCoverTex, uv + o, lod).rgb + textureLod(uCoverTex, uv - o, lod).rgb
     + textureLod(uCoverTex, uv + vec2(o.x, -o.y), lod).rgb + textureLod(uCoverTex, uv + vec2(-o.x, o.y), lod).rgb;
  return c / 16.0;
}
float peak(float x, float c, float w, float h) {
  float e = sqrt((x - c) * (x - c) + 0.0004);
  return h * exp(-pow(e / w, 1.5) + pow(0.02 / w, 1.5));
}
// The far range: a peak under the moon at the left and a pair at the right, low in the middle where the cover
// sits, so the horizon reads on both sides of the tile.
float farRange(float x) {
  float m = peak(x, 0.05, 0.11, 0.15) + peak(x, 0.64, 0.09, 0.12) + peak(x, 0.86, 0.10, 0.09);
  return HORIZON + 0.03 + m + 0.04 * (fbm(vec2(x * 14.0, 3.0)) - 0.45) + 0.006 * vnoise(vec2(x * 70.0, 1.0));
}
// The near hills: low wooded humps along the far shore.
float nearRange(float x) {
  float m = 0.055 * exp(-pow((x - 0.22) / 0.08, 2.0)) + 0.045 * exp(-pow((x - 0.50) / 0.07, 2.0)) + 0.07 * exp(-pow((x - 1.0) / 0.12, 2.0));
  return HORIZON + 0.008 + m + 0.012 * (vnoise(vec2(x * 18.0, 9.0)) - 0.5);
}
// The near bank's top edge at x, in CSS px: highest at the left edge, running down into the water at BANK_X.
float bankTop(float x, vec2 sz) {
  float u = x / (BANK_X * sz.x);
  return BANK_Y * sz.y * (1.0 - u * u) + 5.0 * (vnoise(vec2(x * 0.03, 5.0)) - 0.5);
}
// A rock seen from the side: rounded on top, flatter below. Returns the mask in x and its moonlit top in y.
vec2 rock(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  q.y *= q.y < 0.0 ? 1.8 : 1.0;
  float m = 1.0 - smoothstep(1.0 - 1.2 / r.x, 1.0 + 1.2 / r.x, length(q));
  return vec2(m, m * smoothstep(0.1, 0.9, dot(normalize(q + 1e-3), vec2(-0.45, 0.89))));
}
// The near shore at the bottom left: a grassy bank sloping into the water, spruces on it, rocks at its foot and
// reeds where it meets the water. Returns the silhouette in x, the lit water line along its edge in y, the rocks
// in z and their lit tops in w. The water line in y also carries the moonlit left edges of the spruces.
vec4 shore(vec2 p, vec2 sz) {
  vec4 s = vec4(0.0);
  float rim = 0.0;
  float reach = BANK_X * sz.x;
  if (p.x > reach * 1.1 || p.y > sz.y * 0.40) return s;
  float top = bankTop(p.x, sz) + 2.5 * (vnoise(vec2(p.x * 0.45, 1.0)) - 0.3);
  s.x = 1.0 - smoothstep(top - 0.7, top + 0.7, p.y);
  s.y = exp(-pow((p.y - top - 1.6) / 1.4, 2.0)) * smoothstep(reach * 1.02, reach * 0.6, p.x);
  // Spruces: tiers of drooping branches, widest at the foot of each tier, tapering to a fine tip.
  // Tall ones at the left edge frame the moon path; one young tree stands further along the bank.
  float cell = floor(p.x / PINE_CELL);
  for (int i = -2; i <= 2; i++) {
    float c = cell + float(i);
    vec3 r = vec3(hash21(vec2(c, 6.0)), hash21(vec2(c, 2.0)), hash21(vec2(c, 4.0)));
    float xc = (c + 0.3 + 0.4 * r.x) * PINE_CELL;
    float u = xc / reach;
    bool young = u > 0.42 && u < 0.62 && r.z > 0.45;
    if (xc < -PINE_CELL || (u > PINE_X && !young)) continue;
    float tall = sz.y * (young ? 0.06 + 0.03 * r.y : 0.26 + 0.16 * r.y * (1.0 - u / PINE_X));
    float t = (p.y - bankTop(xc, sz) + 4.0) / tall;
    if (t < 0.0 || t > 1.0) continue;
    float tiers = 7.0 + 4.0 * r.y;
    float k = fract(t * tiers + r.x);
    float jag = hash21(vec2(c, floor(t * tiers + r.x) + step(xc, p.x) * 50.0));
    float w = tall * 0.19 * (1.0 - t) * (0.42 + 0.58 * pow(1.0 - k, 1.6)) * (0.80 + 0.35 * jag);
    w = t < 0.05 ? 1.5 + tall * 0.006 : w;
    float dx = p.x - xc;
    float m = 1.0 - smoothstep(w - 0.7, w + 0.7, abs(dx));
    s.x = max(s.x, m);
    rim = max(rim, m * smoothstep(w - 3.0, w - 0.8, -dx) * step(0.05, t));
  }
  // Clumps of reeds where the bank runs low, some carrying a seed head.
  float rc = floor(p.x / 3.0);
  vec3 rr = vec3(hash21(vec2(rc, 31.0)), hash21(vec2(rc, 32.0)), hash21(vec2(rc, 33.0)));
  float ru = (rc + 0.5) * 3.0 / reach;
  if (rr.x < 0.85 * smoothstep(0.40, 0.65, vnoise(vec2(rc * 0.18, 4.0))) && ru > 0.50 && ru < 0.97) {
    float base = bankTop((rc + 0.5) * 3.0, sz) - 2.0;
    float rh = (8.0 + 24.0 * rr.y) * (1.2 - 0.6 * ru);
    float t = (p.y - base) / rh;
    float rx = (rc + 0.5) * 3.0 + (rr.z - 0.5) * 3.2 * t * t;
    float reed = (1.0 - smoothstep(0.3, 0.9, abs(p.x - rx) / (1.0 - 0.7 * clamp(t, 0.0, 1.0)))) * step(0.0, t) * step(t, 1.0);
    float head = step(0.7, rr.z) * (1.0 - smoothstep(0.8, 1.1, length(vec2(p.x - rx, p.y - base - rh * 0.78) / vec2(1.4, rh * 0.10))));
    s.x = max(s.x, max(reed, head));
  }
  // Three rocks at the foot of the bank, half in the water.
  float r0 = reach * 0.80, r1 = reach * 0.90, r2 = reach * 0.985;
  vec2 k0 = rock(p, vec2(r0, bankTop(r0, sz) + 2.0), vec2(16.0, 10.0));
  vec2 k1 = rock(p, vec2(r1, bankTop(r1, sz) + 1.0), vec2(10.0, 7.0));
  vec2 k2 = rock(p, vec2(r2, max(bankTop(r2, sz), 0.0) + 1.0), vec2(7.0, 5.0));
  s.zw = max(max(k0, k1), k2);
  s.y = max(s.y * (1.0 - s.x), rim * 0.6) * (1.0 - s.z);
  return s;
}
// The ripple of the water, plus the faint rings a strong beat sends across the lake, seen in perspective from
// a point mid-lake.
float waterWave(vec2 p) {
  vec2 c = LAKE_RING_AT * uRes / uDpr;
  float d = length(vec2(p.x - c.x, (p.y - c.y) * 3.2));
  float ring = rings(d - 3.0, 120.0, 9.0) - rings(d + 3.0, 120.0, 9.0);
  return fbm(vec2(p.x * 0.012, p.y * 0.14 + uWave)) - 0.5 + LAKE_RING * ring;
}
// The moon path as a smooth glow, on the water only, fading out above the seek row and gentler near the
// viewer; spread widens it (the glitter uses it for the highs); the glitter on it is an effect and follows it.
float pathGlow(vec2 p, vec2 mp, float depth, float wv, float spread) {
  float pw = (PATH_W + PATH_SPREAD * depth) * spread;
  vec4 sh = shore(p, uRes / uDpr);
  float yF = uFloor / uDpr;
  float keep = smoothstep(yF + 5.0, yF + 90.0, p.y) * (1.0 - 0.35 * depth);
  return exp(-pow((p.x - mp.x + wv * 60.0 * depth) / pw, 2.0)) * (1.0 - max(sh.x, sh.z)) * keep;
}
// The scenery: sky, moon, stars, a far range and near hills with mist at their feet, the lake mirroring the
// cover and the ranges, and the near shore. solid returns how much of the pixel is land or water, so the
// clouds can stay in the sky.
vec3 backdrop(vec2 fc, vec2 p, vec2 sz, vec2 su, float hu, out float solid) {
  vec2 mp = MOON_AT * sz;
  float dm = length(p - mp);
  float strength = 0.35 + 0.65 * uMoon;
  float sky = smoothstep(HORIZON - 0.02, HORIZON + 0.06, su.y);
  vec2 mq = (p - mp) / MOON_PX;
  float maria = smoothstep(0.45, 0.70, fbm(mq * 1.7 + 2.0));
  float disc = (1.0 - smoothstep(MOON_PX - 1.5, MOON_PX + 1.0, dm)) * (1.0 - 0.85 * hu);
  float halo = exp(-pow(dm / HALO_PX, 2.0)) * (1.0 - 0.6 * hu);
  float ring = exp(-pow((dm - RING_PX) / 16.0, 2.0)) * (1.0 - 0.7 * hu);
  vec3 view = coverBlur(stageUv(fc), 4.0);
  float above = step(HORIZON, su.y);
  float r1 = farRange(su.x), r2 = nearRange(su.x);
  float hill1 = smoothstep(r1 + 0.0025, r1 - 0.0025, su.y) * above;
  float hill2 = smoothstep(r2 + 0.0025, r2 - 0.0025, su.y) * above;
  float rim1 = exp(-pow((su.y - r1) * sz.y / 2.0, 2.0)) * above;
  float rim2 = exp(-pow((su.y - r2) * sz.y / 1.6, 2.0)) * above;
  float mist = exp(-max(su.y - HORIZON, 0.0) / 0.03) * above;
  float moonSide = exp(-pow((su.x - MOON_AT.x) / 0.35, 2.0));
  float depth = clamp((HORIZON - su.y) / HORIZON, 0.0, 1.0);
  float wv = waterWave(p);
  vec2 fcm = vec2(fc.x + wv * 0.05 * uRes.x * (0.3 + depth), uRes.y * 2.0 * HORIZON - fc.y);
  vec3 mirror = coverBlur(stageUv(fcm), 4.5);
  // The ranges mirrored upside down in the lake, broken a little by the ripple.
  float sy = 2.0 * HORIZON - su.y + wv * 0.008 * (0.3 + depth);
  float ref1 = smoothstep(r1 + 0.006, r1 - 0.006, sy) * (1.0 - above);
  float ref2 = smoothstep(r2 + 0.005, r2 - 0.005, sy) * (1.0 - above);
  float pathX = pathGlow(p, mp, depth, wv, 1.0);
  vec4 sh = shore(p, sz);
  // The bank itself (below its top edge, under the trees): lighter toward its crest, with a rim along the edge.
  float bt = p.x < BANK_X * sz.x * 1.1 ? bankTop(p.x, sz) : -100.0;
  float bankBody = sh.x * (1.0 - smoothstep(bt - 0.5, bt + 1.5, p.y));
  float bankLift = smoothstep(bt - 45.0, bt, p.y) * bankBody;
  float bankRim = exp(-pow((bt - p.y - 1.5) / 1.6, 2.0)) * bankBody;
  solid = max(max(hill1, hill2), max(max(sh.x, sh.z), 1.0 - sky));
  vec3 col;
  if (uLight > 0.5) {
    vec3 skyL = mix(vec3(0.86, 0.92, 0.98), vec3(0.58, 0.76, 0.95), smoothstep(HORIZON, 1.0, su.y));
    vec3 viewC = view / max(luma(view), 0.05) * mix(luma(view), 0.55, 0.88);
    col = mix(skyL, viewC, 0.28);
    col = mix(col, vec3(0.97, 0.98, 1.0), 0.30 * halo * (0.45 + 0.55 * uMoon));
    vec3 moonL = mix(vec3(0.97, 0.98, 1.0), vec3(0.79, 0.85, 0.93), maria * 0.6 + 0.2 * dot(mq, mq));
    col = mix(col, moonL, disc * (0.80 + 0.18 * uMoon));
    vec3 water = mix(vec3(0.62, 0.80, 0.90), vec3(0.34, 0.58, 0.70), depth);
    water = mix(water, mirror / max(luma(mirror), 0.05) * mix(luma(mirror), 0.50, 0.88) * vec3(0.85, 1.0, 1.05), 0.38);
    water = mix(water, vec3(0.50, 0.62, 0.72), ref1 * 0.45);
    water = mix(water, vec3(0.30, 0.46, 0.48), ref2 * 0.55);
    water += vec3(1.0, 0.98, 0.92) * (0.18 + 0.30 * exp(-depth * 4.0)) * pathX * (1.0 - 0.8 * hu) * (0.5 + 0.5 * uMoon);
    water *= 1.0 + 0.05 * wv * (1.0 - hu);
    col = mix(col, water, 1.0 - sky);
    vec3 farL = mix(vec3(0.635, 0.725, 0.855), view * 0.8, 0.20);
    farL = mix(farL, vec3(0.86, 0.92, 0.97), mist * 0.65);
    col = mix(col, farL + vec3(1.0, 0.97, 0.88) * 0.08 * rim1 * (0.3 + moonSide), hill1);
    vec3 nearL = mix(mix(vec3(0.36, 0.54, 0.53), view * 0.7, 0.22), vec3(0.78, 0.87, 0.91), mist * 0.55);
    col = mix(col, nearL + vec3(1.0, 0.97, 0.88) * 0.08 * rim2, hill2);
    vec3 bankL = vec3(0.12, 0.22, 0.20) + vec3(0.09, 0.12, 0.07) * bankLift + vec3(0.30, 0.36, 0.30) * bankRim;
    col = mix(col, bankL, sh.x * (1.0 - 0.5 * hu));
    col += vec3(0.85, 0.95, 0.95) * 0.22 * sh.y * (1.0 - hu);
    col = mix(col, mix(vec3(0.34, 0.40, 0.42), vec3(0.78, 0.82, 0.84), sh.w), sh.z * (1.0 - 0.5 * hu));
    col = mix(col, uGround, hu * 0.3);
  } else {
    vec3 skyD = mix(vec3(0.012, 0.020, 0.050), vec3(0.030, 0.045, 0.095), su.y);
    float cone = exp(-dm * dm / (2.0 * pow(0.50 * sz.y, 2.0)));
    vec3 tint = mix(vec3(1.0), MOON_TINT, 0.55);
    col = skyD + view * tint * strength * (0.06 + 0.22 * cone);
    col += vec3(0.07, 0.09, 0.17) * 0.5 * exp(-max(su.y - HORIZON, 0.0) / 0.10);
    vec2 sg = p / STAR_CELL;
    vec2 sid = floor(sg);
    vec3 sr = vec3(hash21(sid + 2.2), hash21(sid + 8.8), hash21(sid + 14.4));
    float sdist = length(sg - (sid + 0.2 + 0.6 * sr.xy)) * STAR_CELL;
    float tw = 0.55 + 0.45 * sin(uTime / (3.0 + 5.0 * sr.z) + sr.x * 40.0);
    float star = step(sr.z, 0.48) * step(0.62, hash21(sid + 4.4)) * exp(-pow(sdist / 1.2, 2.0)) * tw;
    star *= (1.0 - hu) * smoothstep(0.35, 0.7, su.y) * (1.0 - exp(-pow(dm / (HALO_PX * 0.6), 2.0)));
    col += vec3(0.8, 0.88, 1.0) * star * 0.9;
    col += vec3(0.38, 0.50, 0.85) * (0.80 * halo + 0.12 * ring) * strength;
    vec3 moonC = vec3(0.93, 0.95, 1.0) * (1.0 - 0.14 * maria) * (1.0 - 0.18 * dot(mq, mq)) * (0.75 + 0.25 * uMoon);
    col = mix(col, moonC, disc);
    vec3 water = mix(vec3(0.014, 0.026, 0.055), vec3(0.004, 0.010, 0.026), depth);
    water += mirror * tint * strength * 0.30 * (1.0 - 0.5 * depth);
    water += vec3(0.38, 0.50, 0.85) * halo * 0.08 * strength;
    water = mix(water, water * 0.5 + vec3(0.010, 0.014, 0.030), ref1 * 0.7);
    water = mix(water, water * 0.35 + vec3(0.004, 0.006, 0.014), ref2 * 0.8);
    water += vec3(0.75, 0.86, 1.0) * 0.14 * pathX * strength * (1.0 - 0.85 * hu);
    water *= 1.0 + 0.10 * wv * (1.0 - hu);
    col = mix(col, water, 1.0 - sky);
    // The ranges, lit cool from the moon in the cover's colours, the far one paler, mist at their feet.
    vec3 farC = vec3(0.056, 0.073, 0.135) + view * tint * strength * (0.10 + 0.30 * cone);
    farC += vec3(0.09, 0.11, 0.20) * mist * 0.7;
    col = mix(col, farC, hill1);
    col += vec3(0.45, 0.58, 0.9) * rim1 * 0.22 * strength * (0.3 + moonSide) * (1.0 - 0.6 * hu);
    vec3 nearC = vec3(0.016, 0.024, 0.050) + view * tint * strength * (0.04 + 0.12 * cone) + vec3(0.06, 0.08, 0.15) * mist * 0.6;
    col = mix(col, nearC, hill2);
    col += vec3(0.45, 0.58, 0.9) * rim2 * 0.14 * strength * (0.3 + moonSide) * (1.0 - 0.6 * hu);
    vec3 bankD = vec3(0.003, 0.006, 0.011) + vec3(0.012, 0.016, 0.030) * bankLift + vec3(0.16, 0.20, 0.32) * strength * bankRim;
    col = mix(col, bankD, sh.x * 0.97);
    col += vec3(0.60, 0.72, 1.0) * 0.20 * sh.y * strength * (1.0 - 0.8 * hu);
    col = mix(col, mix(vec3(0.010, 0.014, 0.024), vec3(0.20, 0.25, 0.38) * strength, sh.w), sh.z);
    col = mix(col, uGround, hu * 0.25);
  }
  return col;
}
// -- Effect tunables --
const float CLOUD_LO = 0.44;
const float CLOUD_HI = 0.74;
const float CLOUD_SCALE_A = 0.0022; // cloud features per CSS px
const float CLOUD_SCALE_B = 0.0040;
float cloudD(vec2 p, float sc, float t, float seed, float bias) {
  vec2 q = p * sc - vec2(t, 0.0) + seed;
  vec2 w = vec2(vnoise(q * 0.9 + vec2(0.0, t * 0.3)), vnoise(q * 0.9 + vec2(7.7, 1.1))) - 0.5;
  return smoothstep(CLOUD_LO, CLOUD_HI, fbm(q + w * 1.6) * 0.8 + 0.2 * vnoise(q * 0.5) + bias);
}
// The moving layer: two drifting cloud layers lit from the moon, and the glitter on the moon path.
vec3 effects(vec3 col, vec2 fc, vec2 p, vec2 sz, vec2 su, float hu, float solid) {
  vec2 mp = MOON_AT * sz;
  float dm = length(p - mp);
  vec2 toMoon = normalize(mp - p + 1e-3);
  float strength = 0.35 + 0.65 * uMoon;
  float bias = 0.12 * (smoothstep(HORIZON, 0.85, su.y) - 0.5);
  float tA = uCloudT * 0.060 + uNudge, tB = uCloudT * 0.105 + uNudge * 1.5;
  float sky = smoothstep(HORIZON - 0.02, HORIZON + 0.06, su.y);
  float a0 = cloudD(p, CLOUD_SCALE_A, tA, 0.0, bias);
  float b0 = cloudD(p, CLOUD_SCALE_B, tB, 11.0, bias - 0.04) * 0.8;
  float aL = cloudD(p + toMoon * 14.0, CLOUD_SCALE_A, tA, 0.0, bias);
  float bL = cloudD(p + toMoon * 10.0, CLOUD_SCALE_B, tB, 11.0, bias - 0.04) * 0.8;
  float cd = (1.0 - (1.0 - a0) * (1.0 - b0)) * sky * (1.0 - solid);
  float lit = clamp((a0 - aL) * 3.0 + (b0 - bL) * 3.0, 0.0, 1.0);
  float prox = exp(-dm / (0.75 * sz.y));
  float depth = clamp((HORIZON - su.y) / HORIZON, 0.0, 1.0);
  float wv = waterWave(p);
  // The highs widen the path and seed more sparkles that twinkle faster; each sparkle dims as they multiply
  // and the path widens, so the path's total light stays with the moon.
  float spread = 1.0 + 0.40 * uSparkle;
  float thr = 0.70 - 0.14 * uSparkle;
  float pathX = pathGlow(p, mp, depth, wv, spread) * 0.30 / ((1.0 - thr) * spread);
  float cellH = max(2.0, 3.0 + 7.0 * depth);
  vec2 gq = vec2(p.x / 3.5, p.y / cellH);
  float gh = hash21(floor(gq));
  float glit = step(thr, gh) * (0.55 + 0.45 * sin(uGlitT * (0.9 + gh * 1.3) + gh * 60.0)) * smoothstep(0.65, 0.2, length(fract(gq) - 0.5));
  float water = 1.0 - sky;
  if (uLight > 0.5) {
    vec3 cloudL = mix(vec3(0.80, 0.86, 0.94), vec3(1.0), clamp(0.55 + 0.9 * lit + 0.3 * (1.0 - cd), 0.0, 1.0));
    col = mix(col, cloudL, cd * 0.80);
    col += vec3(1.0, 0.98, 0.92) * 0.5 * glit * pathX * water * (1.0 - 0.8 * hu) * (0.5 + 0.5 * uMoon);
  } else {
    vec3 skyD = mix(vec3(0.012, 0.020, 0.050), vec3(0.030, 0.045, 0.095), su.y);
    vec3 cloudC = vec3(0.020, 0.028, 0.055) + skyD * 0.5 + vec3(0.40, 0.50, 0.70) * (0.22 * prox + 1.1 * lit * prox) * strength;
    col = mix(col, cloudC, cd * 0.82);
    col += vec3(0.5, 0.6, 0.9) * 0.12 * cd * exp(-pow(dm / (HALO_PX * 0.7), 2.0)) * strength * (1.0 - 0.6 * hu);
    col += vec3(0.75, 0.86, 1.0) * 0.85 * glit * pathX * water * strength * (1.0 - 0.85 * hu);
  }
  return col;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr;
  vec2 sz = uRes / uDpr;
  vec2 su = fc / uRes;
  float hu = hushAt(fc);
  float solid;
  vec3 col = backdrop(fc, p, sz, su, hu, solid);
  col = effects(col, fc, p, sz, su, hu, solid);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** Eases the highs envelope: quick up, slow down, so the sparkle swells and lingers. */
export function easeHigh(prev: number, target: number, dt: number): number {
  return easeEnvelope(prev, clamp01(target), dt, target > prev ? HIGH_UP_TAU : HIGH_DOWN_TAU);
}

/** The scene's moving state: everything the shader reads that changes over time. */
export interface LakeState {
  moon: number;
  cloud: number;
  nudge: number;
  nudgeTarget: number;
  mid: number;
  wave: number;
  high: number;
  glit: number;
}

export function createLakeState(): LakeState {
  return { moon: 0.3, cloud: 0, nudge: 0, nudgeTarget: 0, mid: 0, wave: 0, high: 0, glit: 0 };
}

/**
 * Advances the state by dt. Fast envelopes never drive a position directly: the mids ease into a speed and
 * a beat raises a target the cloud nudge glides toward, so the clouds move quickly but never step.
 */
export function stepLake(st: LakeState, s: VisualSignal, dt: number): void {
  st.high = easeHigh(st.high, s.highMotion, dt);
  st.glit += dt * (1 + 1.5 * st.high);
  st.moon = easeEnvelope(st.moon, clamp01(s.level * 1.7), dt, MOON_TAU);
  st.mid = easeEnvelope(st.mid, s.midMotion, dt, MID_TAU);
  st.cloud += dt * (0.3 + 1.5 * st.mid);
  st.wave += dt * (0.25 + 0.6 * st.mid);
  st.nudgeTarget = Math.min(0.06, st.nudgeTarget + s.beat * 0.02);
  st.nudgeTarget *= Math.exp(-dt / 1.2);
  st.nudge = easeEnvelope(st.nudge, st.nudgeTarget, dt, NUDGE_TAU);
}

export function createLake(kit: Kit): Candidate {
  const art = createCoverTexture(kit.gl);
  const rings = createRings(RING_LIFE, RING_RISE, RING_HEIGHT);
  const st = createLakeState();

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
      const s = f.sig;
      stepLake(st, s, f.dt);
      rings.step(f.dt, s.beat >= RING_MIN_BEAT ? s.beat : 0);
      const p = kit.program("lake", FS_VS, FS);
      setFluid(kit, p, f, 0, rings.packed, art.tex);
      kit.set1(p, "uMoon", st.moon);
      kit.set1(p, "uCloudT", st.cloud);
      kit.set1(p, "uNudge", st.nudge);
      kit.set1(p, "uWave", st.wave);
      kit.set1(p, "uSparkle", st.high);
      kit.set1(p, "uGlitT", st.glit);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
      rings.clear();
    },
  };
}
