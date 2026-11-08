/*
 * A deterministic simulated groove for thumbnail captures: 120 bpm kick, snare, hats, bass and pad voices
 * synthesized straight into the engine's 24 bands, a 128-band spectrum and a level frame, emitted at the
 * engine's 30 Hz. The bands go through the app's own signal follower at Balanced, so envelopes and beats
 * behave as they do live. Same seed, same frames.
 */

// -- State Imports --
import { createSignalFollower, type VisualSignal } from "../../state/player/visualSignal";
import { smoothBands } from "../../state/player/spectrum";

// -- Type Imports --
import { BAND_COUNT, FINE_BAND_COUNT, type LevelFrame } from "../../types";

const FEED_HZ = 30;
const STEP = 60 / 120 / 4;
const LOOP_BARS = 16;
// The fine spectrum's ballistics, matching the 24 bands'.
const FINE_ATTACK = 0.5;
const FINE_DECAY = 0.15;

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

function bump(center: number, width: number, gain = 1): Float32Array {
  return Float32Array.from({ length: BAND_COUNT }, (_, i) => gain * Math.exp(-((i - center) ** 2) / (2 * width * width)));
}

const KICK = bump(1.2, 1.6);
const KICK_CLICK = bump(11, 2.5, 0.3);
const SNARE = bump(12.5, 3.5, 0.9);
const SNARE_AIR = bump(19, 3, 0.5);
const HAT = bump(21.5, 1.8, 0.8);
const CHORDS = [
  [7, 10, 13],
  [6, 9, 14],
  [8, 11, 15],
  [5, 10, 12],
];
const BASS_NOTES = [2.4, 3.6, 2.0, 4.2];

type Section = "intro" | "groove" | "break" | "build";

function section(bar: number): Section {
  const b = bar % LOOP_BARS;
  if (b < 4) return "intro";
  if (b < 12) return "groove";
  if (b < 14) return "break";
  return "build";
}

/** The velocity of an instrument's hit on a sixteenth of a bar, 0 for none. */
function hit(inst: number, bar: number, step: number): number {
  const sec = section(bar);
  const lb = bar % LOOP_BARS;
  const r = hash(bar * 31 + step * 7 + inst * 3);
  if (inst === 0) {
    if (sec === "break") return 0;
    if (sec === "intro") return step === 0 || step === 8 ? 0.6 : 0;
    if (step % 4 === 0) return 0.85 + 0.15 * r;
    if (step === 14 && hash(bar * 13) > 0.6) return 0.55;
    if (lb === 11 && (step === 10 || step === 13 || step === 15)) return 0.7;
    return 0;
  }
  if (inst === 1) {
    if (sec === "groove") return step === 4 || step === 12 ? 0.8 + 0.2 * r : 0;
    if (sec === "build") return lb === 14 ? (step % 4 === 0 ? 0.4 + step / 40 : 0) : step % 2 === 0 ? 0.5 + step / 32 : 0;
    return 0;
  }
  if (inst === 2) {
    if (sec === "break") return step % 4 === 2 ? 0.35 : 0;
    if (sec === "intro") return step % 2 === 0 ? 0.35 + (step % 4 === 2 ? 0.2 : 0) : 0;
    return 0.3 + (step % 4 === 2 ? 0.35 : 0) + 0.15 * r;
  }
  if (sec !== "groove") return 0;
  return step % 4 === 2 || step === 7 || step === 15 ? 0.75 : 0;
}

/** The latest hit at or before time t, decaying since it landed. */
function envelope(inst: number, t: number, rate: number): number {
  const now = Math.floor(t / STEP);
  for (let k = 0; k < 16; k++) {
    const s = now - k;
    if (s < 0) break;
    const vel = hit(inst, Math.floor(s / 16), s % 16);
    if (vel > 0) return vel * Math.exp(-(t - s * STEP) * rate);
  }
  return 0;
}

