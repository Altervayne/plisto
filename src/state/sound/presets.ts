/*
 * The EQ presets and the pure edits the Sound controls make on a settings value. Every edit returns a new
 * value; the stored preset name follows the gains, so a hand edit that lands on a preset selects it and
 * any other curve reads Custom.
 */

// -- Utils Imports --
import { BAND_COUNT, GAIN_MAX_DB, GAIN_MIN_DB, PREAMP_MAX_DB, PREAMP_MIN_DB } from "./settings";

// -- Type Imports --
import type { SoundSettings } from "./settings";

export const PRESET_KEYS = ["flat", "bass", "treble", "vocal", "loudness"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];
export type PresetChoice = PresetKey | "custom";

/** One gain per band, low to high. */
export const PRESET_GAINS: Record<PresetKey, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 4.5, 2, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 1.5, 3, 4.5, 5.5],
  vocal: [-2, -1, 1, 3, 3.5, 2, 0, -1],
  loudness: [5, 3, 0, -1, -1, 0, 2.5, 4],
};

/** Gain resolution of the handles. */
export const GAIN_STEP_DB = 0.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function isFlat(gains: readonly number[]): boolean {
  return gains.every((g) => g === 0);
}

/** The preset whose table equals `gains`, else "custom". */
export function detectPreset(gains: readonly number[]): PresetChoice {
  const match = PRESET_KEYS.find((key) => PRESET_GAINS[key].every((g, i) => g === gains[i]));
  return match ?? "custom";
}

/** Whether the EQ is changing the sound: on, with a curve that is not flat. */
export function isShaped(s: SoundSettings): boolean {
  return s.eq.on && !isFlat(s.eq.gains);
}

/** Whether Reset has anything to undo: a shaped curve or a non-zero preamp. */
export function canReset(s: SoundSettings): boolean {
  return !isFlat(s.eq.gains) || s.preampDb !== 0;
}

export function setEqOn(s: SoundSettings, on: boolean): SoundSettings {
  return { ...s, eq: { ...s.eq, on } };
}

export function applyPreset(s: SoundSettings, key: PresetKey): SoundSettings {
  return { ...s, eq: { ...s.eq, preset: key, gains: PRESET_GAINS[key].slice() } };
}

/** Moves one band, snapped to the step and clamped; the preset follows the new curve. */
export function setBandGain(s: SoundSettings, band: number, gainDb: number): SoundSettings {
  if (band < 0 || band >= BAND_COUNT) return s;
  const snapped = clamp(Math.round(gainDb / GAIN_STEP_DB) * GAIN_STEP_DB, GAIN_MIN_DB, GAIN_MAX_DB);
  const gains = s.eq.gains.slice();
  gains[band] = snapped;
  return { ...s, eq: { ...s.eq, preset: detectPreset(gains), gains } };
}

export function setPreampDb(s: SoundSettings, preampDb: number): SoundSettings {
  return { ...s, preampDb: clamp(preampDb, PREAMP_MIN_DB, PREAMP_MAX_DB) };
}

/** Flat curve and a zero preamp; the on switch and the levelling mode stay as they are. */
export function resetSound(s: SoundSettings): SoundSettings {
  return { ...s, eq: { ...s.eq, preset: "flat", gains: PRESET_GAINS.flat.slice() }, preampDb: 0 };
}
