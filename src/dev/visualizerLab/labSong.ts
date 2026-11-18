/*
 * A fixed 40-bar test song at 120 bpm: a quiet intro, a build that ends in a snare roll and a gap, a loud
 * drop with dense hits, and a breakdown. Every variation is a hash of the bar and step, so the same start
 * gives the same frames. The synthesized bands go through the app's signal follower, so envelopes and beats
 * are the real ones.
 */

// -- State Imports --
import { createSignalFollower, type VisualSignal } from "../../state/player/visualSignal";
import { smoothBands } from "../../state/player/spectrum";
import type { Reactivity } from "../../state/player/visualizerKind";

// -- Local Imports --
import { FINE_ATTACK, FINE_DECAY, widen } from "./labMusic";

// -- Type Imports --
import { BAND_COUNT, FINE_BAND_COUNT, type LevelFrame } from "../../types";

const FEED_HZ = 30;
const STEP = 60 / 120 / 4;
const BAR = STEP * 16;

type Part = "intro" | "build" | "drop" | "breakdown";

// First bar and length of each part.
const PARTS: [Part, number, number][] = [
  ["intro", 0, 8],
  ["build", 8, 8],
  ["drop", 16, 16],
  ["breakdown", 32, 8],
];
const SONG_BARS = 40;

/** Where the drop starts, in song seconds. */
export const DROP_START = (PARTS.find(([name]) => name === "drop")?.[1] ?? 0) * BAR;

/** The song's length in seconds; past it the arrangement loops. */
export const SONG_SECONDS = SONG_BARS * BAR;

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

function partAt(bar: number): { name: Part; at: number; len: number } {
  const b = bar % SONG_BARS;
  for (const [name, first, len] of PARTS) if (b < first + len) return { name, at: b - first, len };
  return { name: "intro", at: 0, len: 8 };
}

/** The velocity of an instrument's hit on a sixteenth of a bar, 0 for none. Kick 0, snare 1, hat 2, bass 3. */
function hit(inst: number, bar: number, step: number): number {
  const { name, at, len } = partAt(bar);
  const r = hash(bar * 31 + step * 7 + inst * 3);
  const p = at / len;
  const lastBar = at === len - 1;
  if (inst === 0) {
    if (name === "intro") return at >= 4 && step === 0 ? 0.4 : 0;
    if (name === "build") return step % 4 === 0 && !(lastBar && step === 12) ? 0.5 + 0.4 * p : 0;
    if (name === "drop") {
      if (step % 4 === 0) return 0.92 + 0.08 * r;
      if (step === 14 && hash(bar * 13) > 0.5) return 0.6;
      if (at % 4 === 3 && step === 10) return 0.7;
    }
    return 0;
  }
  if (inst === 1) {
    if (name === "build") {
      if (lastBar) return step < 12 ? 0.6 + step / 30 : 0;
      if (at === 6) return step % 2 === 0 ? 0.55 + step / 40 : 0;
      if (at >= 4) return step % 4 === 0 ? 0.55 : 0;
      return step === 4 || step === 12 ? 0.5 : 0;
    }
    if (name === "drop") return step === 4 || step === 12 ? 0.9 + 0.1 * r : step === 15 && r > 0.6 ? 0.4 : 0;
    return 0;
  }
  if (inst === 2) {
    if (name === "intro") return step % 4 === 2 ? 0.25 : 0;
    if (name === "build") return step % 2 === 0 ? 0.3 + (step % 4 === 2 ? 0.15 : 0) : 0;
    if (name === "drop") return 0.35 + (step % 4 === 2 ? 0.35 : 0) + 0.15 * r;
    return step % 4 === 0 ? 0.25 : 0;
  }
  if (name === "intro") return step === 0 ? 0.45 : 0;
  if (name === "build") return step % 8 === 0 ? 0.6 : 0;
  if (name === "drop") return step % 4 === 2 || step === 7 || step === 15 ? 0.9 : 0;
  return step === 0 ? 0.55 : 0;
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

const PAD_LEVEL: Record<Part, number> = { intro: 0.55, build: 0.45, drop: 0.3, breakdown: 0.75 };

function synth(t: number, out: number[]): void {
  const bar = Math.floor(t / BAR);
  const song = partAt(bar);
  const inBar = (t / BAR) % 1;
  const kick = envelope(0, t, 7);
  const snare = envelope(1, t, 9);
  const hat = envelope(2, t, 28);
  const bass = envelope(3, t, 3.5);
  const padLevel = PAD_LEVEL[song.name] * (0.85 + 0.15 * Math.sin(t * 1.7));
  const chord = CHORDS[bar % 4];
  const note = BASS_NOTES[bar % 4];
  const sweepOn = song.name === "build";
  const sweepP = sweepOn ? (song.at + inBar) / song.len : 0;
  const loud = { intro: 0.5, build: 0.6 + 0.45 * sweepP, drop: 1.12, breakdown: 0.55 }[song.name];
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

/** One display frame of the song. The signal is the follower's own object, rewritten on each step. */
export interface SongFrame {
  sig: VisualSignal;
  // The 128-band spectrum, eased the way the app eases it, for the kinds that draw from it.
  fine: number[];
  bands: number[];
  level: LevelFrame;
}

export interface LabSong {
  step: (dt: number) => SongFrame;
}

/** A fresh song starting `startAt` seconds in, followed at the given reactivity. */
export function createLabSong(startAt: number, reactivity: Reactivity): LabSong {
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
      const sig = follower.step(dt, { bands, level, playing: true, reactivity });
      fine = smoothBands(fine, fineRaw, FINE_ATTACK, FINE_DECAY);
      return { sig, fine, bands, level };
    },
  };
}
