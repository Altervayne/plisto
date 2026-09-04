/*
 * The audio files Plisto opens off the desktop: the same extensions it registers as a file-association
 * handler for, so a drop or an OS launch only ever plays one of these. Kept in step with PLAYABLE_EXTS in
 * src-tauri/src/startup.rs and bundle.fileAssociations in tauri.conf.json.
 */

/** The playable extensions, dotless and lowercase, matched case-insensitively. */
const PLAYABLE_EXTS = new Set(["mp3", "flac", "wav", "m4a", "m4b", "ogg", "oga", "opus"]);

/** The dotless, lowercased extension of a path, or "" when it carries none. */
function extOf(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

/** Whether a path names a file Plisto can play straight off disk. */
export function isPlayableAudio(path: string): boolean {
  return PLAYABLE_EXTS.has(extOf(path));
}

/** Keeps only the playable audio paths from a drop, dropping folders and non-audio files. */
export function keepAudioFiles(paths: string[]): string[] {
  return paths.filter(isPlayableAudio);
}
