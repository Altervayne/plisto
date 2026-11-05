/*
 * The signal every WebGL visualizer reads, derived in the webview from the engine's 24 bands and level
 * frame. Bands, rms and peak get the Player's fast-attack, slow-decay ballistics per display frame. The
 * beat comes from the bands alone: a bass-weighted rise between engine frames, held against an adaptive
 * threshold over the last second.
 *
 * Photosensitivity: `level` (rms eased over about a second) is the only value allowed to drive
 * brightness, and `swell` (the bass eased the same way) drives slow motion. The beat pulse `kick` may
 * move or scale things but never changes brightness. Both time constants keep their response far below
 * the 3 Hz flash limit.
 */

// -- Type Imports --
import { BAND_COUNT, type LevelFrame } from "../../types";

/** One display frame of the derived signal. */
export interface VisualSignal {
  bands: Float32Array;
  rms: number;
  peak: number;
  // The engine's onset flux, held briefly so a single frame's rise survives to the next draw.
  flux: number;
  // The beat pulse: jumps on an onset, decays fast. Motion only, never brightness.
  kick: number;
  bass: number;
  mid: number;
  high: number;
  // rms eased over LEVEL_TAU: the one brightness driver.
  level: number;
  // The bass eased over SWELL_TAU: slow motion.
  swell: number;
}

/** What the follower reads from the feed on one display frame. */
export interface SignalInput {
  // The latest raw engine frame; a new array identity marks a new emit.
  bands: number[];
  level: LevelFrame;
  playing: boolean;
}

const ATTACK = 0.5;
const DECAY = 0.15;
const RMS_ATTACK = 0.35;
const RMS_DECAY = 0.08;
const PEAK_ATTACK = 0.6;
const PEAK_DECAY = 0.1;
export const LEVEL_TAU = 0.9;
export const SWELL_TAU = 1.1;
const KICK_DECAY = 5.5;
const FLUX_DECAY = 8;

// The engine emits about thirty frames a second; the onset threshold averages one second of them.
const FLUX_HISTORY = 30;
const ONSET_RATIO = 1.4;
const ONSET_FLOOR = 0.06;
// Two onsets closer than this read as one hit.
const ONSET_GAP_SECS = 0.18;

// Band ranges for the bass, mid and high groups.
const BASS_END = 5;
const MID_END = 15;

// Paused, the bands settle onto the resting arch at this fraction, so the visualizers keep their idle
// motion instead of freezing.
const PAUSED_REST = 0.6;

/** The calm resting arch, tallest in the middle: the still-frame and paused shape. */
export function restingBands(): Float32Array {
  return Float32Array.from({ length: BAND_COUNT }, (_, i) => 0.06 + 0.1 * Math.sin((Math.PI * i) / (BAND_COUNT - 1)));
}

/** A fixed resting signal for still frames: the arch, no flux, no beat. */
export function restSignal(): VisualSignal {
  return {
    bands: restingBands(),
    rms: 0.3,
    peak: 0.35,
    flux: 0,
    kick: 0,
    bass: 0.1,
    mid: 0.15,
    high: 0.1,
    level: 0.3,
    swell: 0.1,
  };
}

/** One step of a first-order ease toward `target` over `dt` seconds, with time constant `tau`. */
export function easeEnvelope(prev: number, target: number, dt: number, tau: number): number {
  return prev + (target - prev) * (1 - Math.exp(-dt / tau));
}

/**
 * The positive change from one raw band frame to the next, weighted toward the bass so a kick reads
 * louder than a hat, and scaled into 0..1. A length mismatch reads as no change.
 */
export function bandFlux(prev: ArrayLike<number>, next: ArrayLike<number>): number {
  if (prev.length !== next.length) return 0;
  let flux = 0;
  for (let i = 0; i < next.length; i++) {
    const d = next[i] - prev[i];
    if (d > 0) flux += d * (i < 6 ? 1.6 : i < 14 ? 0.8 : 0.5);
  }
  return Math.min(1, flux / 2.2);
}

/**
 * The strength of an onset at `flux`, or 0 for none: the flux must stand clear of the recent mean, and
 * the last onset must be at least the refractory gap ago.
 */
