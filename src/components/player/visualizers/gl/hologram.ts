/*
 * Hologram: a projector table throwing a holographic solid of the cover into a dark room. The solid is a cube
 * stood on a corner, larger than the cover so most of it shows around it, with a dashed halo ring round its
 * waist reaching into the stage's sides. Its rotation, faces (corners, edges, view depth) and the projector
 * beams are worked out once a frame in TypeScript and passed as uniforms, so the shader only inverts each
 * face's affine map. Every face carries scanlines in its own plane, filtered by their on-screen pitch, and a
 * scan band travels through the volume.
 *
 * Absolute loudness is the solid's energy: it sets the turn rate, the unfold, the beams and the overall light,
 * so a near-silent passage is a dim, slow, folded solid and a loud one is open, bright and fast. A beat, sized
 * by its weight, swells and bursts the solid open, flares its light and kicks its turn; bass hits rock it on a
 * damped pendulum, mid hits light its edges and high hits its scan line; mids converge the beams; highs speed
 * the scan band; beats send a packet up the beams and a ring over the table; the bands raise the rim pillars.
 * A loudness surge throws the solid open with a full flare and a shock ring across the floor; a cut dims,
 * flickers and folds it and slides slices of the projection sideways. When the intensity first reaches the top
 * of its range the same slide runs, at most once per 24 s. Calm and paused hold a slow steady turn, a closed
 * solid and a slow scan; only the loudness-led light stays live there.
 *
 * Photosensitivity: large-area light follows the eased loudness, the beat envelope (rate-capped with the
 * beat), and the eased surge and cut envelopes; the cut's flicker runs at CUT_HZ, under three a second. Hits
 * light only thin features (edges, the scan line) and move the solid. The glitch only translates the
 * projection: it adds no light and changes no colour.
 */

