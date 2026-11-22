/*
 * A plugin kind's setting values, kept in one preference: a JSON object keyed by kind id, each holding only
 * the values that differ from the declared defaults. Reads are defensive: a missing or malformed value
 * falls back to its default, a value for a setting the kind no longer declares is ignored, and a number is
 * clamped into its range.
 */

// -- Type Imports --
import type { PluginVisualizerSetting, PluginVisualizerSettingValue } from "../../plugins/visualizerDecl";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";

/** The values of one kind, by setting id, with every declared setting present. */
export type KindValues = Record<string, PluginVisualizerSettingValue>;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` as a valid value of `setting`, or undefined when it is none. */
export function validValue(
  setting: PluginVisualizerSetting,
  value: unknown,
): PluginVisualizerSettingValue | undefined {
  switch (setting.type) {
    case "choice":
      return typeof value === "string" && setting.options.some((o) => o.id === value) ? value : undefined;
    case "toggle":
      return typeof value === "boolean" ? value : undefined;
    case "range":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(setting.max, Math.max(setting.min, value))
        : undefined;
    case "color":
      return typeof value === "string" && (value === "cover" || HEX_COLOR.test(value)) ? value : undefined;
  }
}

/** The stored preference as an object per kind; anything that is not one reads as empty. */
export function parseSettingsPref(raw: string | undefined): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isObject(parsed)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [kind, values] of Object.entries(parsed)) {
    if (isObject(values)) out[kind] = values;
  }
  return out;
}

/** The declared default of each setting, by id. */
export function defaultValues(settings: readonly PluginVisualizerSetting[]): KindValues {
  return Object.fromEntries(settings.map((s) => [s.id, s.default]));
}

/** The kind's values from the stored preference: each declared setting, stored when valid, else default. */
export function kindValues(descriptor: PluginVisualizerDescriptor, raw: string | undefined): KindValues {
  const stored = parseSettingsPref(raw)[descriptor.id] ?? {};
  const out = defaultValues(descriptor.settings);
  for (const setting of descriptor.settings) {
    const value = validValue(setting, stored[setting.id]);
    if (value !== undefined) out[setting.id] = value;
  }
  return out;
}

/** The kind's values as text: equal values give equal text, whatever order they were set in. */
export function kindValuesKey(values: KindValues): string {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The preference text after `kind`'s values become `values`; other kinds' entries are kept as they were. */
export function withKindValues(
  raw: string | undefined,
  descriptor: PluginVisualizerDescriptor,
  values: KindValues,
): string {
  const all = parseSettingsPref(raw);
  const defaults = defaultValues(descriptor.settings);
  const changed: KindValues = {};
  for (const setting of descriptor.settings) {
    const value = validValue(setting, values[setting.id]);
    if (value !== undefined && value !== defaults[setting.id]) changed[setting.id] = value;
  }
  const { [descriptor.id]: _old, ...rest } = all;
  return JSON.stringify(Object.keys(changed).length > 0 ? { ...rest, [descriptor.id]: changed } : rest);
}

/** The id of the preset whose values all match `values`, or null for custom values. */
export function matchingPreset(descriptor: PluginVisualizerDescriptor, values: KindValues): string | null {
  const byId = new Map(descriptor.settings.map((s) => [s.id, s]));
  for (const preset of descriptor.presets) {
    const entries = Object.entries(preset.values).filter(([id]) => byId.has(id));
    const same = entries.every(([id, v]) => {
      const setting = byId.get(id)!;
      return validValue(setting, v) === values[id];
    });
    if (entries.length > 0 && same) return preset.id;
  }
  return null;
}

/** `values` with a preset's own values laid over them; a preset value that is not valid is skipped. */
export function applyPreset(
  descriptor: PluginVisualizerDescriptor,
  values: KindValues,
  presetId: string,
): KindValues {
  const preset = descriptor.presets.find((p) => p.id === presetId);
  if (!preset) return values;
  const out = { ...values };
  for (const setting of descriptor.settings) {
    const value = validValue(setting, preset.values[setting.id]);
    if (value !== undefined) out[setting.id] = value;
  }
  return out;
}
