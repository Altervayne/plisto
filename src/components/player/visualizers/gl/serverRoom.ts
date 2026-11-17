/*
 * Server Room: one-point perspective down an aisle of server racks, the vanishing point on the cover. Rack doors
 * carry 42 rows of status LEDs and drive bays, strip lights and a cable tray run overhead, the floor is raised
 * tile, and a wall monitor on the left shows the cover. Cool white aisle light; by day, a bright clean machine hall.
 *
 * Every rack door is a level meter: its LED rows fill from the floor up with its band, a white peak row holding
 * above, so the aisle reads as a spectrum in depth (bass at the near racks, highs at the far end). A beat sends a
 * wave of light down the aisle, in the next of three slots; the band envelopes send their own. The wall monitor
 * slides in slices on beats.
 *
 * Photosensitivity: brightness at rest follows the eased level (uGlow). Columns change LED hue and trade light
 * between lit and unlit rows, so a door's total holds. A wave adds eased, local light as it travels (LED swell
 * and burn, a blue wash on the rack faces) and fades out before it reaches the viewer; nothing flashes. Calm and
 * paused launch no waves and no columns and let running waves fade out; the LEDs only breathe slowly.
 */

// -- Local Imports --
import { clamp01, createRng } from "./cozy";
import { createCoverTexture } from "./coverTexture";
import { CYBER_KIT, cyberBeat, cyberGain, createCyberBeat } from "./cyber";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit, ProgramSource } from "./kit";
import type { CyberBeatState } from "./cyber";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** The level columns on the rack doors. */
export const SERVER_COLS = {
  // Rack slots along each side (the shader's uRack size); slot j stands at depth (j + 0.5) * RACK_D.
  SLOTS: 24,
  RACK_D: 0.55,
  // Depth range spread over the 24 bands: bass on the nearest racks, highs at the far end.
  NEAR_Z: 1.2,
  SPAN_Z: 6.5,
  // Column fill per unit of band level, scaled by the motion gain (capped), and its curve.
  GAIN_CAP: 1.3,
  CURVE: 0.75,
  // Rise and fall, s: each unit adds up to the spread to its own, so neighbouring racks lag a little.
  RISE: 0.1,
  RISE_SPREAD: 0.08,
  FALL: 0.55,
  FALL_SPREAD: 0.25,
  // Peak marker: held this long, then sinks at this many door heights per second.
  HOLD: 0.8,
  SINK: 0.25,
} as const;

/** The waves down the aisle: start depth, speed, the pause between band-launched waves, and the fade near the viewer. */
export const SERVER_WAVES = {
  START_Z: 13,
  SPEED: 9,
  COOL: 0.35,
  FADE_Z: 2,
  FADE_RATE: 12,
  // A wave under this strength counts as finished, so its band may launch another.
  FREE_A: 0.05,
  // Without drive, running waves fade over this time constant, s, and stop below STOP_A.
  FADE_TAU: 0.4,
  STOP_A: 0.001,
} as const;

const RNG_SEED = 41;

