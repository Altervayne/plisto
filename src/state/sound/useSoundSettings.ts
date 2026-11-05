/*
 * The Sound controls' view of the `sound` blob. It selects the raw stored string and parses it in a memo,
 * so a component re-renders only when the text changes and never gets a fresh object per render. Edits
 * read the latest text at call time, so a fast drag never writes from a stale closure.
 */

// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import { PREF_KEYS, usePreference, usePreferencesStore } from "../preferences/store";

// -- Utils Imports --
import { defaultSoundSettings, parseSoundSettings, serializeSoundSettings } from "./settings";
import { applyPreset, resetSound, setBandGain, setEqOn, setPreampDb } from "./presets";

// -- Type Imports --
import type { SoundSettings } from "./settings";
import type { PresetKey } from "./presets";

export interface SoundActions {
  setOn: (on: boolean) => void;
  applyPreset: (key: PresetKey) => void;
  setGain: (band: number, gainDb: number) => void;
  setPreamp: (preampDb: number) => void;
  reset: () => void;
}

function read(raw: string | undefined): SoundSettings {
  return raw == null ? defaultSoundSettings() : parseSoundSettings(raw);
}

/** The parsed settings, re-derived only when the stored text changes. */
export function useSoundSettings(): SoundSettings {
  const raw = usePreference(PREF_KEYS.sound);
  return useMemo(() => read(raw), [raw]);
}

/** Stable edit actions that write the blob back through the preferences store. */
export function useSoundActions(): SoundActions {
  const setPreference = usePreferencesStore((s) => s.setPreference);

  return useMemo(() => {
    const edit = (change: (s: SoundSettings) => SoundSettings) => {
      const current = usePreferencesStore.getState().values[PREF_KEYS.sound];
      const next = serializeSoundSettings(change(read(current)));
      if (next !== current) setPreference(PREF_KEYS.sound, next);
    };
    return {
      setOn: (on) => edit((s) => setEqOn(s, on)),
      applyPreset: (key) => edit((s) => applyPreset(s, key)),
      setGain: (band, gainDb) => edit((s) => setBandGain(s, band, gainDb)),
      setPreamp: (preampDb) => edit((s) => setPreampDb(s, preampDb)),
      reset: () => edit(resetSound),
    };
  }, [setPreference]);
}
