/*
 * The frontend layout presets: each a named pair of album patterns in the token language the backend
 * derivation reads. The two patterns are the whole state that persists and passes into export - the
 * selected preset is derived back from them, so a stored pair always resolves to a preset or Custom.
 */

/** A preset's stable id, doubling as its i18n key under `export.preset`. */
export type PresetId = "artistAlbum" | "artistYearAlbum" | "albumOnly" | "flat";

/** A named layout: the folder and filename patterns it stands for. An empty folder means no subfolders. */
export interface ExportPreset {
  id: PresetId;
  folder: string;
  file: string;
}

/** The presets, in display order. The first is the default when nothing is persisted yet. */
export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "artistAlbum", folder: "{albumartist}/{album}", file: "{track_no} - {title}" },
  { id: "artistYearAlbum", folder: "{albumartist}/{year} - {album}", file: "{track_no} - {title}" },
  { id: "albumOnly", folder: "{album}", file: "{track_no} - {title}" },
  { id: "flat", folder: "", file: "{albumartist} - {album} - {track_no} - {title}" },
];

/** The Artist/Album default, applied when no template is stored. */
export const DEFAULT_PRESET = EXPORT_PRESETS[0];

/** The preset a pattern pair spells, or null when it matches none (a custom layout). */
export function presetIdFor(folder: string, file: string): PresetId | null {
  const found = EXPORT_PRESETS.find((p) => p.folder === folder && p.file === file);
  return found ? found.id : null;
}
