/*
 * The select-contents semantics in one place: a plain click replaces the shared selection with a
 * folder's tracks, Ctrl/Cmd+click unions them in. Nothing here ever removes a track.
 */

/** How a gathered set meets the current selection. */
export type GatherMode = "replace" | "add";

/** The modifier keys of the click that triggered a gather. */
export interface GatherModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Ctrl (or Cmd on macOS) adds; anything else replaces. */
export function gatherMode(mods: GatherModifiers): GatherMode {
  return mods.ctrlKey || mods.metaKey ? "add" : "replace";
}

/** True when `ids` is non-empty and every id is already selected. */
export function allSelected(ids: number[], selection: Set<number>): boolean {
  return ids.length > 0 && ids.every((id) => selection.has(id));
}
