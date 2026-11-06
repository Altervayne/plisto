/*
 * Dot spectrum: columns of round dots standing on the seek bar, lit from the bottom up as each column
 * rises. An unlit position stays a faint pinpoint, so the matrix reads at rest, and a dot lights by
 * growing to full size as the column top passes it. Over each column a small decay dot hangs, then falls
 * with soft gravity, easing in as it parts from the column. Each beat runs a size swell across the
 * spectrum from the bass.
 *
 * The columns are the spectrum itself, so they keep one ballistics at every reactivity; the reactivity
 * gain reaches them through the beat swell alone. The 128-band spectrum feeds them when the engine sends
 * one; otherwise the 24 bands are interpolated. Bass sits at the left, or in the centre when mirrored.
 */

// -- Local Imports --
import { createDots, DOT_FS, DOT_PRELUDE } from "./dots";

// -- State Imports --
import { easeEnvelope, MOTION_ATTACK_SECS } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

// The most columns one draw holds; a wider stage spaces the same count.
const MAX_COLS = 192;
// Grid pitch in CSS pixels, in ambient and in the Player.
const PITCH_AMBIENT = 16;
const PITCH_PLAYER = 14;
// The Player's columns keep this far in from the hero column's sides, in CSS pixels.
const SIDE_INSET = 26;
// How far up ambient's lit columns reach, as a share of the stage above the floor.
const AMBIENT_REACH = 0.62;
// Column ballistics: the release in seconds, the height curve, how long a decay dot hangs, and its fall.
const RELEASE = 0.4;
const GAMMA = 1.3;
const HOLD = 0.3;
const GRAVITY = 1.4;
// The loudest column is measured against a peak follower that decays over this many seconds.
const FOLLOW_TAU = 5;
const FOLLOW_FLOOR = 0.25;

const VS = `${DOT_PRELUDE}
uniform vec2 uOrigin;
uniform float uPitch;
uniform int uCols;
uniform int uRows;
uniform float uReach;
uniform int uMirror;
uniform vec4 uHeights[${MAX_COLS / 4}];
uniform vec4 uPeaks[${MAX_COLS / 4}];
void main() {
  int n = uCols * uRows;
  int col = gl_InstanceID < n ? gl_InstanceID % uCols : gl_InstanceID - n;
  float fc = float(col) / float(uCols - 1);
  float u = uMirror == 1 ? abs(fc * 2.0 - 1.0) : fc;
  float reach = uReach;
  float height = uHeights[col / 4][col % 4];
  float peak = uPeaks[col / 4][col % 4];
  if (gl_InstanceID < n) {
    float row = float(gl_InstanceID / uCols);
    float lit = clamp(height * reach - row, 0.0, 1.0);
    lit = lit * lit * (3.0 - 2.0 * lit);
    float wave = beatWave(u, 1.5, 0.12, 1.6);
    float r = mix(0.12, 0.32 + 0.07 * wave, lit);
    vec2 c = uOrigin + vec2(float(col), row) * uPitch;
    vec3 hue = pal(u * 1.3 + (row / reach) * 0.7);
    // Behind the words the columns thin to a veil so the text keeps its ground.
    float veil = mix(1.0, 0.35, hushAt(c));
    if (uLight > 0.5) emit(c, r * uPitch, ink(hue), mix(0.2, 0.92, lit) * (0.8 + 0.2 * uRms) * veil, 0.0);
    else emit(c, r * uPitch, hue * mix(0.28, 1.0, lit) * (0.5 + 0.7 * uRms) * veil, 1.0, 0.6 * lit);
    return;
  }
  float above = (peak - height) * reach;
  if (peak < 0.03 || above < 0.15) { hide(); return; }
  vec2 c = uOrigin + vec2(float(col), peak * reach - 0.5) * uPitch;
  vec3 hue = pal(u * 1.3 + peak * 0.7);
  float a = 0.6 * smoothstep(0.15, 1.2, above);
  if (uLight > 0.5) emit(c, 0.2 * uPitch, ink(hue), a, 0.0);
  else emit(c, 0.2 * uPitch, hue * (0.5 + 0.7 * uRms), a, 0.3);
}`;