const FS = `${SCENE_PRELUDE}${CYBER_KIT}
uniform vec2 uFront[3];
uniform float uBeat;
uniform float uSeed;
uniform float uGlow;
uniform float uSlow;
uniform vec4 uRack[24];   // the level columns per rack slot: left level, left peak, right level, right peak
// -- Tunables --
const float FOCAL = 2.8;      // px per world unit at depth 1, in cover widths
const float AISLE_W = 1.0;    // half width: the rack faces stand at +-1
const float FLOOR_H = 0.8;    // floor below the eye
const float CEIL_H = 1.0;     // ceiling above the eye
const float RACK_D = 0.55;    // rack width along the aisle
const float RACK_H = 1.7;     // rack height from the floor
const float ROWS = 42.0;      // 1U rows per rack
const float END_Z = 14.0;     // the far wall
const float FOG_Z = 9.0;
const vec2 MON_Z = vec2(3.0, 4.5);   // the wall monitor on the left, depth range
const vec2 MON_H = vec2(-0.10, 0.80); // and its height range
const vec3 HUE_BASS = vec3(0.10, 0.30, 1.0);
const vec3 HUE_MID = vec3(0.00, 1.0, 0.55);
const vec3 HUE_HIGH = vec3(1.0, 0.10, 0.80);
const float METER_TRADE = 0.6;     // lit LEDs gain this much and unlit ones lose it, so a door's light holds
const vec2 WAVE_FADE = vec2(1.5, 4.8); // a wave's light fades out between these depths as it nears the viewer
const vec2 METER_PX = vec2(2.4, 4.5); // the columns fade in between these row pitches in px, before rows alias
// The column colour up a door, floor to top: ice blue, violet, hot pink; set apart from the green status LEDs.
vec3 meterHue(float y) {
  vec3 c = mix(vec3(0.30, 0.55, 1.00), vec3(0.66, 0.34, 1.00), smoothstep(0.1, 0.5, y));
  return mix(c, vec3(1.00, 0.22, 0.58), smoothstep(0.45, 0.85, y));
}
// A status LED colour from a hash: mostly green, some blue and amber, rarely red.
vec3 ledHue(float h) {
  if (h < 0.60) return vec3(0.15, 1.0, 0.35);
  if (h < 0.80) return vec3(0.25, 0.65, 1.0);
  if (h < 0.96) return vec3(1.0, 0.70, 0.15);
  return vec3(1.0, 0.18, 0.15);
}
// A strip-light segment pattern along the aisle: 1 on a lit tube, 0 in the gaps.
float tube(float z) { float f = fract(z / 1.4); return smoothstep(0.03, 0.08, f) * smoothstep(0.86, 0.80, f); }
// The rack face at depth z and height h: frame, door, 1U rows with LED trios, drive bays and vents. emit gets
// the LED light; pxW and pxRow are the face's size on screen, so detail fades out where it would alias.
vec3 rackFace(float z, float h, float sgn, float pxW, float pxRow, float det, bool dk, out vec3 emit) {
  emit = vec3(0.0);
  float zc = z / RACK_D;
  float ri = floor(zc), u = fract(zc);
  float v = (h + FLOOR_H) / RACK_H;
  vec3 frame = dk ? vec3(0.130, 0.150, 0.200) : vec3(0.74, 0.78, 0.84);
  vec3 door = dk ? vec3(0.028, 0.034, 0.050) : vec3(0.21, 0.24, 0.30);
  if (v > 1.0) {
    // The cable tray above the racks: a dark channel with two coloured cable runs.
    float vt = (v - 1.0) * RACK_H / (CEIL_H - (RACK_H - FLOOR_H));
    vec3 t = dk ? vec3(0.020, 0.024, 0.034) : vec3(0.60, 0.64, 0.70);
    float cab = exp(-pow((vt - 0.35) / 0.12, 2.0));
    float cab2 = exp(-pow((vt - 0.70) / 0.10, 2.0));
    return t + (dk ? vec3(0.05, 0.14, 0.30) : vec3(0.10, 0.30, 0.65)) * cab * 0.7 + vec3(0.30, 0.16, 0.04) * cab2 * 0.8;
  }
  float lod = smoothstep(2.5, 5.0, pxRow);
  float fr = min(u, 1.0 - u) * pxW;
  float fw = 0.05 * pxW;
  float frameM = 1.0 - smoothstep(fw - 0.6, fw + 0.6, fr);
  float rows = v * ROWS;
  float rr = floor(rows), rv = fract(rows);
  float hr = hash21(vec2(ri * 1.7, rr));
  float sep = smoothstep(0.10, 0.02, rv) * lod;
  vec3 c = door * (0.85 + 0.30 * hash21(vec2(ri, rr + 9.0)) * lod) * (0.65 + 0.5 * smoothstep(-0.2, 1.0, v));
  c *= 1.0 - 0.55 * sep;
  c += (dk ? 0.035 : 0.05) * smoothstep(0.55, 0.9, rv) * lod;
  // Vent slots on the rows that carry no drive bays.
  float vent = step(0.5, hr) * step(0.36, u) * step(u, 0.92) * smoothstep(0.55, 0.40, fract(rv * 3.0)) * lod;
  c *= 1.0 - 0.45 * vent;
  // Drive bays: eight dark cells with a tiny light each.
  float bayRow = step(hr, 0.5) * step(0.36, u) * step(u, 0.92) * step(0.18, rv) * step(rv, 0.82);
  float bu = (u - 0.36) / 0.56 * 8.0;
  float bf = fract(bu);
  float bayM = bayRow * step(0.10, bf) * step(bf, 0.90) * lod;
  c = mix(c, door * 0.4 + (dk ? 0.012 : 0.0), bayM);
  float near = smoothstep(16.0, 30.0, pxW);
  vec2 bd = vec2((bf - 0.25) * pxW * 0.07, (rv - 0.5) * pxRow);
  float bayOn = step(0.45, hash21(vec2(floor(bu) + ri * 8.0, rr)));
  float bled = bayRow * bayOn * near * (1.0 - smoothstep(0.35, 1.0, length(bd))) * lod;
  emit += vec3(0.15, 1.0, 0.35) * bled * 0.6;
  c = mix(c, frame, frameM);
  // The LED trio, with the band-group ripple: a passing front enlarges the lights a little and leans their hue.
  int g = int(clamp(v * 3.0, 0.0, 2.99));
  vec2 fr2 = uFront[g];
  float rip = max(fr2.y * exp(-pow((z - fr2.x) / 1.1, 2.0)), max(uFront[(g + 1) % 3].y * exp(-pow((z - uFront[(g + 1) % 3].x) / 1.1, 2.0)), uFront[(g + 2) % 3].y * exp(-pow((z - uFront[(g + 2) % 3].x) / 1.1, 2.0))));
  rip *= smoothstep(WAVE_FADE.x, WAVE_FADE.y, z);
  vec3 gh = g == 0 ? HUE_BASS : (g == 1 ? HUE_MID : HUE_HIGH);
  float rpx = clamp(0.24 * pxRow, 0.8, 2.6) * (1.0 + 1.1 * rip);
  // The level column: the rows below the rack's level take the column colour at the LED's own luma, the peak row
  // a cool white; lit rows gain what unlit rows lose, so the door's light holds while the column moves.
  vec4 rk = uRack[int(min(ri, 23.0))];
  vec2 lp = sgn < 0.0 ? rk.xy : rk.zw;
  float rowF = (rr + 0.5) / ROWS;
  float mk = smoothstep(METER_PX.x, METER_PX.y, pxRow);
  float fillM = step(rowF, lp.x);
  float peakM = step(abs(rowF - lp.y), 0.5 / ROWS) * step(lp.x + 0.5 / ROWS, lp.y);
  float litM = max(fillM, peakM) * mk;
  float trade = mix(1.0, mix(1.0 - METER_TRADE * lp.x, 1.0 + METER_TRADE * max(1.0 - lp.x, peakM), litM), mk);
  vec3 mHue = mix(meterHue(rowF), vec3(0.92, 0.96, 1.0), peakM);
  for (int k = 0; k < 3; k++) {
    float hk = hash21(vec2(ri * 3.0 + float(k), rr + 17.0));
    vec2 d = vec2((u - (0.13 + 0.075 * float(k))) * pxW, (rv - 0.5) * pxRow);
    float dot1 = 1.0 - smoothstep(rpx - 0.5, rpx + 0.5, length(d));
    float breath = 0.82 + 0.18 * sin(uSlow * (0.5 + 0.3 * hk) + hk * 40.0);
    float on = step(0.06, hash21(vec2(ri + float(k), rr + 31.0)));
    vec3 base = ledHue(hk);
    base = mix(base, mHue * luma(base) / luma(mHue), litM * 0.92);
    vec3 hue = mix(base, gh, rip * 0.85);
    emit += hue * dot1 * on * breath * (1.0 + 0.9 * rip) * (1.0 - frameM) * trade;
    emit += hue * on * exp(-dot(d, d) / (rpx * rpx * 7.0)) * (0.22 + 0.35 * rip) * (1.0 - frameM) * near * trade;
  }
  return c;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, cc = coverCenter() / uDpr;
  float cw = uCover.z / uDpr;
  float hu = hushAt(fc);
  float det = 1.0 - 0.75 * hu;
  bool dk = uLight < 0.5;
  float F = FOCAL * cw;
  vec2 r = p - cc;
  float zs = abs(r.x) > 0.01 ? AISLE_W * F / abs(r.x) : 1e4;
  float zv = r.y < 0.0 ? FLOOR_H * F / max(-r.y, 0.01) : CEIL_H * F / max(r.y, 0.01);
  float scale = 0.75 + 0.5 * uGlow;
  vec3 fog = dk ? vec3(0.010, 0.040, 0.110) : vec3(0.70, 0.84, 1.00);
  vec3 col, emit = vec3(0.0);
  float z;
  float lampL = 1.0;
  if (min(zs, zv) > END_Z) {
    // The far wall: only a glow of the wall monitor beyond the cover.
    z = END_Z;
    col = dk ? vec3(0.10, 0.34, 0.46) : vec3(0.78, 0.90, 0.98);
  } else if (zs < zv) {
    z = zs;
    float sgn = sign(r.x);
    float h = r.y * z / F;
    float pxW = AISLE_W * F * RACK_D / (z * z);
    float pxRow = F * (RACK_H / ROWS) / z;
    col = rackFace(z, h, sgn, pxW, pxRow, det, dk, emit);
    // The strip lights wash the faces along the aisle, brightest near the ceiling.
    float wash = 0.78 + 0.30 * tube(z - 0.1) + 0.25 * smoothstep(0.2, 1.0, (h + FLOOR_H) / RACK_H);
    col *= dk ? wash * 1.0 : 1.0 + 0.12 * (wash - 0.9);
    float wv = max(uFront[0].y * exp(-pow((z - uFront[0].x) / 0.8, 2.0)), max(uFront[1].y * exp(-pow((z - uFront[1].x) / 0.8, 2.0)), uFront[2].y * exp(-pow((z - uFront[2].x) / 0.8, 2.0))));
    col += (dk ? vec3(0.05, 0.30, 0.65) : vec3(0.10, 0.25, 0.55)) * wv * 0.30 * det * smoothstep(WAVE_FADE.x, WAVE_FADE.y, z);
    // The wall monitor on the left face: the cover in perspective, a dark bezel, a scan and a pane sheen.
    if (sgn < 0.0) {
      vec2 mz = (vec2(z, h) - vec2(MON_Z.x, MON_H.x)) / vec2(MON_Z.y - MON_Z.x, MON_H.y - MON_H.x);
      float bez = 0.035;
      float inM = step(0.0, mz.x) * step(mz.x, 1.0) * step(0.0, mz.y) * step(mz.y, 1.0);
      float screen = step(bez, mz.x) * step(mz.x, 1.0 - bez) * step(bez * 1.6, mz.y) * step(mz.y, 1.0 - bez * 1.6);
      vec3 cv = coverAt(vec2((mz.x - bez) / (1.0 - 2.0 * bez) + sliceShift(p.y, 0.10 * uBeat, uSeed), (mz.y - bez * 1.6) / (1.0 - 3.2 * bez)), 1.2);
      float scan = 0.9 + 0.1 * sin(p.y * 2.4);
      vec3 mon = cv * scan * (dk ? 1.0 : 0.95);
      mon += vec3(0.5, 0.7, 1.0) * 0.07 * smoothstep(0.4, 0.0, abs(mz.y - 1.2 + mz.x * 1.1));
      vec3 bezc = dk ? vec3(0.010, 0.012, 0.018) : vec3(0.05, 0.06, 0.08);
      col = mix(col, mix(bezc, mon, screen), inM * (1.0 - hu * 0.4));
      float spill = exp(-pow((z - 0.5 * (MON_Z.x + MON_Z.y)) / 1.4, 2.0)) * exp(-pow((h - 0.3) / 0.9, 2.0));
      col += (dk ? vec3(0.04, 0.10, 0.16) : vec3(0.03, 0.05, 0.07)) * spill * (1.0 - inM);
      emit *= 1.0 - 0.85 * inM;
    }
  } else {
    z = zv;
    float x = r.x * z / F;
    if (r.y < 0.0) {
      // Raised floor: tiles with a perforated run down the middle and the strip lights mirrored in it.
      vec2 tc = vec2(x, z) / 0.6;
      vec2 tf = fract(tc) - 0.5;
      float pxT = F * 0.6 / (z * z) ;
      float seam = smoothstep(0.5 - 0.02 * max(1.0, 20.0 / max(pxT, 1.0)), 0.5, max(abs(tf.x), abs(tf.y)));
      col = dk ? vec3(0.030, 0.040, 0.058) : vec3(0.80, 0.84, 0.90);
      col = mix(col, dk ? vec3(0.085, 0.105, 0.14) : vec3(0.60, 0.65, 0.73), seam * smoothstep(0.5, 6.0, pxT));
      float refl = exp(-pow((abs(x) - 0.36) / 0.09, 2.0)) * tube(z) * 0.55 + exp(-pow(x / 0.5, 2.0)) * 0.05;
      col += (dk ? vec3(0.45, 0.62, 0.75) : vec3(0.16, 0.20, 0.24)) * refl * det;
    } else {
      // Ceiling: panels, two tube lights and a cable tray down the middle.
      vec2 tc = vec2(x, z) / 0.6;
      vec2 tf = fract(tc) - 0.5;
      float pxT = F * 0.6 / (z * z);
      float seam = smoothstep(0.48, 0.5, max(abs(tf.x), abs(tf.y)));
      col = dk ? vec3(0.040, 0.050, 0.068) : vec3(0.93, 0.95, 0.98);
      col = mix(col, dk ? vec3(0.015, 0.02, 0.03) : vec3(0.72, 0.76, 0.83), seam * smoothstep(0.5, 5.0, pxT));
      float strip = step(abs(abs(x) - 0.36), 0.045) * tube(z);
      col = mix(col, dk ? vec3(0.55, 0.90, 1.0) : vec3(0.85, 0.97, 1.0), strip);
      col += (dk ? vec3(0.06, 0.28, 0.50) : vec3(0.0, 0.05, 0.12)) * exp(-pow((abs(x) - 0.36) / 0.20, 2.0)) * (0.5 + 0.5 * tube(z));
      float tray = step(abs(x), 0.17);
      col = mix(col, dk ? vec3(0.018, 0.022, 0.030) : vec3(0.50, 0.54, 0.60), tray);
      float bl = exp(-pow((x + 0.07) / 0.022, 2.0)), og = exp(-pow((x - 0.05) / 0.022, 2.0));
      col += (vec3(0.10, 0.32, 0.75) * bl + vec3(0.40, 0.20, 0.04) * og) * tray * (dk ? 1.0 : 0.8);
    }
  }
  float fogK = 1.0 - exp(-z / FOG_Z);
  col = mix(col, fog, fogK * (dk ? 0.85 : 0.65));
  emit *= (1.0 - fogK * 0.5) * scale * det;
  col += emit * (dk ? 1.0 : 0.85);
  // The far glow: the end wall monitor lights the aisle a little, steadily.
  col += (dk ? vec3(0.03, 0.10, 0.14) : vec3(0.0)) * exp(-length(r) / (0.9 * cw));
  col = hushed(col, hu, 0.40);
  outColor = vec4(settle(col, fc), 1.0);
}`;

