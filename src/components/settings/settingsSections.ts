/*
 * The Settings sections in page order: the one list the page, the registry and any section navigation
 * read from, so a section cannot exist in one and be missing from another.
 */

// -- Type Imports --
import type { Dict } from "../../i18n/en";

export type SettingsSectionId =
  | "folders"
  | "genres"
  | "musicFiles"
  | "restorePoints"
  | "playback"
  | "sound"
  | "visualizers"
  | "appearance"
  | "system"
  | "plugins"
  | "updates";

export interface SettingsSection {
  id: SettingsSectionId;
  label: (d: Dict) => string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "folders", label: (d) => d.settings.sectionFolders },
  { id: "genres", label: (d) => d.settings.sectionGenres },
  { id: "musicFiles", label: (d) => d.fileWrites.settings.section },
  { id: "restorePoints", label: (d) => d.restorePoints.section },
  { id: "playback", label: (d) => d.settings.sectionPlayback },
  { id: "sound", label: (d) => d.settings.sectionSound },
  { id: "visualizers", label: (d) => d.settings.sectionVisualizers },
  { id: "appearance", label: (d) => d.settings.sectionAppearance },
  { id: "system", label: (d) => d.settings.sectionSystem },
  { id: "plugins", label: (d) => d.plugins.section },
  { id: "updates", label: (d) => d.updater.section },
];

/** The attribute pair that tags a section element with its id. */
export function sectionAttr(id: SettingsSectionId): { "data-settings-section": SettingsSectionId } {
  return { "data-settings-section": id };
}