function synth(t: number, out: number[]): void {
  const bar = Math.floor(t / (STEP * 16));
  const sec = section(bar);
  const inBar = (t / (STEP * 16)) % 1;
  const kick = envelope(0, t, 7);
  const snare = envelope(1, t, 9);
  const hat = envelope(2, t, 28);
  const bass = envelope(3, t, 3.5);
  const padLevel = { intro: 0.5, groove: 0.36, break: 0.7, build: 0.5 }[sec] * (0.85 + 0.15 * Math.sin(t * 1.7));
  const chord = CHORDS[bar % 4];
  const note = BASS_NOTES[bar % 4];
  const sweepOn = sec === "break" || sec === "build";
  const sweepP = sweepOn ? ((bar % LOOP_BARS) - 12 + inBar) / 4 : 0;
  const loud = sec === "break" ? 0.8 : 1;
  for (let i = 0; i < BAND_COUNT; i++) {
    let p = (kick * KICK[i]) ** 2 + (kick * KICK_CLICK[i]) ** 2 + (snare * SNARE[i]) ** 2 + (snare * SNARE_AIR[i]) ** 2 + (hat * HAT[i]) ** 2;
    const bassP = bass * 0.75 * Math.exp(-((i - note) ** 2) / 2.2);
    let pad = 0;
    for (const c of chord) pad += Math.exp(-((i - c) ** 2) / 2.6);
    p += bassP * bassP + (padLevel * 0.45 * pad) ** 2;
    if (sweepOn) {
      const sw = (0.2 + 0.5 * sweepP) * Math.exp(-((i - (4 + 18 * sweepP)) ** 2) / 5);
      p += sw * sw;
    }
    const x = Math.sqrt(p) * loud + 0.05 * vnoise(t * 3 + i * 1.7) * (1 - i / 40);
    out[i] = Math.min(1, 1 - Math.exp(-x * 1.7));
  }
}

/** The 24 bands spread over 128 with a little fine ripple, so the spectrum reads as detail rather than steps. */
function widen(bands: readonly number[], t: number): number[] {
  return Array.from({ length: FINE_BAND_COUNT }, (_, i) => {
    const pos = (i / (FINE_BAND_COUNT - 1)) * (BAND_COUNT - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(BAND_COUNT - 1, lo + 1);
    const v = bands[lo] + (bands[hi] - bands[lo]) * (pos - lo);
    return Math.min(1, Math.max(0, v * (0.82 + 0.36 * vnoise(i * 0.9 + t * 4))));
  });
}

/** One display frame of the simulated feed. */
export interface MusicFrame {
  sig: VisualSignal;
  fine: number[];
  bands: number[];
  level: LevelFrame;
}

export interface LabMusic {
  step: (dt: number) => MusicFrame;
}

/** A fresh groove starting `startAt` seconds in. */
export function createLabMusic(startAt: number): LabMusic {
  const follower = createSignalFollower();
  let clock = startAt;
  let acc = 0;
  let bands: number[] = new Array(BAND_COUNT).fill(0);
  let level: LevelFrame = { rms: 0, peak: 0, flux: 0 };
  let fineRaw: number[] = new Array(FINE_BAND_COUNT).fill(0);
  let fine: number[] = [];

  const feed = () => {
    const next = new Array<number>(BAND_COUNT).fill(0);
    synth(clock, next);
    let flux = 0;
    let sq = 0;
    let max = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const d = next[i] - bands[i];
      if (d > 0) flux += d * (i < 6 ? 1.6 : i < 14 ? 0.8 : 0.5);
      sq += next[i] * next[i];
      max = Math.max(max, next[i]);
    }
    level = { rms: Math.min(1, Math.sqrt(sq / BAND_COUNT) * 1.35), peak: Math.min(1, max * 0.92), flux: Math.min(1, flux / 2.2) };
    bands = next;
    fineRaw = widen(next, clock);
  };

  return {
    step(dt) {
      clock += dt;
      acc += dt;
      while (acc >= 1 / FEED_HZ) {
        acc -= 1 / FEED_HZ;
        feed();
      }
      const sig = follower.step(dt, { bands, level, playing: true, reactivity: "balanced" });
      fine = smoothBands(fine, fineRaw, FINE_ATTACK, FINE_DECAY);
      return { sig, fine, bands, level };
    },
  };
}
