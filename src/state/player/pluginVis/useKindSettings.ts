/*
 * A plugin kind's setting values and the actions the sheet's footer takes on them, over the one
 * preference that holds every kind's values.
 */

// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import {
  PREF_KEYS,
  usePlayerVisualizerSettings,
  usePreferencesStore,
  useSetPlayerVisualizerSettings,
} from "../../preferences/store";

// -- Local Imports --
import { applyPreset, kindValues, matchingPreset, withKindValues, type KindValues } from "./kindSettings";

// -- Type Imports --
import type { PluginVisualizerSettingValue } from "../../plugins/visualizerDecl";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";

export interface KindSettings {
  values: KindValues;
  // The matching preset's id, or null for custom values.
  preset: string | null;
  set: (id: string, value: PluginVisualizerSettingValue) => void;
  choosePreset: (id: string) => void;
}

export function useKindSettings(descriptor: PluginVisualizerDescriptor): KindSettings {
  const raw = usePlayerVisualizerSettings();
  const write = useSetPlayerVisualizerSettings();
  const values = useMemo(() => kindValues(descriptor, raw), [descriptor, raw]);
  // Edits read the preference as it is when they run, so two in a row never undo each other.
  const edit = (change: (current: KindValues) => KindValues) => {
    const now = usePreferencesStore.getState().getPreference(PREF_KEYS.playerVisualizerSettings);
    write(withKindValues(now, descriptor, change(kindValues(descriptor, now))));
  };
  return {
    values,
    preset: matchingPreset(descriptor, values),
    set: (id, value) => edit((current) => ({ ...current, [id]: value })),
    choosePreset: (id) => edit((current) => applyPreset(descriptor, current, id)),
  };
}