/** Samples a band list at `m` in 0..1 with linear interpolation. */
function sample(bands: ArrayLike<number>, m: number): number {
  const last = bands.length - 1;
  const f = m * last;
  const i = Math.min(last - 1, Math.floor(f));
  const k = f - i;
  return bands[i] * (1 - k) + bands[i + 1] * k;
}

export function createDotSpectrum(kit: Kit): Candidate {
  const dots = createDots(kit);
  const env = new Float32Array(MAX_COLS);
  const heights = new Float32Array(MAX_COLS);
  const peaks = new Float32Array(MAX_COLS);
  const fall = new Float32Array(MAX_COLS);
  const hold = new Float32Array(MAX_COLS);
  let follow = FOLLOW_FLOOR;
  let shape = "";

  // Advances each column's envelope and its decay dot. A still frame settles them at once.
  const step = (f: Frame, cols: number, mirrored: boolean) => {
    const key = `${cols}:${mirrored}`;
    if (key !== shape) {
      shape = key;
      env.fill(0);
      peaks.fill(0);
      fall.fill(0);
      hold.fill(0);
    }
    const bands = f.fine ?? f.sig.bands;
    let loudest = 0;
    for (let c = 0; c < cols; c++) {
      const fc = c / (cols - 1);
      const v = sample(bands, mirrored ? Math.abs(fc * 2 - 1) : fc);
      env[c] = f.still ? v : easeEnvelope(env[c], v, f.dt, v > env[c] ? MOTION_ATTACK_SECS : RELEASE);
      loudest = Math.max(loudest, env[c]);
    }
    follow = Math.max(loudest, f.still ? loudest : follow * Math.exp(-f.dt / FOLLOW_TAU), FOLLOW_FLOOR);
    for (let c = 0; c < cols; c++) {
      const h = Math.min(1, (env[c] / follow) ** GAMMA * 0.94);
      heights[c] = h;
      if (h >= peaks[c]) {
        peaks[c] = h;
        fall[c] = 0;
        hold[c] = HOLD;
      } else if (hold[c] > 0) {
        hold[c] -= f.dt;
      } else {
        fall[c] += GRAVITY * f.dt;
        peaks[c] = Math.max(h, peaks[c] - fall[c] * f.dt);
      }
    }
  };

  return {
    mode: "glow",
    bloom: 0.55,
    exposure: 1.35,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      const { w: W, h: H, dpr } = kit.size;
      const { mask, cover } = kit.geo;
      const base = (f.ambient ? PITCH_AMBIENT : PITCH_PLAYER) * dpr;
      // The matrix fills its stage: the Player's hero column, or the whole canvas in ambient.
      const left = mask && !f.ambient ? mask[0] + SIDE_INSET * dpr : 0;
      const right = mask && !f.ambient ? mask[0] + mask[2] - SIDE_INSET * dpr : W;
      const cols = Math.max(2, Math.min(MAX_COLS, Math.round((right - left) / base)));
      // The pitch flexes slightly so the columns land flush on both edges.
      const pitch = (right - left) / cols;
      const floor = dots.floorY();
      const ceiling = mask && !f.ambient ? mask[1] + mask[3] : H;
      const rows = Math.max(4, Math.floor((ceiling - floor) / pitch));
      // The lit waves keep their own scale: the Player's reach the cover's centre, ambient's most of the stage.
      const top = f.ambient ? floor + (H - floor) * AMBIENT_REACH : cover[1] + cover[3] * 0.5;
      const reach = Math.min(rows, Math.max(4, Math.floor((top - floor) / base)));
      step(f, cols, f.mirrored);
      const p = kit.program("dotSpectrum", VS, DOT_FS);
      dots.begin(p, f);
      kit.set2(p, "uOrigin", left + pitch * 0.5, floor + pitch * 0.5);
      kit.set1(p, "uPitch", pitch);
      kit.seti(p, "uCols", cols);
      kit.seti(p, "uRows", rows);
      kit.set1(p, "uReach", reach);
      kit.seti(p, "uMirror", f.mirrored ? 1 : 0);
      kit.gl.uniform4fv(kit.uniform(p, "uHeights"), heights);
      kit.gl.uniform4fv(kit.uniform(p, "uPeaks"), peaks);
      dots.draw(cols * rows + cols, !f.light);
    },
    dispose() {
      dots.dispose();
    },
  };
}
