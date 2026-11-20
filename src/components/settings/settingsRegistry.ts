/*
 * The registry of every Settings row: a stable id, its section, its label and helper accessors and its
 * per-language synonyms. The page stamps each row with its id (SettingRow), so the registry and the
 * rendered rows are checked against each other. A row that does not always exist carries a `visible`
 * predicate instead of being left out. Plugin hub rows are dynamic: their ids come from `hubSettingId`.
 */

// -- Utils Imports --
import { STAMP_ENABLED } from "../../lib/features";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { SettingsSectionId } from "./settingsSections";

export type SettingId =
  | "addFolder"
  | "rescanAll"
  | "keepUpToDate"
  | "addGenre"
  | "stampFiles"
  | "trimReplace"
  | "restorePoints"
  | "outputDevice"
  | "playHistory"
  | "equalizer"
  | "preset"
  | "preamp"
  | "levelLoudness"
  | "visualizerCatalog"
  | "theme"
  | "language"
  | "closeBehavior"
  | "defaultApp"
  | "shortcuts"
  | "installFile"
  | "installFolder"
  | "openFolder"
  | "safeMode"
  | "developerMode"
  | "checkForUpdates"
  | "autoCheck";

/** The id of one installed plugin's row in the hub. */
export type HubSettingId = `hub-${string}`;

/** What decides whether a conditional row exists right now. */
export interface SettingsContext {
  windows: boolean;
}

export interface SettingEntry {
  id: SettingId;
  section: SettingsSectionId;
  label: (d: Dict) => string;
  /** The row's helper line, matched as secondary text. */
  sublabel?: (d: Dict) => string;
  /** Alternate words that find the row, in the active language. */
  synonyms: (d: Dict) => string[];
  /** Absent means always present. */
  visible?: (ctx: SettingsContext) => boolean;
}

/** True on Windows, the only platform with a Default apps page to open. */
export function isWindowsPlatform(): boolean {
  return navigator.userAgent.includes("Windows");
}

export function settingsContext(): SettingsContext {
  return { windows: isWindowsPlatform() };
}