/** A wave of light travelling down the aisle: depth, strength, the pause before its band may launch another, and whether it is fading out. */
export interface ServerFront {
  z: number;
  a: number;
  cool: number;
  fading: boolean;
}

/** The scene's moving state. `packed`, `beatEnv` and `glow` are set by each step for the shader. */
export interface ServerRoomState {
  slow: number;
  // The next wave slot a beat takes.
  rr: number;
  fronts: ServerFront[];
  beat: CyberBeatState;
  // Per rack and side: eased level and its peak marker, packed as the shader's vec4 uRack[24].
  cols: Float32Array;
  hold: Float32Array;
  // Per rack and side: two fixed offsets that give each column its own timing.
  unit: [number, number][];
  // The shader's vec2 uFront[3]: depth and strength per wave.
  packed: Float32Array;
  // The gain waves were last strengthened by, held while they fade out.
  waveGain: number;
  beatEnv: number;
  glow: number;
}

export function createServerRoomState(): ServerRoomState {
  const C = SERVER_COLS;
  return {
    slow: 0,
    rr: 0,
    fronts: [
      { z: 0, a: 0, cool: 0, fading: false },
      { z: 0, a: 0, cool: 0, fading: false },
      { z: 0, a: 0, cool: 0, fading: false },
    ],
    beat: createCyberBeat(),
    cols: new Float32Array(C.SLOTS * 4),
    hold: new Float32Array(C.SLOTS * 2),
    unit: Array.from({ length: C.SLOTS * 2 }, (_, i): [number, number] => [
      Math.abs(Math.sin(i * 12.9898 + 1.3) * 43758.5) % 1,
      Math.abs(Math.sin(i * 78.233 + 4.1) * 43758.5) % 1,
    ]),
    packed: new Float32Array(6),
    waveGain: 1,
    beatEnv: 0,
    glow: 0,
  };
}

