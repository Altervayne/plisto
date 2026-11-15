/*
 * Turns two snapshots of the library stores into the change a plugin hears as `library_changed`. Rows are
 * compared by reference: every store edit and reload replaces the rows it touched, so an untouched row is
 * the same object. Pure; the hook that feeds it lives in useLibraryWatch.ts.
 */

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, LibraryChange, PlaylistRow, PlaylistTrackRow, TrackRow } from "../../types";

/** The rows the three stores hold that a plugin can see change. */
export interface LibrarySnapshot {
  tracks: TrackRow[];
  albums: AlbumRow[];
  membership: AlbumTrackRow[];
  playlists: PlaylistRow[];
  slots: PlaylistTrackRow[];
}

/** The most ids one change names; past it the change reports null and the plugin re-reads. */
export const MAX_CHANGE_IDS = 500;

/** Ids whose row is new, replaced or gone. */
function changedKeys<T>(prev: T[], next: T[], key: (row: T) => number): Set<number> {
  const before = new Map(prev.map((row) => [key(row), row]));
  const out = new Set<number>();
  for (const row of next) {
    const id = key(row);
    if (before.get(id) !== row) out.add(id);
    before.delete(id);
  }
  for (const id of before.keys()) out.add(id);
  return out;
}

/** Whether any row differs, by reference or by length. */
function differs<T>(prev: T[], next: T[]): boolean {
  if (prev === next) return false;
  return prev.length !== next.length || prev.some((row, i) => row !== next[i]);
}

const NONE = new Set<number>();

/** The changed keys of one array, with no work at all when the array itself is untouched. */
function keysIfChanged<T>(prev: T[], next: T[], key: (row: T) => number): Set<number> {
  return prev === next ? NONE : changedKeys(prev, next, key);
}

/** Whether every watched array is the same object, so a diff would find nothing. */
export function sameSnapshot(prev: LibrarySnapshot, next: LibrarySnapshot): boolean {
  return (
    prev.tracks === next.tracks &&
    prev.albums === next.albums &&
    prev.membership === next.membership &&
    prev.playlists === next.playlists &&
    prev.slots === next.slots
  );
}

/**
 * What changed from `prev` to `next`, or null when nothing a plugin can see did. A reload replaces every
 * track row, which reads as `track_ids: null` rather than a list of the whole library.
 */
export function diffLibrary(prev: LibrarySnapshot, next: LibrarySnapshot): LibraryChange | null {
  const ids = new Set(keysIfChanged(prev.tracks, next.tracks, (r) => r.id));
  // A reload replaces every row (and may drop some); one edit never does, unless the library holds one track.
  const reloaded = next.tracks.length > 1 && ids.size >= next.tracks.length;

  const memberIds = new Set(keysIfChanged(prev.membership, next.membership, (r) => r.track_id));
  const albumIds = keysIfChanged(prev.albums, next.albums, (a) => a.id);
  // An album's own fields resolve into its members' track DTOs, so its members change with it.
  if (albumIds.size > 0) {
    for (const row of next.membership) if (albumIds.has(row.album_id)) memberIds.add(row.track_id);
    for (const row of prev.membership) if (albumIds.has(row.album_id)) memberIds.add(row.track_id);
  }
  const albums = albumIds.size > 0 || memberIds.size > 0;
  const playlists = differs(prev.playlists, next.playlists) || differs(prev.slots, next.slots);

  for (const id of memberIds) ids.add(id);
  if (ids.size === 0 && !albums && !playlists) return null;
  const many = reloaded || ids.size > MAX_CHANGE_IDS;
  return { track_ids: many ? null : [...ids].sort((a, b) => a - b), albums, playlists };
}

// The running watch's entry for changes that replace no store row; null while none runs.
let sink: ((change: LibraryChange) => void) | null = null;

/** Installs the entry that explicit reports go to. Owned by the running watch. */
export function bindLibrarySink(next: (change: LibraryChange) => void): void {
  sink = next;
}

/** Whether a watch is listening, so a caller can skip building a report nobody would receive. */
export function hasLibrarySink(): boolean {
  return sink != null;
}

/** Clears the entry, but only when it is still the caller's: a newer watch keeps its own. */
export function unbindLibrarySink(mine: (change: LibraryChange) => void): void {
  if (sink === mine) sink = null;
}

/** What the album projection changed between two states, or null when nothing did. */
export function diffOrg(
  prev: { albums: AlbumRow[]; membership: AlbumTrackRow[] },
  next: { albums: AlbumRow[]; membership: AlbumTrackRow[] },
): LibraryChange | null {
  const none: LibrarySnapshot = { tracks: [], albums: [], membership: [], playlists: [], slots: [] };
  return diffLibrary({ ...none, ...prev }, { ...none, ...next });
}

/**
 * Reports a change the stores cannot show (a cover write, a genre rename). Joins the same batch as the
 * diffed changes; silent while the runtime is not ready.
 */
export function reportLibraryChange(change: LibraryChange): void {
  const over = change.track_ids != null && change.track_ids.length > MAX_CHANGE_IDS;
  sink?.(over ? { ...change, track_ids: null } : change);
}

/** Merges two changes reported inside one window: ids unioned (null absorbs, over the cap becomes null), flags ORed. */
export function mergeChanges(a: LibraryChange, b: LibraryChange): LibraryChange {
  let track_ids: number[] | null = null;
  if (a.track_ids && b.track_ids) {
    const union = new Set([...a.track_ids, ...b.track_ids]);
    if (union.size <= MAX_CHANGE_IDS) track_ids = [...union].sort((x, y) => x - y);
  }
  return { track_ids, albums: a.albums || b.albums, playlists: a.playlists || b.playlists };
}
