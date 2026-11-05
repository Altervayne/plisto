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
 *
 * Motion has its own faster channel, which never touches brightness: a fast-attack, medium-release
 * envelope per band group and a rate-capped beat event, both scaled by the reactivity level. Calm zeroes
 * the whole channel, so every visualizer falls back to its slow eased motion alone.
 */

// -- Type Imports --
import { BAND_COUNT, type LevelFrame } from "../../types";
import type { Reactivity } from "./visualizerKind";

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
  // The motion channel: never brightness, all zero under Calm. Per band group, an envelope of the
  // group's rise over its recent mean, scaled by the reactivity gain.
  bassMotion: number;
  midMotion: number;
  highMotion: number;
  // A beat's strength on the frame it fires, else 0: rate-capped, scaled by the reactivity gain.
  beat: number;
  // The reactivity gain itself, for motion terms that are not an envelope: 0 under Calm.
  drive: number;
}

/** What the follower reads from the feed on one display frame. */
export interface SignalInput {
  // The latest raw engine frame; a new array identity marks a new emit.
  bands: number[];
  level: LevelFrame;
  playing: boolean;
  // Absent reads Balanced, the pref's default.
  reactivity?: Reactivity;
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

// The motion channel. Each group's envelope chases its rise over a slow mean of itself, so a steady
// passage sits low and every hit stands out; the attack is fast, the release set per reactivity level.
export const MOTION_ATTACK_SECS = 0.05;
const MOTION_MEAN_TAU = 1.5;
// The share of the mean a group must clear before it moves anything, and the gain on what clears it.
const MOTION_GATE = 0.75;
const MOTION_CONTRAST = 2.5;

// Beat events: at least this far apart, and never more than this many in any one second, so a busy
// passage still reads as a pulse rather than a flutter.
export const BEAT_MIN_GAP_SECS = 0.3;
export const BEAT_MAX_PER_SEC = 3;

/** What a reactivity level does to the motion channel: its gain, and the envelopes' release in seconds. */
export interface ReactivityProfile {
  gain: number;
  release: number;
}

export const REACTIVITY_PROFILES: Record<Reactivity, ReactivityProfile> = {
  calm: { gain: 0, release: 0.4 },
  balanced: { gain: 1, release: 0.4 },
  lively: { gain: 1.6, release: 0.3 },
};

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
    bassMotion: 0,
    midMotion: 0,
    highMotion: 0,
    beat: 0,
    drive: 0,
  };
}

/** One step of a first-order ease toward `target` over `dt` seconds, with time constant `tau`. */
export function easeEnvelope(prev: number, target: number, dt: number, tau: number): number {
  return prev + (target - prev) * (1 - Math.exp(-dt / tau));
}

/** One step of a motion envelope: the fast attack toward a rise, `release` seconds back down. */
export function motionEnvelope(prev: number, target: number, dt: number, release: number): number {
  return easeEnvelope(prev, target, dt, target > prev ? MOTION_ATTACK_SECS : release);
}

/**
 * Whether an onset at `now` may fire a beat event, given the times of the events already fired: the
 * last must be at least the minimum gap ago, and the past second must hold fewer than the cap.
 */
export function admitBeat(fired: readonly number[], now: number): boolean {
  if (fired.length > 0 && now - fired[fired.length - 1] < BEAT_MIN_GAP_SECS) return false;
  let inWindow = 0;
  for (const t of fired) if (now - t < 1) inWindow++;
  return inWindow < BEAT_MAX_PER_SEC;
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

function groupLevel(bands: ArrayLike<number>, lo: number, hi: number): number {
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += bands[i];
  return sum / (hi - lo);
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
    bassMotion: 0,
    midMotion: 0,
    highMotion: 0,
    beat: 0,
    drive: 0,
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
  // Per band group: the raw level, its slow mean, and the motion envelope.
  const groupRaw = [0, 0, 0];
  const groupMean = [0, 0, 0];
  const groupEnv = [0, 0, 0];
  const fired: number[] = [];
  let beatRaw = 0;
  let gain = REACTIVITY_PROFILES.balanced.gain;

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
      if (gain > 0 && admitBeat(fired, clock)) {
        fired.push(clock);
        if (fired.length > BEAT_MAX_PER_SEC) fired.shift();
        beatRaw = strength;
      }
    }
    groupRaw[0] = groupLevel(raw, 0, BASS_END);
    groupRaw[1] = groupLevel(raw, BASS_END, MID_END);
    groupRaw[2] = groupLevel(raw, MID_END, BAND_COUNT);
  };

  const step = (dt: number, input: SignalInput): VisualSignal => {
    const profile = REACTIVITY_PROFILES[input.reactivity ?? "balanced"];
    gain = profile.gain;
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

    for (let g = 0; g < 3; g++) {
      groupMean[g] = easeEnvelope(groupMean[g], groupRaw[g], dt, MOTION_MEAN_TAU);
      const rise = resting ? 0 : Math.min(1, Math.max(0, (groupRaw[g] - groupMean[g] * MOTION_GATE) * MOTION_CONTRAST));
      groupEnv[g] = motionEnvelope(groupEnv[g], rise, dt, profile.release);
    }
    signal.bassMotion = groupEnv[0] * gain;
    signal.midMotion = groupEnv[1] * gain;
    signal.highMotion = groupEnv[2] * gain;
    signal.beat = beatRaw * gain;
    signal.drive = gain;
    beatRaw = 0;
    return signal;
  };

  return { signal, step };
}
