/*
 * The signal every WebGL visualizer reads, derived in the webview from the engine's 24 bands and level
 * frame. Bands, rms and peak get the Player's fast-attack, slow-decay ballistics per display frame. The
 * beat comes from the bands alone: a bass-weighted rise between engine frames, held against an adaptive
 * threshold over the last second.
 *
 * Photosensitivity: `level` (rms eased over about a second) and `loudness` (the rms in dBFS eased over
 * LOUDNESS_TAU) are the steady brightness drivers; their time constants keep them far below the 3 Hz
 * flash limit. `swell` (the bass eased like `level`) drives slow motion. `beat` and `beatWeight` fire at
 * most BEAT_MAX_PER_SEC times a second, so light hung on them stays within three flashes a second. The
 * hit envelopes are not rate-capped: several can rise from rest within one second, so they drive motion
 * and small features, never large-area light. The beat pulse `kick` is motion only.
 *
 * Motion has its own faster channel: a fast-attack, medium-release envelope per band group and a
 * rate-capped beat event, both scaled by the reactivity level. Beside it sit the transient fields, scaled
 * the same way: a hit envelope per band group that rests between hits, a weight for each beat, and rare
 * loudness shift events. Calm zeroes all of them, so every visualizer falls back to its slow eased
 * motion alone.
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
  // rms eased over LEVEL_TAU: a brightness driver, pinned near the top on loud masters.
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
  // Absolute loudness in 0..1: the rms in dBFS through a fixed window, eased over LOUDNESS_TAU. Live
  // under Calm like `level`, and the brightness driver that tells a quiet master from a loud one.
  loudness: number;
  // Per band group, a transient envelope: near 0 between hits on steady music, near 1 on a clear hit
  // before the reactivity gain, so up to 1.6 under Lively. Not clamped after the gain; 0 under Calm.
  // Not rate-capped: motion and small features only, never large-area light.
  bassHit: number;
  midHit: number;
  highHit: number;
  // How much a beat deserves to show: high for a loud, bass-led onset that stands out from the recent
  // ones. It starts on the frame `beat` fires with the bass measured so far, is held on every display
  // frame for that engine frame and the next WEIGHT_BASS_LAG_EMITS, at most WEIGHT_SPAN_SECS, only rises
  // within a beat as the kick's bass lands, then reads 0 until the next beat. Take it with a peak-follow;
  // a one-shot reaction that needs the final weight reads the last nonzero frame. A display slower than
  // the engine skips the frames it never reads, so its final weights can differ. 0..1 times the
  // reactivity gain, not clamped after it; capped in rate with `beat`.
  beatWeight: number;
  // A loudness shift on the frame it is detected, else 0: `surge` when the loudness jumps well above the
  // last few seconds (a drop landing), `cut` when it falls well below them. Rare, 0..1 times the gain.
  surge: number;
  cut: number;
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

// Loudness: the dBFS window mapped onto 0..1, and its ease. Sources that send no dBFS value get it back
// from the unit rms through the engine's own -60..-10 dBFS window.
const LOUDNESS_FLOOR_DB = -33;
const LOUDNESS_CEIL_DB = -6;
const LOUDNESS_TAU = 0.6;
const UNIT_FLOOR_DB = -60;
const UNIT_SPAN_DB = 50;

// Engine frames a second, for state that steps once per emit.
const EMITS_PER_SEC = 30;

// Hits: a group's rise over the lowest of its last few frames, against its recent biggest rise. A rise
// under the dead share of that scale reads as none, and the full share reads as a full hit. The scale
// stays between the floor and the ceiling, so an entry from silence does not mute the hits after it. The
// hit fades out under the loudness gate and while the group sits near the bottom of the band window, so
// noise in a quiet passage or an empty band stays small. After playback starts or resumes, hits and the
// scale wait out the warm-up, so a zero or stale frame in the memory never reads as a hit.
const HIT_MEMORY = 2;
const HIT_SCALE_TAU = 4;
const HIT_SCALE_FLOOR = 0.15;
const HIT_SCALE_CEIL = 0.5;
const HIT_DEAD_SHARE = 0.3;
const HIT_FULL_SHARE = 0.6;
const HIT_LOUD_GATE = 0.4;
// Per group, the raw level a hit starts to count from and the level it counts in full; the highs sit
// lower in the band window than the bass and mids.
const HIT_PRESENCE: readonly (readonly [number, number])[] = [
  [0.1, 0.3],
  [0.1, 0.3],
  [0.03, 0.1],
];
const HIT_ATTACK_SECS = 0.012;
const HIT_RELEASE_SECS = 0.06;
const HIT_WARM_EMITS = 5;

// Beat weight: the passage's loudness from the low to the high end of this span scales it in, and the
// bass lead carries the bass share of it. The loudness here is its own fast ease, seeded when playback
// starts or resumes, so the first beats back are not weighed against the slow public `loudness`. The
// bass lead is the biggest bass rise on the onset's own frame and the lag frames after it: on loud
// kicks the bass lands one or two frames after the onset. The weight is re-emitted on each of those
// frames with the lead so far, and the span closes after the lag or after its time bound, whichever
// comes first, so a stall in the feed cannot hold it. An onset weaker than the mean of the recent ones
// is scaled down by its share of that mean.
const WEIGHT_LOUD_LOW = 0.2;
const WEIGHT_LOUD_HIGH = 0.7;
const WEIGHT_LOUD_TAU = 0.1;
const WEIGHT_BASS_SHARE = 0.75;
export const WEIGHT_BASS_LAG_EMITS = 2;
export const WEIGHT_SPAN_SECS = 0.15;
const WEIGHT_ONSET_MEMORY = 8;

// Loudness shifts: the mean loudness of the last half second against the two seconds before it. A gap
// past the threshold fires once, then the detector waits for the gap to close and for the hold before
// it may fire that way again. A surge also needs the half second after it to be clearly audible, so a
// near-silent tail never reads as a landing. Its strength is the larger of that gap and the newest few
// frames' gap, so a sharp shift fires stronger than a gradual one; the full gap reads 1.
const SHIFT_AFTER_EMITS = 15;
const SHIFT_SURGE_FLOOR = 0.25;
const SHIFT_BEFORE_EMITS = 60;
const SHIFT_NEWEST_EMITS = 3;
const SHIFT_THRESHOLD = 0.24;
const SHIFT_FULL = 0.7;
const SHIFT_HOLD_SECS = 4;

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
    loudness: 0.3,
    bassHit: 0,
    midHit: 0,
    highHit: 0,
    beatWeight: 0,
    surge: 0,
    cut: 0,
  };
}

/**
 * The loudness a level frame implies, in 0..1, before easing: its dBFS value, or the unit rms's when the
 * dBFS value is absent or not finite.
 */
