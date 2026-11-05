/*
 * The `sound` kv blob: EQ, preamp, and levelling mode. Mirrors `src-tauri/src/sound_settings.rs`, which is
 * authoritative; both run the same case table. Parsing is total, so any stored text becomes valid settings.
 */

export const SOUND_VERSION = 1;
export const BAND_COUNT = 8;
export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 12;
export const PREAMP_MIN_DB = -12;
export const PREAMP_MAX_DB = 6;

/** Q of the peaking bands. Never exposed to the user. */
export const PEAK_Q = 1;
/** Slope of the two shelves. */
export const SHELF_SLOPE = 1;

export type BandKind = "lowShelf" | "peak" | "highShelf";
export type Levelling = "off" | "track";

export interface Band {
  freqHz: number;
  kind: BandKind;
}

export const BANDS: readonly Band[] = [
  { freqHz: 60, kind: "lowShelf" },
  { freqHz: 150, kind: "peak" },
  { freqHz: 400, kind: "peak" },
  { freqHz: 1000, kind: "peak" },
  { freqHz: 2400, kind: "peak" },
  { freqHz: 5000, kind: "peak" },
  { freqHz: 9000, kind: "peak" },
  { freqHz: 14000, kind: "highShelf" },
];

export interface EqSettings {
  on: boolean;
  preset: string | null;
  gains: number[];
}

export interface SoundSettings {
  eq: EqSettings;
  preampDb: number;
  levelling: Levelling;
}

export function defaultSoundSettings(): SoundSettings {
  return { eq: flatEq(), preampDb: 0, levelling: "off" };
}

function flatEq(): EqSettings {
  return { on: false, preset: null, gains: new Array<number>(BAND_COUNT).fill(0) };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Null when the list is the wrong length or holds a non-finite entry. */
function readGains(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== BAND_COUNT) return null;
  const gains: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    gains.push(clamp(item, GAIN_MIN_DB, GAIN_MAX_DB));
  }
  return gains;
}

function parseEq(eq: unknown): EqSettings {
  if (!isRecord(eq)) return flatEq();
  const gains = readGains(eq.gains);
  if (!gains) return flatEq();
  return {
    on: eq.on === true,
    preset: typeof eq.preset === "string" ? eq.preset : null,
    gains,
  };
}

/**
 * Reads a stored blob. Unparsable text or a `v` other than the current one gives all defaults; with a
 * valid `v`, each field falls back on its own. A bad gains array flattens and bypasses the whole EQ.
 */
export function parseSoundSettings(raw: string): SoundSettings {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return defaultSoundSettings();
  }
  if (!isRecord(root) || root.v !== SOUND_VERSION) return defaultSoundSettings();
  const preamp = root.preamp_db;
  return {
    eq: parseEq(root.eq),
    preampDb:
      typeof preamp === "number" && Number.isFinite(preamp)
        ? clamp(preamp, PREAMP_MIN_DB, PREAMP_MAX_DB)
        : 0,
    levelling: root.levelling === "track" ? "track" : "off",
  };
}

/** The wire form `parseSoundSettings` reads back. */
export function serializeSoundSettings(s: SoundSettings): string {
  return JSON.stringify({
    v: SOUND_VERSION,
    eq: { on: s.eq.on, preset: s.eq.preset, gains: s.eq.gains },
    preamp_db: s.preampDb,
    levelling: s.levelling,
  });
}
