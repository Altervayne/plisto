/*
 * The visualizer kinds a plugin declares, as its manifest summary and inspection carry them. Mirrors
 * VisualizerDecl in plugins/visualizer_decl.rs, where every field is already validated; nothing here
 * checks them again.
 */

/** How the runtime tone-maps a scene onto the stage. Mirrors Composite in visualizer_decl.rs. */
export type PluginVisualizerComposite = "light" | "ink" | "image";

/** One theme's composite and the CSS mix-blend-mode keyword Plisto puts on the slot. */
export interface PluginVisualizerLookPair {
  composite: PluginVisualizerComposite;
  blend: string;
}

/** The composite and blend per theme. The `glow` and `image` shorthands arrive expanded. */
export interface PluginVisualizerLook {
  light: PluginVisualizerLookPair;
  dark: PluginVisualizerLookPair;
}

/** What a kind asks Plisto to feed it beyond the levels. */
export interface PluginVisualizerNeeds {
  fine: boolean;
  cover: boolean;
  pointer: boolean;
  waveform: boolean;
}

/** A setting value: a toggle's flag, a range's number, a choice's option id or a color. */
export type PluginVisualizerSettingValue = boolean | number | string;

interface SettingBase {
  id: string;
  label: string;
}

/** One control of a kind. A color is `#rrggbb` or `cover`, the cover palette. */
export type PluginVisualizerSetting =
  | (SettingBase & { type: "choice"; options: { id: string; label: string }[]; default: string })
  | (SettingBase & { type: "toggle"; default: boolean })
  | (SettingBase & { type: "range"; min: number; max: number; step: number; default: number })
  | (SettingBase & { type: "color"; default: string });

/** A named bundle of setting values, keyed by setting id. */
export interface PluginVisualizerPreset {
  id: string;
  label: string;
  values: Record<string, PluginVisualizerSettingValue>;
}

/** One declared visualizer kind. Exactly one of `page` and `shader` is set. */
export interface PluginVisualizerDecl {
  id: string;
  name: string;
  api: number;
  page: string | null;
  shader: string | null;
  look: PluginVisualizerLook;
  fills_stage: boolean;
  dark_only: boolean;
  needs: PluginVisualizerNeeds;
  /** Former ids; a stored pick naming one resolves to this kind. */
  aliases: string[];
  settings: PluginVisualizerSetting[];
  presets: PluginVisualizerPreset[];
}