export function frameLoudness(level: Pick<LevelFrame, "rms" | "rmsDb">): number {
  const finite = level.rmsDb !== undefined && Number.isFinite(level.rmsDb);
  const db = finite ? (level.rmsDb as number) : UNIT_FLOOR_DB + UNIT_SPAN_DB * level.rms;
  return Math.min(1, Math.max(0, (db - LOUDNESS_FLOOR_DB) / (LOUDNESS_CEIL_DB - LOUDNESS_FLOOR_DB)));
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
    loudness: 0,
    bassHit: 0,
    midHit: 0,
    highHit: 0,
    beatWeight: 0,
    surge: 0,
    cut: 0,
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
  let loudRaw = 0;
  // Per band group: the last few raw levels, the recent biggest rise, and the hit's target and envelope.
  const hitMemory = [0, 1, 2].map(() => [] as number[]);
  const hitScale = [HIT_SCALE_FLOOR, HIT_SCALE_FLOOR, HIT_SCALE_FLOOR];
  const hitRaw = [0, 0, 0];
  const hitEnv = [0, 0, 0];
  // Seeded from the first playing frame, so a track started mid-song does not ease up from silence.
  let loudSeeded = false;
  // Playing emits since playback last started or resumed, and the beat weight's fast loudness.
  let runEmits = 0;
  let loudFast = 0;
  let weightRaw = 0;
  // A beat's open span: its weight before the bass term, the lead so far, the emits left and its start.
  let weightPending = false;
  let weightBase = 0;
  let weightLead = 0;
  let weightLeft = 0;
  let weightStart = 0;
  const onsets: number[] = [];
  // The shift detector's loudness per emit, emptied on pause so a resume never reads as a shift.
  const shiftLoud: number[] = [];
  const shiftArmed = [true, true];
  const shiftLast = [-Infinity, -Infinity];
  const shiftRaw = [0, 0];

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

    // Paused, the loudness settles where the level does, as it does on a still frame.
    loudRaw = playing ? frameLoudness(level) : pausedLevel.rms;
    if (playing && !loudSeeded) {
      loudSeeded = true;
      signal.loudness = loudRaw;
    }
    runEmits = playing ? runEmits + 1 : 0;
    const fastStep = 1 - Math.exp(-1 / (EMITS_PER_SEC * WEIGHT_LOUD_TAU));
    loudFast = runEmits === 1 ? loudRaw : loudFast + (loudRaw - loudFast) * fastStep;
    const warm = runEmits > HIT_WARM_EMITS;
    const gate = Math.min(1, loudRaw / HIT_LOUD_GATE);
    let bassLead = 0;
    const scaleDecay = Math.exp(-1 / (EMITS_PER_SEC * HIT_SCALE_TAU));
    for (let g = 0; g < 3; g++) {
      const memory = hitMemory[g];
      const rise = warm && memory.length > 0 ? Math.max(0, groupRaw[g] - Math.min(...memory)) : 0;
      const grown = Math.max(Math.min(rise, HIT_SCALE_CEIL), hitScale[g] * scaleDecay);
      hitScale[g] = Math.max(HIT_SCALE_FLOOR, grown);
      const norm = Math.min(1, Math.max(0, (rise / hitScale[g] - HIT_DEAD_SHARE) / (HIT_FULL_SHARE - HIT_DEAD_SHARE)));
      const [low, full] = HIT_PRESENCE[g];
      const presence = Math.min(1, Math.max(0, (groupRaw[g] - low) / (full - low)));
      // The beat weight's bass lead has no dead share: a kick that barely clears a busy bass still counts.
      if (g === 0) bassLead = Math.min(1, rise / (hitScale[g] * HIT_FULL_SHARE)) * presence;
      hitRaw[g] = norm * presence * gate;
      memory.push(groupRaw[g]);
      if (memory.length > HIT_MEMORY) memory.shift();
      if (!playing) memory.length = 0;
    }
    if (weightPending) {
      if (weightLeft > 0) {
        weightLead = Math.max(weightLead, bassLead);
        weightLeft--;
      } else {
        weightPending = false;
      }
    }
    if (beatRaw > 0) {
      const loud = Math.min(1, Math.max(0, (loudFast - WEIGHT_LOUD_LOW) / (WEIGHT_LOUD_HIGH - WEIGHT_LOUD_LOW)));
      const mean = onsets.length > 0 ? onsets.reduce((a, b) => a + b, 0) / onsets.length : onset;
      const standout = mean > 0 ? Math.min(1, onset / mean) : 1;
      weightPending = true;
      weightBase = loud * standout;
      weightLead = bassLead;
      weightLeft = WEIGHT_BASS_LAG_EMITS;
      weightStart = clock;
    }
    weightRaw = weightPending ? weightBase * (1 - WEIGHT_BASS_SHARE + WEIGHT_BASS_SHARE * weightLead) : 0;
    if (strength > 0) {
      onsets.push(onset);
      if (onsets.length > WEIGHT_ONSET_MEMORY) onsets.shift();
    }

    if (!playing) {
      shiftLoud.length = 0;
      weightPending = false;
      weightRaw = 0;
      return;
    }
    shiftLoud.push(loudRaw);
    if (shiftLoud.length > SHIFT_BEFORE_EMITS + SHIFT_AFTER_EMITS) shiftLoud.shift();
    if (shiftLoud.length < SHIFT_BEFORE_EMITS + SHIFT_AFTER_EMITS) return;
    let before = 0;
    let after = 0;
    let newest = 0;
    for (let i = 0; i < shiftLoud.length; i++) {
      if (i < SHIFT_BEFORE_EMITS) before += shiftLoud[i];
      else after += shiftLoud[i];
      if (i >= shiftLoud.length - SHIFT_NEWEST_EMITS) newest += shiftLoud[i];
    }
    before /= SHIFT_BEFORE_EMITS;
    after /= SHIFT_AFTER_EMITS;
    newest /= SHIFT_NEWEST_EMITS;
    // Index 0 is a surge, 1 a cut.
    const gaps = [after - before, before - after];
    const sharp = [newest - before, before - newest];
    for (let d = 0; d < 2; d++) {
      if (gaps[d] < SHIFT_THRESHOLD / 2) shiftArmed[d] = true;
      const audible = d === 1 || after >= SHIFT_SURGE_FLOOR;
      if (!shiftArmed[d] || !audible || gaps[d] <= SHIFT_THRESHOLD) continue;
      // A shift inside the hold is spent without firing, so it never fires late once the hold ends.
      shiftArmed[d] = false;
      if (clock - shiftLast[d] < SHIFT_HOLD_SECS) continue;
      shiftLast[d] = clock;
      if (gain > 0) shiftRaw[d] = Math.min(1, Math.max(gaps[d], sharp[d]) / SHIFT_FULL);
    }
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
    if (weightPending && clock - weightStart > WEIGHT_SPAN_SECS) {
      weightPending = false;
      weightRaw = 0;
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

    signal.loudness = easeEnvelope(signal.loudness, loudRaw, dt, LOUDNESS_TAU);
    for (let g = 0; g < 3; g++) {
      hitEnv[g] = easeEnvelope(hitEnv[g], hitRaw[g], dt, hitRaw[g] > hitEnv[g] ? HIT_ATTACK_SECS : HIT_RELEASE_SECS);
    }
    signal.bassHit = hitEnv[0] * gain;
    signal.midHit = hitEnv[1] * gain;
    signal.highHit = hitEnv[2] * gain;
    signal.beatWeight = weightRaw * gain;
    signal.surge = shiftRaw[0] * gain;
    signal.cut = shiftRaw[1] * gain;
    shiftRaw[0] = 0;
    shiftRaw[1] = 0;
    return signal;
  };

  return { signal, step };
}