export function onsetStrength(flux: number, history: readonly number[], secsSinceLast: number): number {
  if (secsSinceLast <= ONSET_GAP_SECS) return 0;
  const mean = history.length > 0 ? history.reduce((a, b) => a + b, 0) / history.length : 0;
  if (flux <= mean * ONSET_RATIO + ONSET_FLOOR) return 0;
  return Math.min(1, 0.35 + (flux - mean) * 2.4);
}

/** The rms and peak the bands alone imply, for the paused arch where the engine sends no level. */
function bandLevel(bands: ArrayLike<number>): { rms: number; peak: number } {
  let sq = 0;
  let max = 0;
  for (let i = 0; i < bands.length; i++) {
    sq += bands[i] * bands[i];
    max = Math.max(max, bands[i]);
  }
  return { rms: Math.min(1, Math.sqrt(sq / bands.length) * 1.35), peak: Math.min(1, max * 0.92) };
}

/** A per-surface follower: feed it the latest input each display frame, read the signal back. */
export interface SignalFollower {
  signal: VisualSignal;
  step: (dt: number, input: SignalInput) => VisualSignal;
}

/** Builds a follower starting at rest. */
export function createSignalFollower(): SignalFollower {
  const signal: VisualSignal = {
    bands: new Float32Array(BAND_COUNT),
    rms: 0.2,
    peak: 0.2,
    flux: 0,
    kick: 0,
    bass: 0,
    mid: 0,
    high: 0,
    level: 0.2,
    swell: 0.1,
  };
  const raw = new Float32Array(BAND_COUNT);
  const prevRaw = new Float32Array(BAND_COUNT);
  const pausedArch = restingBands().map((v) => v * PAUSED_REST);
  const pausedLevel = bandLevel(pausedArch);
  const history: number[] = [];
  let lastFrame: number[] | null = null;
  let resting = false;
  let clock = 0;
  let lastOnset = -1;
  let rmsRaw = 0;
  let peakRaw = 0;
  let fluxRaw = 0;

  // Takes one engine frame (or the paused arch) as the new raw target, and runs the onset check on it.
  const feed = (bands: ArrayLike<number>, playing: boolean, level: LevelFrame) => {
    prevRaw.set(raw);
    for (let i = 0; i < BAND_COUNT; i++) raw[i] = i < bands.length ? bands[i] : 0;
    const onset = playing ? bandFlux(prevRaw, raw) : 0;
    rmsRaw = playing ? level.rms : pausedLevel.rms;
    peakRaw = playing ? level.peak : pausedLevel.peak;
    fluxRaw = playing ? level.flux : 0;
    const strength = playing ? onsetStrength(onset, history, clock - lastOnset) : 0;
    history.push(onset);
    if (history.length > FLUX_HISTORY) history.shift();
    if (strength > 0) {
      lastOnset = clock;
      signal.kick = Math.max(signal.kick, strength);
    }
  };

  const step = (dt: number, input: SignalInput): VisualSignal => {
    if (input.playing) {
      clock += dt;
      if (input.bands !== lastFrame) {
        lastFrame = input.bands;
        resting = false;
        feed(input.bands, true, input.level);
      }
    } else if (!resting) {
      resting = true;
      feed(pausedArch, false, input.level);
    }

    const b = signal.bands;
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      b[i] += (raw[i] - b[i]) * (raw[i] > b[i] ? ATTACK : DECAY);
      if (i < BASS_END) lo += b[i];
      else if (i < MID_END) mi += b[i];
      else hi += b[i];
    }
    signal.bass = lo / BASS_END;
    signal.mid = mi / (MID_END - BASS_END);
    signal.high = hi / (BAND_COUNT - MID_END);
    signal.rms += (rmsRaw - signal.rms) * (rmsRaw > signal.rms ? RMS_ATTACK : RMS_DECAY);
    signal.peak += (peakRaw - signal.peak) * (peakRaw > signal.peak ? PEAK_ATTACK : PEAK_DECAY);
    signal.flux = Math.max(signal.flux * Math.exp(-dt * FLUX_DECAY), fluxRaw);
    fluxRaw = 0;
    signal.kick *= Math.exp(-dt * KICK_DECAY);
    signal.level = easeEnvelope(signal.level, signal.rms, dt, LEVEL_TAU);
    signal.swell = easeEnvelope(signal.swell, signal.bass, dt, SWELL_TAU);
    return signal;
  };

  return { signal, step };
}