/** In page order. */
export const SETTINGS_REGISTRY: readonly SettingEntry[] = [
  {
    id: "addFolder",
    section: "folders",
    label: (d) => d.settings.addFolder,
    synonyms: (d) => d.settingsIndex.addFolder,
  },
  {
    id: "rescanAll",
    section: "folders",
    label: (d) => d.settings.rescanAll,
    synonyms: (d) => d.settingsIndex.rescanAll,
  },
  {
    id: "keepUpToDate",
    section: "folders",
    label: (d) => d.settings.keepUpToDate,
    sublabel: (d) => d.settings.keepUpToDateHelper,
    synonyms: (d) => d.settingsIndex.keepUpToDate,
  },
  {
    id: "addGenre",
    section: "genres",
    label: (d) => d.settings.addGenre,
    synonyms: (d) => d.settingsIndex.addGenre,
  },
  {
    id: "stampFiles",
    section: "musicFiles",
    label: (d) => d.fileWrites.settings.stampLabel,
    sublabel: (d) => d.fileWrites.settings.stampHelper,
    synonyms: (d) => d.settingsIndex.stampFiles,
    visible: () => STAMP_ENABLED,
  },
  {
    id: "trimReplace",
    section: "musicFiles",
    label: (d) => d.fileWrites.settings.trimLabel,
    sublabel: (d) => d.fileWrites.settings.trimHelper,
    synonyms: (d) => d.settingsIndex.trimReplace,
  },
  {
    id: "restorePoints",
    section: "restorePoints",
    label: (d) => d.restorePoints.section,
    sublabel: (d) => d.restorePoints.helper,
    synonyms: (d) => d.settingsIndex.restorePoints,
  },
  {
    id: "outputDevice",
    section: "playback",
    label: (d) => d.settings.outputDevice,
    synonyms: (d) => d.settingsIndex.outputDevice,
  },
  {
    id: "playHistory",
    section: "playback",
    label: (d) => d.settings.playHistory,
    sublabel: (d) => d.settings.playHistoryHelper,
    synonyms: (d) => d.settingsIndex.playHistory,
  },
  {
    id: "equalizer",
    section: "sound",
    label: (d) => d.sound.equalizer,
    synonyms: (d) => d.settingsIndex.equalizer,
  },
  {
    id: "preset",
    section: "sound",
    label: (d) => d.sound.preset,
    synonyms: (d) => d.settingsIndex.preset,
  },
  {
    id: "preamp",
    section: "sound",
    label: (d) => d.sound.preamp,
    sublabel: (d) => d.sound.headroomNone,
    synonyms: (d) => d.settingsIndex.preamp,
  },
  {
    id: "levelLoudness",
    section: "sound",
    label: (d) => d.sound.levelLoudness,
    sublabel: (d) => d.sound.levellingHelper,
    synonyms: (d) => d.settingsIndex.levelLoudness,
  },
  {
    id: "visualizerCatalog",
    section: "visualizers",
    label: (d) => d.settings.visualizerCatalog,
    sublabel: (d) => d.settings.visualizersHelper,
    synonyms: (d) => d.settingsIndex.visualizerCatalog,
  },
  {
    id: "theme",
    section: "appearance",
    label: (d) => d.settings.theme,
    synonyms: (d) => d.settingsIndex.theme,
  },
  {
    id: "language",
    section: "appearance",
    label: (d) => d.settings.language,
    synonyms: (d) => d.settingsIndex.language,
  },
  {
    id: "closeBehavior",
    section: "system",
    label: (d) => d.settings.closeBehavior,
    sublabel: (d) => d.settings.closeHelper,
    synonyms: (d) => d.settingsIndex.closeBehavior,
  },
  {
    id: "defaultApp",
    section: "system",
    label: (d) => d.settings.defaultApp,
    sublabel: (d) => d.settings.makeDefaultHelper,
    synonyms: (d) => d.settingsIndex.defaultApp,
    visible: (ctx) => ctx.windows,
  },
  {
    id: "shortcuts",
    section: "system",
    label: (d) => d.shortcuts.title,
    synonyms: (d) => d.settingsIndex.shortcuts,
  },
  {
    id: "installFile",
    section: "plugins",
    label: (d) => d.plugins.installFile,
    synonyms: (d) => d.settingsIndex.installFile,
  },
  {
    id: "installFolder",
    section: "plugins",
    label: (d) => d.plugins.installFolder,
    synonyms: (d) => d.settingsIndex.installFolder,
  },
  {
    id: "openFolder",
    section: "plugins",
    label: (d) => d.plugins.openFolder,
    synonyms: (d) => d.settingsIndex.openFolder,
  },
  {
    id: "safeMode",
    section: "plugins",
    label: (d) => d.plugins.safeEntry.label,
    sublabel: (d) => d.plugins.safeEntry.helperRunning,
    synonyms: (d) => d.settingsIndex.safeMode,
  },
  {
    id: "developerMode",
    section: "plugins",
    label: (d) => d.plugins.devMode.label,
    sublabel: (d) => d.plugins.devMode.helper,
    synonyms: (d) => d.settingsIndex.developerMode,
  },
  {
    id: "checkForUpdates",
    section: "updates",
    label: (d) => d.updater.check,
    synonyms: (d) => d.settingsIndex.checkForUpdates,
  },
  {
    id: "autoCheck",
    section: "updates",
    label: (d) => d.updater.autoCheck,
    sublabel: (d) => d.updater.autoCheckHint,
    synonyms: (d) => d.settingsIndex.autoCheck,
  },
];

/** The entries that exist right now, in page order. */
export function visibleSettings(ctx: SettingsContext): SettingEntry[] {
  return SETTINGS_REGISTRY.filter((entry) => !entry.visible || entry.visible(ctx));
}

/** The registry entry for an id, or undefined for a hub id or an unknown one. */
export function settingEntry(id: string): SettingEntry | undefined {
  return SETTINGS_REGISTRY.find((entry) => entry.id === id);
}

/** The id of one installed plugin's hub row. */
export function hubSettingId(pluginId: string): HubSettingId {
  return `hub-${pluginId}`;
}

/** The DOM id a row carries, usable as a scroll anchor. */
export function settingAnchorId(id: SettingId | HubSettingId): string {
  return `setting-${id}`;
}