/** Eases the per-rack columns and their peaks, both sides, toward the bands at motion gain `drive`. */
function stepColumns(st: ServerRoomState, sig: VisualSignal, dt: number, drive: number): void {
  const C = SERVER_COLS;
  const b = sig.bands;
  const k = drive > 0 ? Math.min(C.GAIN_CAP, drive) : 0;
  for (let j = 0; j < C.SLOTS; j++) {
    const bp = clamp01(((j + 0.5) * C.RACK_D - C.NEAR_Z) / C.SPAN_Z) * 23;
    const i0 = Math.floor(bp);
    const fr = bp - i0;
    const i1 = Math.min(23, i0 + 1);
    const raw = b[i0] * (1 - fr) + b[i1] * fr;
    const target = k > 0 ? clamp01(Math.pow(raw * k, C.CURVE)) : 0;
    for (let side = 0; side < 2; side++) {
      const u = st.unit[j * 2 + side];
      const o = j * 4 + side * 2;
      const lv = st.cols[o];
      st.cols[o] = easeEnvelope(lv, target, dt, target > lv ? C.RISE + C.RISE_SPREAD * u[0] : C.FALL + C.FALL_SPREAD * u[1]);
      const h = j * 2 + side;
      if (st.cols[o] >= st.cols[o + 1]) {
        st.cols[o + 1] = st.cols[o];
        st.hold[h] = C.HOLD;
      } else if ((st.hold[h] -= dt) <= 0) {
        st.cols[o + 1] = Math.max(st.cols[o], st.cols[o + 1] - C.SINK * dt);
      }
    }
  }
}