// -- Local Imports --
import { clamp01, createRng } from "./cozy";
import { CYBER_KIT, cyberBands, cyberGain } from "./cyber";
import { createCoverTexture } from "./coverTexture";
import { createRings, type Rings } from "./fluid";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit, ProgramSource } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** Size, motion and reactions (the shader's own tunables open its source). */
export const HOLO = {
  // Solid edge in cover widths, by framing, its centre above the cover centre, and its slow hover, cover widths.
  // A short stage shrinks the edge so the closed solid fits between the lens and TOP_MARGIN under the stage top;
  // a swell or an unfold grows up from the lower tip and is scaled down evenly past SWELL_OVER over the top.
  SIZE: 1.08,
  SIZE_AMB: 1.06,
  RISE: -0.06,
  BOB: 0.012,
  TOP_MARGIN: 0.03,
  SWELL_OVER: 0.05,
  // Raster handover: a face's lines give way to the screen-fixed raster as they slide from LINE_SLIP_LO to
  // LINE_SLIP_HI line periods a frame, so a fast turn keeps lines without a strobing crawl; the handover eases
  // back over LINE_CLEAR s.
  LINE_SLIP_LO: 0.7,
  LINE_SLIP_HI: 0.95,
  LINE_CLEAR: 0.2,
  // How far the view looks down on the solid and the table, radians; the table ellipse follows it.
  TILT: 0.26,
  // Table centre below the cover centre, and its radius, in cover widths.
  TABLE_DROP: 1.0,
  TABLE_R: 1.05,
  // The halo ring's radius round the solid's waist, cover widths.
  HALO_R: 1.4,
  // Ambient stages draw the table and the halo smaller by this share: their cover sits near the stage's left edge.
  AMB_SPREAD: 0.84,
  // Scanline pitch on a face seen straight on, css px.
  LINE_PITCH: 4.0,
  // Quick and slow measures of the intensity, and the gap between them that reaches the end of the range.
  FAST_TAU: 1,
  SLOW_TAU: 17,
  REL_SPAN: 0.25,
  // Energy: the absolute loudness mapped from ENERGY_LO..ENERGY_HI onto 0..1, eased over ENERGY_TAU.
  ENERGY_LO: 0.1,
  ENERGY_HI: 0.85,
  ENERGY_TAU: 0.4,
  // Turn rate, rad/s: Calm, then the range over the energy by reactivity (silent, loud). A flywheel: quick up, slow to coast.
  TURN_CALM: 0.22,
  TURN_BALANCED: [0.06, 0.6],
  TURN_LIVELY: [0.05, 0.95],
  TURN_UP: 0.9,
  TURN_DOWN: 2.6,
  // A beat's push on the turn per unit of weight, rad/s, and how fast the push wears off, s.
  KICK: 0.9,
  KICK_TAU: 0.3,
  // The beat envelope: rises to each beat's weight over BEAT_UP and falls over BEAT_FALL, settled well inside a
  // 128 BPM gap. At full weight the solid grows by SWELL, bursts open by BURST and its light flares by FLARE.
  BEAT_UP: 0.035,
  BEAT_FALL: 0.11,
  SWELL: 0.12,
  BURST: 0.6,
  FLARE: 0.9,
  // Unfolding: faces drift out along their normals by OPEN_GAP half-edges at full open, on a soft spring.
  OPEN_GAP: 0.28,
  OPEN_BALANCED: 0.6,
  OPEN_PULL: 2.2,
  OPEN_DAMP: 2.4,
  // Bass tumble: each bass hit pushes the other way on a damped pendulum about a slowly drifting horizontal axis.
  TUMBLE_TORQUE: 4,
  TUMBLE_K: 4,
  TUMBLE_DAMP: 2,
  // Hit envelopes: a quick rise, then the bass rocks for BASS_FALL and the edges and scan line glow for EDGE_FALL, s.
  HIT_UP: 0.03,
  BASS_FALL: 0.25,
  EDGE_FALL: 0.15,
  // Scan band speed in half-edges a second: resting, plus the highs.
  SCAN_BASE: 0.55,
  SCAN_HIGH: 1.1,
  SCAN_SPAN: 2.6,
  // A surge: its envelope's rise and fall, s, the extra unfold and flare at full strength, and the floor shock
  // ring's life, s, and reach, in table radii past the rim.
  SURGE_UP: 0.06,
  SURGE_FALL: 1.2,
  SURGE_OPEN: 0.8,
  SURGE_FLARE: 1.2,
  SHOCK_LIFE: 1.6,
  SHOCK_REACH: 2.4,
  // A cut: its envelope's rise and fall, s, the steady dim and the flicker on top of it at full strength, the
  // flicker's rate, Hz, and how far the solid folds in.
  CUT_UP: 0.05,
  CUT_FALL: 0.7,
  CUT_DIM: 0.4,
  CUT_FLICKER: 0.35,
  CUT_HZ: 2.5,
  CUT_FOLD: 0.15,
  // A projector glitch: on a cut, or when the intensity crosses into the top of its range, at most once per GLITCH_EVERY s.
  GLITCH_EVERY: 24,
  GLITCH_LIFE: 0.9,
  // A packet climbs the beams for PACKET_LIFE seconds, ramping in and out over PACKET_RAMP.
  PACKET_LIFE: 0.55,
  PACKET_RAMP: 0.08,
  // A beam whose corner changes re-aims at the new one, and the haze cone follows, over this time constant, s.
  BEAM_EASE: 0.25,
} as const;

const RNG_SEED = 47;

const FS = `${SCENE_PRELUDE}${CYBER_KIT}
uniform vec4 uBandsE[6];
uniform float uGlow;      // overall light: the eased energy, dimmed by a cut
uniform float uBeamAmt;   // beam and haze strength
uniform vec4 uReact;      // the solid: flare, light, edge hit, scan line hit
uniform vec4 uHalo;       // halo ring: radii (px), strength, turn
uniform vec2 uShock;      // surge shock ring on the floor: reach in table radii, strength
uniform float uSlow;      // seconds, for slow drifts
uniform vec4 uGeo;        // solid centre from the cover centre (px), half edge (px), scanlines per face
uniform vec4 uTable;      // table centre from the cover centre (px), radii (px)
uniform vec4 uFace[18];   // per face: corner A and edge U; edge V, view z, line phase; scan band b0, bu, bv, raster handover
uniform vec4 uBeam[4];    // projector beams: start and end, px from the solid centre
uniform vec4 uBeamZ;      // each beam end's depth, -1 back to 1 front
uniform float uScan;      // scan band position along its axis, half edges
uniform vec2 uPulse;      // beat packet up the beams: progress 0..1, strength
uniform vec2 uGlitch;     // launch glitch: amount in px, seed
uniform vec2 uCone;       // top of the haze cone (px from the solid centre) and its half width there
// -- Tunables --
const float LINE_W = 0.40;    // lit share of each scanline period
const float SCAN_W = 0.22;    // scan band half width, half edges
const float PILLAR_H = 0.34;  // tallest light pillar, cover widths
const float LINE_PITCH = ${HOLO.LINE_PITCH.toFixed(1)}; // screen raster pitch, css px
const float RASTER_DRIFT = 0.4; // screen raster drift, lines a second
const float CROSS_DIP = 0.7;  // how far the handover's middle dips toward the mean
float band(int i) { return uBandsE[i >> 2][i & 3]; }
// The hologram colour: cyan in the dark room, blue ink in the bright one.
vec3 holoCol(bool dk) { return dk ? vec3(0.00, 0.95, 1.0) : vec3(0.00, 0.22, 1.0); }

// The launch glitch's slices: rows cut 8 to 34 px tall, about half of them sliding sideways by up to amt px.
float launchSlice(float y, float amt, float seed) {
  float b = floor(y / (8.0 + 26.0 * hash11(floor(y / 40.0) + seed)) + seed);
  return (hash11(b * 3.1 + seed) - 0.5) * 2.0 * step(0.5, hash11(b * 1.7 + seed)) * amt;
}

// The distance in px from p to the ellipse of radii r round the origin, close to the curve.
float ellipseDist(vec2 p, vec2 r) {
  vec2 e = p / r;
  float l = max(length(e), 1e-3);
  return abs(l - 1.0) * l / max(length(e / r), 1e-6);
}

// One light pillar on the rim, pillar k: adds to back (k behind the solid) or front.
void pillar(int k, vec2 p, vec2 tc, vec2 tr, float cw, inout vec3 back, inout vec3 front) {
  k = (k + 24) % 24;
  float a = TAU * (float(k) + 0.5) / 24.0;
  vec2 base = tc + vec2(cos(a) * 0.93 * tr.x, sin(a) * 0.93 * tr.y);
  float hgt = (0.03 + PILLAR_H * band(k)) * cw;
  float dx = abs(p.x - base.x);
  float fade = step(base.y - 1.0, p.y) * smoothstep(base.y + hgt + 2.0, base.y + hgt * 0.2, p.y);
  vec3 c = vec3(1.0 - smoothstep(0.8, 3.0, dx), exp(-dx * dx / 6.0) * 0.1, 0.0) * fade;
  if (sin(a) > 0.0) back = max(back, c * 0.55); else front = max(front, c);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, cc = coverCenter() / uDpr;
  float cw = uCover.z / uDpr;
  float hu = hushAt(fc);
  float det = 1.0 - 0.75 * hu;
  bool dk = uLight < 0.5;
  float scale = uGlow;
  vec3 hcol = holoCol(dk);
  vec3 hcol2 = dk ? vec3(1.0, 0.05, 0.85) : vec3(0.95, 0.0, 0.55);
  vec2 tc = cc + uTable.xy, tr = uTable.zw;
  vec2 hc = cc + uGeo.xy;
  float h = uGeo.z;
  float wallY = tc.y + 0.42 * cw;
  // -- Room: a back wall with panel seams and status lamps, a floor that holds the table's light --
  vec3 wall = dk ? mix(vec3(0.010, 0.012, 0.040), vec3(0.026, 0.026, 0.080), smoothstep(wallY - 40.0, wallY + 0.9 * cw, p.y)) : mix(vec3(0.55, 0.72, 1.00), vec3(0.92, 0.80, 1.00), smoothstep(wallY, wallY + 0.9 * cw, p.y));
  float seamX = 1.0 - smoothstep(0.4, 1.2, abs(mod(p.x - cc.x + 0.55 * cw, 0.99 * cw) - 0.495 * cw));
  wall *= 1.0 - (dk ? 0.0 : 0.05) * seamX;
  wall += (dk ? vec3(0.010, 0.020, 0.032) : vec3(0.0)) * seamX * det;
  vec3 floorc = dk ? mix(vec3(0.020, 0.020, 0.060), vec3(0.004, 0.005, 0.020), smoothstep(wallY, 0.0, p.y)) : mix(vec3(0.62, 0.72, 0.95), vec3(0.42, 0.52, 0.85), smoothstep(wallY, 0.0, p.y));
  vec3 col = p.y > wallY ? wall : floorc;
  col += vec3(0.4, 0.6, 0.8) * exp(-pow(p.y - wallY, 2.0)) * (dk ? 0.05 : 0.12);
  // The table's light on the floor and the wall, and a soft pool of the hologram's light high on the wall.
  vec2 gq = (p - tc) / (tr * vec2(1.7, 1.9));
  col += hcol * exp(-dot(gq, gq) * 1.4) * (dk ? 0.14 : 0.08) * scale;
  float wallGlow = exp(-pow((p.x - hc.x) / (1.0 * cw), 2.0)) * exp(-abs(p.y - hc.y) / (0.7 * cw)) * step(wallY, p.y);
  col += hcol * wallGlow * (dk ? 0.05 : 0.03) * scale;
  // Motes in the hologram's light: sparse, drifting up slowly, only where its glow reaches.
  vec2 mq = p - vec2(0.0, uSlow * 4.0);
  vec2 mcell = floor(mq / 15.0);
  vec2 moff = fract(mq / 15.0) * 15.0 - 3.0 - vec2(hash21(mcell + 2.3), hash21(mcell + 7.9)) * 9.0;
  float near = exp(-dot(p - hc, p - hc) / (2.2 * cw * cw));
  col += hcol * step(0.93, hash21(mcell)) * exp(-dot(moff, moff) / 0.7) * near * (dk ? 0.5 : 0.15) * scale * det;
  // Three status lamps on the wall.
  for (int k = 0; k < 3; k++) {
    vec2 lc = vec2(cc.x - 1.30 * cw + 20.0 * float(k), wallY + 0.80 * cw);
    float lm = soft(length(p - lc) - 2.2, 0.6);
    float br = 0.8 + 0.2 * sin(uSlow * 0.4 + float(k) * 2.0);
    vec3 lcol = k == 0 ? vec3(0.2, 1.0, 0.4) : (k == 1 ? vec3(1.0, 0.7, 0.2) : vec3(0.3, 0.8, 1.0));
    col = mix(col, lcol * (dk ? 0.9 : 0.8) * br, lm);
    col += lcol * exp(-dot(p - lc, p - lc) / 40.0) * (dk ? 0.14 : 0.04) * br;
  }
  // A surge's shock ring runs out across the floor from the rim and fades before the wall.
  if (uShock.y > 0.0) {
    float sd = ellipseDist(p - tc, tr * uShock.x);
    float sv = ((1.0 - smoothstep(0.8, 2.5, sd)) + exp(-sd / 10.0) * 0.3) * uShock.y * smoothstep(wallY + 2.0, wallY - 30.0, p.y) * det;
    if (dk) col += hcol * sv * 0.9;
    else col = mix(col, hcol * 0.85, clamp(sv * 0.6, 0.0, 1.0));
  }
  // -- Table: rim wall, top, engraved rings, lens ring, lamps --
  vec2 tq = (p - tc) / tr;
  float r2 = dot(tq, tq);
  float rr = sqrt(r2);
  float topM = soft((rr - 1.0) * tr.y, 0.8);
  float thick = 0.07 * cw;
  vec2 sq = (p - (tc - vec2(0.0, thick))) / tr;
  float botM = soft((length(sq) - 1.0) * tr.y, 0.8);
  float sideM = max(botM * step(p.y, tc.y), topM);
  vec3 side = (dk ? vec3(0.030, 0.034, 0.042) : vec3(0.80, 0.82, 0.86)) * (0.8 + 0.3 * clamp(dot(normalize(vec2(tq.x, 0.4)), normalize(vec2(-0.7, 0.7))), -1.0, 1.0)) * (0.8 + 0.4 * smoothstep(tc.y - thick, tc.y, p.y));
  col *= 1.0 - 0.45 * exp(-max((length(sq) - 1.0) * tr.y, 0.0) / 14.0) * step(p.y, tc.y + 2.0) * (1.0 - sideM);
  col = mix(col, side, sideM);
  vec3 top = dk ? vec3(0.030, 0.036, 0.048) : vec3(0.90, 0.92, 0.95);
  top *= 0.9 + 0.2 * smoothstep(1.0, -0.2, tq.y + 0.5 * rr);
  float eng = smoothstep(0.012, 0.0, abs(fract(rr * 9.0) - 0.5) - 0.47) * smoothstep(0.30, 0.45, rr) * smoothstep(0.98, 0.9, rr);
  top = mix(top, dk ? vec3(0.07, 0.09, 0.11) : vec3(0.70, 0.74, 0.80), eng * det);
  top += hcol * exp(-pow((rr - 0.985) / 0.012, 2.0)) * (dk ? 0.45 : 0.30) * scale;
  float lens = exp(-pow((rr - 0.205) / 0.022, 2.0));
  float core = 1.0 - smoothstep(0.12, 0.17, rr);
  top += hcol * (lens * 0.9 + core * 0.8 + exp(-rr * rr * 6.0) * 0.3) * scale * (dk ? 1.0 : 0.7);
  // 24 lamps round the rim: the nearest one by angle.
  float la = atan(tq.y, tq.x);
  float lk = floor(la * 24.0 / TAU - 0.5 + 0.5);
  float lang = TAU * (lk + 0.5) / 24.0;
  top += hcol * soft(length((tq - vec2(cos(lang), sin(lang)) * 0.90) * tr) - 1.4, 0.6) * 0.35 * scale;
  top += hcol * rings(rr * tr.x, 0.8 * cw, 0.05 * cw) * 0.55 * smoothstep(0.2, 0.35, rr) * smoothstep(1.0, 0.85, rr) * scale;
  col = mix(col, top, topM);
  // -- Light pillars on the rim, one per band: the four nearest by x, two on the back arc and two on the front --
  vec3 pb = vec3(0.0), pf = vec3(0.0);
  if (abs(p.x - tc.x) < tr.x + 6.0 && p.y > tc.y - tr.y - 2.0 && p.y < tc.y + tr.y + (PILLAR_H + 0.05) * cw) {
    float a0 = acos(clamp((p.x - tc.x) / (0.93 * tr.x), -1.0, 1.0));
    int kb = int(floor(a0 * 24.0 / TAU - 0.5));
    int kf = int(floor((TAU - a0) * 24.0 / TAU - 0.5));
    pillar(kb, p, tc, tr, cw, pb, pf); pillar(kb + 1, p, tc, tr, cw, pb, pf);
    pillar(kf, p, tc, tr, cw, pb, pf); pillar(kf + 1, p, tc, tr, cw, pb, pf);
  }
  if (dk) col += hcol * (pb.x * 0.55 * scale + pb.y) * det;
  else col = mix(col, hcol * 0.85, clamp(pb.x * 0.3 + pb.y * 1.5, 0.0, 1.0) * det);
  // -- The projection: glitch slices, the cone of haze and dust, the beams --
  float region = step(abs(p.y - hc.y), 2.4 * h) * step(abs(p.x - hc.x), 2.4 * h);
  vec2 q = vec2(p.x + launchSlice(p.y, uGlitch.x, uGlitch.y) * region, p.y) - hc;
  vec2 tq2 = tc - hc;
  float lensY = tq2.y, coneTop = uCone.x;
  float v = clamp((q.y - lensY) / (coneTop - lensY), 0.0, 1.0);
  float cwid = mix(0.2 * tr.x, uCone.y, v);
  float cone = (1.0 - smoothstep(cwid * 0.55, cwid, abs(q.x - tq2.x * (1.0 - v)))) * step(lensY, q.y) * step(q.y, coneTop) * smoothstep(0.0, 0.08, v);
  if (cone > 0.0) {
    vec2 dp = q + vec2(0.0, -uSlow * 7.0);
    vec2 cell = floor(dp / 9.0);
    vec2 off = fract(dp / 9.0) * 9.0 - 2.0 - vec2(hash21(cell + 1.7), hash21(cell + 5.3)) * 5.0;
    float dust = step(0.86, hash21(cell)) * exp(-dot(off, off) / 0.8) * (0.6 + 0.4 * sin(uSlow * 0.9 + hash21(cell + 9.1) * 40.0));
    col += hcol * cone * ((dk ? 0.07 : 0.05) * (1.0 - 0.5 * v) + dust * (dk ? 0.35 : 0.20)) * scale * uBeamAmt * det;
  }
  float beams = 0.0, packet = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 a = uBeam[i].xy, b = uBeam[i].zw;
    vec2 pa = q - a, ba = b - a;
    float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(pa - ba * t);
    float z = 0.65 + 0.35 * uBeamZ[i];
    beams += ((1.0 - smoothstep(0.3, 1.2, d)) * 0.5 + exp(-d / 3.0) * 0.16) * z * (0.5 + 0.5 * t);
    float pk = exp(-pow((t - uPulse.x) / 0.07, 2.0));
    packet += (1.0 - smoothstep(0.6, 1.8, d)) * pk * uPulse.y * z;
  }
  col += hcol * (beams * (dk ? 0.55 : 0.45) * scale * uBeamAmt + packet * 0.55) * det;
  // -- The halo: a dashed ring round the solid's waist, the dashes turning with it; its back arc lies behind the solid --
  float hd = ellipseDist(q, uHalo.xy);
  float dash = 0.45 + 0.55 * step(0.4, fract((atan(q.y / uHalo.y, q.x / uHalo.x) + uHalo.w) * 18.0 / TAU));
  float halo = ((1.0 - smoothstep(0.5, 1.6, hd)) * dash + exp(-hd / 5.0) * 0.18) * uHalo.z * det;
  float haloF = halo * step(q.y, 0.0);
  if (dk) col += hcol * halo * step(0.0, q.y) * 0.55;
  else col = mix(col, hcol * 0.85, clamp(halo * step(0.0, q.y) * 0.45, 0.0, 1.0));
  // -- The solid: six faces, each an affine map; back faces first, then front, scanlines in each face's plane --
  vec3 accB = vec3(0.0), accF = vec3(0.0);
  float aB = 0.0, aF = 0.0, eB = 0.0, eF = 0.0, eScan = 0.0, cut = 0.0;
  // The projector's own raster: horizontal lines fixed on screen at the face lines' pitch, drifting slowly.
  float rw = p.y / LINE_PITCH + uSlow * RASTER_DRIFT;
  float raa = min(2.0 / (LINE_PITCH * uDpr), 0.6);
  float raster = 1.0 - smoothstep(LINE_W - raa, LINE_W + raa, abs(fract(rw) - 0.5) * 2.0);
  raster *= 0.82 + 0.18 * vnoise(vec2(p.x * 0.012 - uSlow * 0.3, floor(rw) * 1.7));
  if (abs(q.x) < 2.2 * h && abs(q.y) < 2.2 * h) for (int f = 0; f < 6; f++) {
    vec4 fa = uFace[f * 3], fb = uFace[f * 3 + 1], fs = uFace[f * 3 + 2];
    float vz = fb.z;
    if (abs(vz) < 0.015) continue;
    vec2 U = fa.zw, V = fb.xy;
    float dtm = U.x * V.y - U.y * V.x;
    vec2 d = q - fa.xy;
    vec2 uv = vec2(d.x * V.y - d.y * V.x, U.x * d.y - U.y * d.x) / dtm;
    // Gradients of uv per css px, exact for an affine map, so no derivative instruction is needed.
    float gx = length(vec2(V.y, -V.x)) / abs(dtm), gy = length(vec2(-U.y, U.x)) / abs(dtm);
    float sd = max((abs(uv.x - 0.5) - 0.5) / gx, (abs(uv.y - 0.5) - 0.5) / gy);
    if (sd > 7.0) continue;
    bool fr = vz > 0.0;
    float edge = (1.0 - smoothstep(0.35, 1.3, abs(sd))) + exp(-abs(sd) / 2.2) * 0.28;
    float inside = 1.0 - smoothstep(-0.6, 0.6, sd);
    // The scan band: a plane crossing the volume. Its position on this face is linear in uv; where it cuts the
    // face a thin bright line runs, its width taken from the same exact gradient.
    float bd = fs.x + fs.y * uv.x + fs.z * uv.y - uScan;
    float sb = exp(-pow(bd / SCAN_W, 2.0)) * inside;
    float gb = length(fs.y * vec2(V.y, -V.x) + fs.z * vec2(-U.y, U.x)) / abs(dtm);
    cut = max(cut, (1.0 - smoothstep(0.3, 1.2, abs(bd) / max(gb, 1e-4))) * inside * (fr ? 1.0 : 0.4));
    // Scanlines: a line coordinate across the face, its pitch in device px, anti-aliased and faded to its mean
    // as it nears two pixels.
    float w = uv.y * uGeo.w + fb.w;
    float fw = gy * uGeo.w / uDpr;
    float tl = abs(fract(w) - 0.5) * 2.0;
    float aa = min(fw * 2.0, 0.6);
    float ln = 1.0 - smoothstep(LINE_W - aa, LINE_W + aa, tl);
    // Each line breaks up a little along its length, the breaks drifting slowly, as a projected raster does.
    float run = 0.82 + 0.18 * vnoise(vec2(uv.x * 4.0 - uSlow * 0.3, floor(w) * 1.7 + float(f) * 11.0));
    float fine = smoothstep(0.28, 0.48, fw);
    ln = mix(ln * run, LINE_W * 0.86, fine);
    // A face whose lines slide too fast to read hands over to the screen raster, which cannot strobe; fs.w is the
    // handover, and its middle dips toward the mean so the two line fields never beat at full strength. A face
    // seen nearly edge-on keeps its mean.
    float ho = fs.w * (1.0 - fine);
    ln = mix(mix(ln, raster, ho), LINE_W * 0.86, CROSS_DIP * 4.0 * ho * (1.0 - ho));
    // The lines carry the cover, pulled toward the hologram colour; the face between them is a faint tint.
    vec3 cv = coverAt(clamp(uv, 0.0, 1.0), 1.2);
    vec3 lineC = dk ? mix(hcol, cv * 1.5, 0.4) * (0.75 + 0.6 * luma(cv)) : mix(hcol, cv * 0.7, 0.35);
    vec3 holc = mix(dk ? cv * 0.5 : cv, lineC, ln);
    // Edge-on faces hold more light, as a glass plate does.
    float fres = 0.7 + 0.6 * (1.0 - abs(vz));
    float al = inside * ((fr ? 0.06 : 0.05) + ln * (fr ? 0.62 : 0.10) * (1.0 + 0.6 * sb)) * fres * uReact.y * (1.0 + 0.6 * uReact.x);
    if (fr) { accF += holc * al; aF += al; eF = max(eF, edge); }
    else { accB += holc * al; aB += al; eB = max(eB, edge); }
    eScan = max(eScan, sb);
  }
  vec3 ecol = mix(hcol, hcol2, smoothstep(-h, h, q.y) * 0.8);
  // Edges take the flare and the mid hits; the solid's light (energy, a cut's dim) scales every layer of it.
  float lit = min(uReact.y, 1.0);
  float edgeK = (1.0 + 0.5 * uReact.x + 0.6 * uReact.z) * lit;
  float flareW = dk ? 0.35 * min(uReact.x, 1.0) : 0.0;
  if (aB > 0.0) col = mix(col, accB / aB, clamp(aB, 0.0, 0.6) * det);
  col = mix(col, ecol, clamp(eB * 0.45 * edgeK, 0.0, 0.7) * det * (dk ? scale : 1.0));
  if (aF > 0.0) col = mix(col, accF / aF, clamp(aF, 0.0, 0.7 + 0.15 * min(uReact.x, 1.0)) * det);
  col = mix(col, mix(ecol, vec3(1.0), dk ? 0.15 * eScan + flareW : 0.0) * (dk ? 1.25 : 1.0), clamp(eF * edgeK, 0.0, 0.95) * det * (dk ? scale : 1.0));
  col = mix(col, dk ? mix(hcol, vec3(1.0), 0.35) * scale : hcol * 0.8, clamp(cut * 0.65 * (1.0 + 0.6 * uReact.w) * lit, 0.0, 0.95) * det);
  if (dk) col += hcol * haloF;
  else col = mix(col, hcol * 0.85, clamp(haloF * 0.6, 0.0, 1.0));
  // Front pillars stand before the solid.
  if (dk) col += hcol * (pf.x * 0.55 * scale + pf.y) * det;
  else col = mix(col, hcol * 0.85, clamp(pf.x * 0.42 + pf.y * 1.5, 0.0, 1.0) * det);
  col = hushed(col, hu, 0.32);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** The scene's moving state. The packet, glitch and solid fields at the end are derived each step for the shader. */
export interface HologramState {
  yaw: number;
  spin: number;
  kick: number;
  fast: number;
  slowMean: number;
  primed: boolean;
  open: number;
  openV: number;
  tumble: number;
  tumbleV: number;
  // The eased energy from the absolute loudness, 0..1.
  energy: number;
  // The beat envelope's value and the peak it chases; the weight seen so far in the current beat.
  beat: [number, number];
  weightHeld: number;
  // The surge and cut envelopes (value, peak), and the seconds since the last cut.
  surge: [number, number];
  cut: [number, number];
  cutAge: number;
  // The surge's floor shock ring: age and strength.
  shock: [number, number];
  // Bass, mid and high hit envelopes; the sign of the next bass push and whether a bass hit is under way.
  bass: number;
  edge: number;
  spark: number;
  bassSign: number;
  bassOn: boolean;
  focus: number;
  high: number;
  scan: number;
  bob: number;
  slow: number;
  // The beat packet's age and strength.
  pulse: [number, number];
  glitch: number;
  glitchSeed: number;
  lastGlitch: number;
  wasHigh: boolean;
  rings: Rings;
  bands: Float32Array;
  // The packet's progress up the beams (2 once gone) and its faded strength; the glitch's slide in px.
  packetAt: number;
  packetAmt: number;
  glitchAmt: number;
  // The motion gain the running glitch launched with, so a pause cannot cut its slide short.
  glitchGain: number;
  // Derived for the solid: the extra unfold and size of a beat, surge or cut, its flare, its light, the overall
  // light, and the shock ring's reach (table radii) and strength.
  burst: number;
  grow: number;
  flare: number;
  solidLight: number;
  glow: number;
  shockAt: number;
  shockAmt: number;
}

export function createHologramState(): HologramState {
  return {
    yaw: 0.6,
    spin: HOLO.TURN_CALM,
    kick: 0,
    fast: 0,
    slowMean: 0,
    primed: false,
    open: 0,
    openV: 0,
    tumble: 0,
    tumbleV: 0,
    energy: 0,
    beat: [0, 0],
    weightHeld: 0,
    surge: [0, 0],
    cut: [0, 0],
    cutAge: 9,
    shock: [9, 0],
    bass: 0,
    edge: 0,
    spark: 0,
    bassSign: 1,
    bassOn: false,
    focus: 0,
    high: 0,
    scan: -HOLO.SCAN_SPAN,
    bob: 0,
    slow: 0,
    pulse: [9, 0],
    glitch: 9,
    glitchSeed: 1,
    lastGlitch: -99,
    wasHigh: false,
    rings: createRings(2.4, 0.35, 0.6),
    bands: new Float32Array(24),
    packetAt: 2,
    packetAmt: 0,
    glitchAmt: 0,
    glitchGain: 0,
    burst: 0,
    grow: 1,
    flare: 0,
    solidLight: 1,
    glow: 1,
    shockAt: 1,
    shockAmt: 0,
  };
}

/** Steps a peak-follow envelope [value, peak] by `input`: the peak jumps up and decays over `fall`; the value rises to it over `up`. */
function followPeak(env: [number, number], input: number, dt: number, up: number, fall: number): number {
  // The peak snaps to 0 once too small to see, so the envelope comes to rest exactly.
  const decayed = env[1] * Math.exp(-dt / fall);
  env[1] = Math.max(decayed < 1e-4 ? 0 : decayed, input);
  env[0] = env[1] > env[0] ? easeEnvelope(env[0], env[1], dt, up) : env[1];
  return env[0];
}

/**
 * Advances the scene by dt at motion gain `drive` (0 under Calm and while paused). `rng` picks the glitch's
 * slices.
 */
export function stepHologram(st: HologramState, s: VisualSignal, dt: number, drive: number, rng: () => number): void {
  const H = HOLO;
  const live = drive > 0;
  const lively = drive > 1.3;
  const gain = Math.min(1.3, drive);
  st.slow += dt;
  // Energy: where the absolute loudness sits, the driver of the turn, the unfold and the light.
  const energyT = clamp01((s.loudness - H.ENERGY_LO) / (H.ENERGY_HI - H.ENERGY_LO));
  // Intensity against its own slow mean: only the launch glitch reads it.
  const intensity = s.loudness + 0.15 * s.bassMotion;
  if (!st.primed) {
    st.fast = intensity;
    st.slowMean = intensity;
    st.energy = energyT;
    st.primed = true;
  }
  st.fast = easeEnvelope(st.fast, intensity, dt, H.FAST_TAU);
  st.slowMean = easeEnvelope(st.slowMean, intensity, dt, H.SLOW_TAU);
  st.energy = easeEnvelope(st.energy, energyT, dt, H.ENERGY_TAU);
  const rel = Math.max(-1, Math.min(1, (st.fast - st.slowMean) / H.REL_SPAN));
  const ease2 = (prev: number, target: number, up: number, down: number) =>
    easeEnvelope(prev, target, dt, target > prev ? up : down);
  // The beat envelope follows each beat's weight; the turn takes a push for every rise of it, so a beat's
  // whole push is KICK times its final weight.
  const weight = live ? Math.min(1.3, s.beatWeight) : 0;
  const beatV = followPeak(st.beat, weight, dt, H.BEAT_UP, H.BEAT_FALL);
  st.kick *= Math.exp(-dt / H.KICK_TAU);
  if (weight > st.weightHeld) st.kick += H.KICK * (weight - st.weightHeld);
  // The weight reads 0 once its hold ends: that frame launches the table ring with the final weight. Calm or a
  // pause landing inside a hold also reads 0, and drops the beat without a ring.
  const ended = live && weight === 0 && st.weightHeld > 0 ? st.weightHeld : 0;
  st.weightHeld = weight;
  // Shifts: a surge throws the solid open and flares it, a cut dims, flickers and folds it.
  const surge = live ? Math.min(1.3, s.surge) : 0;
  const cutIn = live ? Math.min(1.3, s.cut) : 0;
  const surgeV = followPeak(st.surge, surge, dt, H.SURGE_UP, H.SURGE_FALL);
  const cutV = followPeak(st.cut, cutIn, dt, H.CUT_UP, H.CUT_FALL);
  st.cutAge = cutIn > 0 ? 0 : st.cutAge + dt;
  st.shock[0] += dt;
  if (surge > 0) st.shock = [0, surge];
  // Turn: a flywheel toward the rate the energy asks for, plus the beats' pushes.
  const [lo, hi] = lively ? H.TURN_LIVELY : H.TURN_BALANCED;
  const turnT = live ? lo + (hi - lo) * st.energy : H.TURN_CALM;
  st.spin = ease2(st.spin, turnT, H.TURN_UP, H.TURN_DOWN);
  st.yaw = (st.yaw + (st.spin + st.kick) * dt) % (Math.PI * 2);
  // Unfolding: the faces part on a soft spring as the energy rises; a cut pulls them shut.
  const openT = live ? st.energy * (lively ? 1 : H.OPEN_BALANCED) * (1 - Math.min(1, cutV)) : 0;
  st.openV += ((openT - st.open) * H.OPEN_PULL - st.openV * H.OPEN_DAMP) * dt;
  st.open = Math.max(0, Math.min(1.15, st.open + st.openV * dt));
  // Hits: each bass hit pushes the pendulum the other way, so the solid rocks; mids and highs light thin lines.
  if (live && s.bassHit > 0.35 && !st.bassOn) st.bassSign = -st.bassSign;
  st.bassOn = live && s.bassHit > (st.bassOn ? 0.15 : 0.35);
  st.bass = ease2(st.bass, live ? Math.min(1.3, s.bassHit) : 0, H.HIT_UP, H.BASS_FALL);
  st.edge = ease2(st.edge, live ? Math.min(1.3, s.midHit) : 0, H.HIT_UP, H.EDGE_FALL);
  st.spark = ease2(st.spark, live ? Math.min(1.3, s.highHit) : 0, H.HIT_UP, H.EDGE_FALL);
  st.tumbleV += (H.TUMBLE_TORQUE * st.bassSign * st.bass - st.tumble * H.TUMBLE_K - st.tumbleV * H.TUMBLE_DAMP) * dt;
  st.tumble += st.tumbleV * dt;
  // Mids focus the beams; highs speed the scan band.
  st.focus = ease2(st.focus, live ? clamp01(s.midMotion) : 0, 0.25, 0.8);
  st.high = ease2(st.high, live ? clamp01(s.highMotion) : 0, 0.2, 0.7);
  st.scan += dt * (H.SCAN_BASE + H.SCAN_HIGH * st.high * gain);
  if (st.scan > H.SCAN_SPAN) st.scan -= 2 * H.SCAN_SPAN;
  st.bob = H.BOB * Math.sin(st.slow * 0.5);
  // Beats: a packet up the beams, sized by the weight as it lands, and a ring over the table; a surge rings it too.
  st.pulse[0] += dt;
  const packetOf = (w: number) => Math.min(1.3, 0.15 + 0.9 * w);
  if (live && s.beat > 0 && st.pulse[0] > 0.45) st.pulse = [0, packetOf(weight)];
  else if (st.pulse[0] < 0.15) st.pulse[1] = Math.max(st.pulse[1], packetOf(weight));
  st.rings.step(dt, Math.max(ended, surge > 0 ? 1.5 : 0));
  const pp = st.pulse[0] / H.PACKET_LIFE;
  st.packetAt = pp < 1 ? pp : 2;
  st.packetAmt = pp < 1 ? st.pulse[1] * (1 - pp * 0.5) * Math.min(1, st.pulse[0] / H.PACKET_RAMP, (H.PACKET_LIFE - st.pulse[0]) / H.PACKET_RAMP) : 0;
  // The glitch: on a cut, or the intensity crossing into the top of its range, rarely.
  const top = rel > 0.75;
  const onCut = cutIn > 0;
  if (live && (onCut || (top && !st.wasHigh)) && st.slow - st.lastGlitch > (onCut ? H.GLITCH_LIFE : H.GLITCH_EVERY)) {
    st.glitch = 0;
    st.lastGlitch = st.slow;
    st.glitchGain = onCut ? gain * Math.min(1, 0.4 + cutIn) : gain;
    st.glitchSeed = 1 + rng() * 50;
  }
  st.wasHigh = top;
  // What the solid shows this frame.
  const sp = Math.min(1, st.shock[0] / H.SHOCK_LIFE);
  st.shockAt = 1 + H.SHOCK_REACH * (1 - (1 - sp) ** 2);
  st.shockAmt = sp < 1 ? st.shock[1] * (1 - sp) ** 2 * Math.min(1, st.shock[0] / 0.08) : 0;
  const flicker = 0.5 - 0.5 * Math.cos(2 * Math.PI * H.CUT_HZ * st.cutAge);
  const dim = Math.min(1, cutV) * (H.CUT_DIM + H.CUT_FLICKER * flicker);
  st.burst = H.BURST * beatV + H.SURGE_OPEN * surgeV;
  st.grow = (1 + H.SWELL * beatV) * (1 - H.CUT_FOLD * Math.min(1, cutV));
  st.flare = Math.min(1.5, H.FLARE * beatV + H.SURGE_FLARE * surgeV);
  st.solidLight = (0.8 + 0.6 * st.energy) * (1 - dim);
  st.glow = (0.55 + 0.7 * Math.sqrt(st.energy)) * (1 - 0.5 * dim);
  st.glitch += dt;
  const ga = st.glitch / H.GLITCH_LIFE;
  st.glitchAmt = ga < 1 ? Math.sin(Math.PI * Math.min(1, ga * 2.5)) ** 2 * (1 - ga) * 18 * st.glitchGain : 0;
  cyberBands(st.bands, s, drive, dt);
}

// -- The solid's frame --

type Mat3 = readonly number[];
type Vec3 = readonly number[];

// 3x3 helpers, row-major.
const mul = (a: Mat3, b: Mat3): number[] =>
  [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
const apply = (m: Mat3, v: Vec3): number[] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const rotX = (a: number): number[] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const rotY = (a: number): number[] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
// Rotation by angle a about the unit axis k (Rodrigues).
function rotAxis(k: Vec3, a: number): number[] {
  const [x, y, z] = k;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
// The cube stood on a corner: its body diagonal turned upright.
const STAND = rotAxis([-Math.SQRT1_2, 0, Math.SQRT1_2], Math.acos(1 / Math.sqrt(3)));
// Each axis's two edge directions, in the order the shader's face maps expect.
const EDGES: readonly (readonly [Vec3, Vec3])[] = [
  [[0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 1, 0]],
];

/** The table's radius in css px for a cover `cw` css px wide. */
export function tableRadius(cw: number, ambient: boolean): number {
  return HOLO.TABLE_R * cw * (ambient ? HOLO.AMB_SPREAD : 1);
}

/** The solid's frame in css px from its centre, filled in place each step. */
export interface SolidFrame {
  h: number;
  cw: number;
  lines: number;
  // Each face: corner A and edge U; edge V, view depth and line phase; the scan band's linear coefficients.
  faces: Float32Array;
  // Each beam: its start at the lens, then its end at a corner.
  beams: Float32Array;
  beamZ: Float32Array;
  // The cube corner each beam slot is aimed at (-1 before the first frame), and the offset left from a re-aim.
  slots: Int8Array;
  resid: Float32Array;
  // The top of the haze cone and its half width there.
  cone: [number, number];
  // The solid's centre above the cover centre, css px.
  rise: number;
  // Each face's corner A (from the cover centre) and edges U and V last frame, and its raster handover.
  prev: Float32Array;
  handover: Float32Array;
}

export function createSolidFrame(): SolidFrame {
  return {
    h: 0,
    cw: 0,
    lines: 0,
    faces: new Float32Array(72),
    beams: new Float32Array(16),
    beamZ: new Float32Array(4),
    slots: new Int8Array(4).fill(-1),
    resid: new Float32Array(20),
    cone: [0, 0],
    rise: 0,
    prev: new Float32Array(36),
    handover: new Float32Array(6),
  };
}

// The closed solid's top corner above its centre, in half edges: the body diagonal's half, tilted toward the view.
const TIP = Math.sqrt(3) * Math.cos(HOLO.TILT);

/**
 * How far each face's lines slide across themselves this frame, in line periods: the largest move of a face
 * corner across the lines, over the lines' on-screen spacing. Writes the eased raster handover into each face's
 * last slot.
 */
function handOver(out: SolidFrame, first: boolean, dt: number): void {
  const H = HOLO;
  const clear = Math.exp(-dt / H.LINE_CLEAR);
  for (let f = 0; f < 6; f++) {
    const o = f * 12;
    const ax = out.faces[o], ay = out.faces[o + 1] + out.rise;
    const ux = out.faces[o + 2], uy = out.faces[o + 3], vx = out.faces[o + 4], vy = out.faces[o + 5];
    const p = out.prev.subarray(f * 6, f * 6 + 6);
    let target = 0;
    if (!first) {
      const ul = Math.hypot(ux, uy);
      const spacing = Math.abs(ux * vy - uy * vx) / Math.max(ul * out.lines, 1e-6);
      let slide = 0;
      for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const dx = ax + a * ux + b * vx - (p[0] + a * p[2] + b * p[4]);
        const dy = ay + a * uy + b * vy - (p[1] + a * p[3] + b * p[5]);
        slide = Math.max(slide, Math.abs(-dx * uy + dy * ux) / Math.max(ul, 1e-6));
      }
      const t = clamp01((slide / Math.max(spacing, 1e-6) - H.LINE_SLIP_LO) / (H.LINE_SLIP_HI - H.LINE_SLIP_LO));
      target = t * t * (3 - 2 * t);
    }
    out.handover[f] = Math.max(target, out.handover[f] * clear);
    out.faces[o + 11] = out.handover[f];
    p.set([ax, ay, ux, uy, vx, vy]);
  }
}

/**
 * Works out the solid's rotation, faces and beams for a cover `cw` css px wide. Faces carry their corner,
 * edges, view depth, scanline phase and the scan band's linear coefficients; beams run from the lens to the
 * four lowest corners, starting closer to the lens centre as the mids focus them. Each beam slot keeps its
 * corner while that corner stays among the four lowest; a slot whose corner leaves re-aims at the one that
 * entered by easing out the offset, so no beam end jumps. `dt` is the step's length. `room` is the stage top's
 * height above the cover centre, css px: the closed solid shrinks to fit under it, and its swell and unfold are
 * capped just past it.
 */
export function solidFrame(st: HologramState, cw: number, ambient: boolean, out: SolidFrame, dt: number, room = Infinity): SolidFrame {
  const H = HOLO;
  const lensY = -H.TABLE_DROP * cw;
  const topLimit = room - H.TOP_MARGIN * cw;
  const hRest = Math.min((ambient ? H.SIZE_AMB : H.SIZE) * cw * 0.5, (topLimit - lensY) / (2 * TIP));
  const rest = Math.min(H.RISE * cw, topLimit - TIP * hRest - H.BOB * cw) + st.bob * cw;
  const h = hRest * st.grow;
  const phi = st.slow * 0.11;
  const M = mul(rotX(H.TILT), mul(rotAxis([Math.cos(phi), 0, Math.sin(phi)], st.tumble), mul(rotY(st.yaw), STAND)));
  const dir = [0.3, 1.0, 0.22];
  const dl = Math.hypot(dir[0], dir[1], dir[2]);
  const opening = st.open + st.burst;
  // Fills the faces for half edge hh and unfold o, and returns the height from the lowest corner to the highest.
  const build = (hh: number, o: number): number => {
    const scanAt = (v: Vec3) => (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / dl / hh;
    const grow = 1 + H.OPEN_GAP * o;
    const fs = 1 - 0.5 * H.OPEN_GAP * o;
    for (let ax = 0; ax < 3; ax++) {
      for (let fv = 0; fv < 2; fv++) {
        const sg = fv ? 1 : -1;
        const n = [0, 0, 0];
        n[ax] = sg;
        const [t1, t2] = EDGES[ax];
        const A = [0, 1, 2].map((i) => (n[i] * grow - (t1[i] + t2[i]) * fs) * hh);
        const vA = apply(M, A);
        const vU = apply(M, t1.map((x) => x * 2 * hh * fs));
        const vV = apply(M, t2.map((x) => x * 2 * hh * fs));
        const vz = apply(M, n)[2];
        out.faces.set([vA[0], vA[1], vU[0], vU[1], vV[0], vV[1], vz, 0.5 * fv + 0.17 * ax, scanAt(vA), scanAt(vU), scanAt(vV), 0], (ax * 2 + fv) * 12);
      }
    }
    let top = -Infinity;
    bottom = Infinity;
    for (let f = 0; f < 72; f += 12) {
      const y = out.faces[f + 1];
      const ys = [y, y + out.faces[f + 3], y + out.faces[f + 5], y + out.faces[f + 3] + out.faces[f + 5]];
      top = Math.max(top, ...ys);
      bottom = Math.min(bottom, ...ys);
    }
    return top - bottom;
  };
  let bottom = 0;
  // The solid stands on its resting lower tip, `base`: an unfold or a swell grows it upward. The steady solid
  // (no beat, no surge) is scaled down evenly to stay TOP_MARGIN under the stage top; a beat's or a surge's
  // growth on top of that may pass the top by at most SWELL_OVER.
  const base = rest - TIP * hRest;
  const steady = Math.min(1, (topLimit - base) / build(hRest, st.open));
  const span = build(h, opening);
  const fit = Math.min(steady, (room + H.SWELL_OVER * cw - base) / span);
  out.rise = Math.max(base + fit * (rest - base), base - bottom * fit);
  if (fit < 1) for (let o = 0; o < 72; o += 12) for (let j = 0; j < 6; j++) out.faces[o + j] *= fit;
  const hs = h * fit;
  const first = out.cw === 0;
  // The line count comes from the resting size, so a swell stretches the lines instead of adding one.
  out.lines = Math.floor((2 * hRest) / H.LINE_PITCH);
  handOver(out, first, dt);
  // The four lowest corners of the closed cube, pushed out with the faces and scaled with them.
  const corners: number[][] = [];
  for (let k = 0; k < 8; k++) {
    const c = [k & 1 ? hs : -hs, k & 2 ? hs : -hs, k & 4 ? hs : -hs].map((x) => x * (1 + 0.5 * H.OPEN_GAP * opening));
    corners.push(apply(M, c));
  }
  const order = corners.map((_, k) => k).sort((a, b) => corners[a][1] - corners[b][1]);
  const sorted = order.map((k) => corners[k]);
  const tableR = tableRadius(cw, ambient);
  const lensR = 0.205 * tableR;
  const lensRy = lensR * Math.sin(H.TILT);
  const ty = lensY - out.rise;
  const reach = 1 - 0.7 * st.focus;
  // A beam from the lens to corner c: start x, start y, end x, end y, depth.
  const beamTo = (c: number[]): number[] => {
    const zn = Math.max(-1, Math.min(1, c[2] / (hs * 1.5)));
    return [Math.max(-1, Math.min(1, c[0] / (hs * 1.2))) * lensR * reach, ty - zn * lensRy * reach, c[0], c[1], zn];
  };
  const lowest = order.slice(0, 4);
  const entering = lowest.filter((k) => !out.slots.includes(k));
  let next = 0;
  for (let s = 0; s < 4; s++) {
    if (lowest.includes(out.slots[s])) continue;
    const to = beamTo(corners[entering[next]]);
    // Carry the old end over as an offset, so the beam leaves where it was.
    if (out.slots[s] >= 0) for (let j = 0; j < 5; j++) out.resid[s * 5 + j] = (j < 4 ? out.beams[s * 4 + j] : out.beamZ[s]) - to[j];
    out.slots[s] = entering[next++];
  }
  const decay = Math.exp(-dt / H.BEAM_EASE);
  for (let s = 0; s < 4; s++) {
    const to = beamTo(corners[out.slots[s]]);
    for (let j = 0; j < 4; j++) out.beams[s * 4 + j] = to[j] + out.resid[s * 5 + j];
    out.beamZ[s] = Math.max(-1, Math.min(1, to[4] + out.resid[s * 5 + 4]));
    for (let j = 0; j < 5; j++) out.resid[s * 5 + j] *= decay;
  }
  const ring = sorted.slice(1, 4);
  // The cone's top and width come from the sorted corners, so they ease like the beams when the order changes.
  const coneTop = (ring[0][1] + ring[1][1] + ring[2][1]) / 3;
  const coneWidth = Math.max(...ring.map((c) => Math.abs(c[0]))) * 0.9;
  out.cone[0] = first ? coneTop : coneTop + (out.cone[0] - coneTop) * decay;
  out.cone[1] = first ? coneWidth : coneWidth + (out.cone[1] - coneWidth) * decay;
  out.h = h;
  out.cw = cw;
  return out;
}

const HOLOGRAM_PROGRAM: ProgramSource = { name: "hologram", vs: FS_VS, fs: FS };
/** The programs hologram compiles, for warming the shader cache ahead of the stage. */
export const HOLOGRAM_PROGRAMS: readonly ProgramSource[] = [HOLOGRAM_PROGRAM];

export function createHologram(kit: Kit): Candidate {
  const { gl } = kit;
  const art = createCoverTexture(gl);
  const rng = createRng(RNG_SEED);
  const st = createHologramState();
  const solid = createSolidFrame();

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
      stepHologram(st, s, f.dt, cyberGain(s, f.playing), rng);
      const cover = kit.geo.cover;
      const room = (kit.size.h - (cover[1] + cover[3] * 0.5)) / kit.size.dpr;
      const fr = solidFrame(st, cover[2] / kit.size.dpr, f.ambient, solid, f.dt, room);
      const p = kit.program(HOLOGRAM_PROGRAM);
      setScene(kit, p, f, 0, st.rings.packed, art.tex);
      gl.uniform4fv(kit.uniform(p, "uBandsE"), st.bands);
      kit.set1(p, "uGlow", st.glow);
      kit.set1(p, "uBeamAmt", (0.7 + 0.6 * st.energy) * (1 + 0.4 * st.flare) * st.solidLight);
      kit.set4(p, "uReact", [st.flare, st.solidLight, st.edge, st.spark]);
      const haloR = HOLO.HALO_R * fr.cw * (f.ambient ? HOLO.AMB_SPREAD : 1) * (1 + 0.5 * (st.grow - 1) + 0.08 * st.burst);
      const haloAmt = (0.35 + 0.65 * st.energy) * (1 + 0.8 * st.flare) * st.solidLight;
      kit.set4(p, "uHalo", [haloR, haloR * Math.sin(HOLO.TILT), haloAmt, st.yaw]);
      kit.set2(p, "uShock", st.shockAt, st.shockAmt);
      kit.set1(p, "uSlow", st.slow);
      kit.set4(p, "uGeo", [0, fr.rise, fr.h, fr.lines]);
      const tableR = tableRadius(fr.cw, f.ambient);
      kit.set4(p, "uTable", [0, -HOLO.TABLE_DROP * fr.cw, tableR, tableR * Math.sin(HOLO.TILT)]);
      gl.uniform4fv(kit.uniform(p, "uFace"), fr.faces);
      gl.uniform4fv(kit.uniform(p, "uBeam"), fr.beams);
      kit.set4(p, "uBeamZ", [fr.beamZ[0], fr.beamZ[1], fr.beamZ[2], fr.beamZ[3]]);
      kit.set1(p, "uScan", st.scan);
      kit.set2(p, "uCone", fr.cone[0], fr.cone[1]);
      kit.set2(p, "uPulse", st.packetAt, st.packetAmt);
      kit.set2(p, "uGlitch", st.glitchAmt, st.glitchSeed);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