/**
 * Advances the aisle by dt at motion gain `drive` (0 under Calm and while paused). `rng` picks the monitor's
 * slice seed.
 */
export function stepServerRoom(st: ServerRoomState, sig: VisualSignal, dt: number, drive: number, rng: () => number): void {
  const W = SERVER_WAVES;
  const env = [sig.bassMotion, sig.midMotion, sig.highMotion];
  st.beatEnv = cyberBeat(st.beat, sig, drive, dt, rng);
  st.slow += dt;
  // A beat sends a wave down the aisle in the next slot; band envelopes send their own, at most one per COOL.
  // Beats take the slots in rotation. A beat faster than a wave's travel time reuses a slot still on screen,
  // which bounds how many waves are alight at once.
  if (drive > 0 && sig.beat > 0) {
    const f = st.fronts[st.rr++ % 3];
    f.z = W.START_Z;
    f.a = 1;
    f.cool = W.COOL;
    f.fading = false;
  }
  if (drive > 0) st.waveGain = Math.min(1.3, drive);
  st.fronts.forEach((f, g) => {
    f.cool -= dt;
    if (drive > 0 && env[g] > 0.5 && f.cool <= 0 && f.a < W.FREE_A) {
      f.z = W.START_Z;
      f.a = clamp01(0.6 + env[g] * 0.4);
      f.cool = W.COOL;
      f.fading = false;
    }
    // Without drive a running wave fades out and stays out, even if the drive returns.
    if (drive === 0) f.fading = true;
    if (f.fading) {
      f.a *= Math.exp(-dt / W.FADE_TAU);
      if (f.a < W.STOP_A) f.a = 0;
    }
    f.z -= dt * W.SPEED;
    if (f.z < W.FADE_Z) f.a *= Math.exp(-dt * W.FADE_RATE);
    st.packed[g * 2] = f.z;
    st.packed[g * 2 + 1] = Math.min(1, f.a * st.waveGain);
  });
  stepColumns(st, sig, dt, drive);
  st.glow = clamp01(sig.level * 1.5);
}

const SERVER_ROOM_PROGRAM: ProgramSource = { name: "server-room", vs: FS_VS, fs: FS };
/** The programs server room compiles, for warming the shader cache ahead of the stage. */
export const SERVER_ROOM_PROGRAMS: readonly ProgramSource[] = [SERVER_ROOM_PROGRAM];

export function createServerRoom(kit: Kit): Candidate {
  const { gl } = kit;
  const art = createCoverTexture(gl);
  const rng = createRng(RNG_SEED);
  const st = createServerRoomState();

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
      stepServerRoom(st, f.sig, f.dt, cyberGain(f.sig, f.playing), rng);
      const p = kit.program(SERVER_ROOM_PROGRAM);
      setScene(kit, p, f, 0, null, art.tex);
      gl.uniform4fv(kit.uniform(p, "uRack"), st.cols);
      gl.uniform2fv(kit.uniform(p, "uFront"), st.packed);
      kit.set1(p, "uBeat", st.beatEnv);
      kit.set1(p, "uSeed", st.beat.seed);
      kit.set1(p, "uGlow", st.glow);
      kit.set1(p, "uSlow", st.slow);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
