/*
 * The one expansion of a playlist into the tracks it plays: track slots and album entries merged by
 * position then slot id, each album entry replaced by its members in album order. Pure over the rows, so
 * the play control, the counts, the finder and the row list share one rule. It is the twin of
 * `playlist_expanded` and `expanded_queue` in db/playlist_albums.rs; the golden fixture beside it is read
 * by both, so the two cannot drift.
 */

// -- Utils Imports --
import { discOf } from "../albums/albumLayout";

// -- Type Imports --
import type {
  AlbumTrackRow,
  PlaylistAlbumEntryRow,
  PlaylistTrackRow,
  QueueBlock,
} from "../../types";

// The bounds db/playlist_albums.rs clamps the order key to, so an odd stored value sorts the same way.
const MAX_DISC = 99999;
const MAX_TRACK_NO = 999999;

/** One playlist row: a track slot, or an album entry with the members it expands to. */
export type PlaylistEntry =
  | { kind: "track"; id: number; slot: PlaylistTrackRow; first: number }
  | {
      kind: "album";
      id: number;
      entry: PlaylistAlbumEntryRow;
      members: AlbumTrackRow[];
      first: number;
    };

/**
 * A playlist expanded. `first` on each entry is the index of its first track in `ids`. While `ready` is
 * false (an album entry exists and the album projection is not loaded) `ids` and `blocks` are empty,
 * `count` is null and every `first` is meaningless: the caller shows the playlist as loading, it never
 * reads an empty queue or a count of 0.
 */
export interface PlaylistExpansion {
  entries: PlaylistEntry[];
  ids: number[];
  blocks: QueueBlock[];
  count: number | null;
  ready: boolean;
}

export interface ExpandOptions {
  /** Whether the album projection is loaded; members of an album entry are unknown until it is. */
  orgReady: boolean;
  /** Drops tracks whose file is gone before blocks are counted. */
  presentOnly?: boolean;
}

/** Groups membership rows by album, the lookup an expansion reads members from. */
export function groupMembers(membership: AlbumTrackRow[]): Map<number, AlbumTrackRow[]> {
  const byAlbum = new Map<number, AlbumTrackRow[]>();
  for (const row of membership) {
    const list = byAlbum.get(row.album_id);
    if (list) list.push(row);
    else byAlbum.set(row.album_id, [row]);
  }
  return byAlbum;
}

const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value));

/** Disc and track number as the database orders them: unset disc reads 1, unset number 0, both clamped. */
function orderKey(row: AlbumTrackRow): [number, number] {
  return [clamp(discOf(row), MAX_DISC), clamp(row.track_no ?? 0, MAX_TRACK_NO)];
}

/** An album's members in play order: disc, track number, then track id. */
function inAlbumOrder(rows: AlbumTrackRow[]): AlbumTrackRow[] {
  return [...rows].sort((a, b) => {
    const [discA, noA] = orderKey(a);
    const [discB, noB] = orderKey(b);
    return discA - discB || noA - noB || a.track_id - b.track_id;
  });
}

/**
 * Expands one playlist's slots and album entries. `members` maps an album id to its membership rows in any
 * order. A kept entry with at least one counted member is a block over its run, a single member included.
 */
export function expandPlaylist(
  slots: PlaylistTrackRow[],
  albumEntries: PlaylistAlbumEntryRow[],
  members: ReadonlyMap<number, AlbumTrackRow[]>,
  { orgReady, presentOnly = false }: ExpandOptions,
): PlaylistExpansion {
  const ready = albumEntries.length === 0 || orgReady;
  const merged = [
    ...slots.map((slot) => ({ at: slot.position, id: slot.id, slot })),
    ...albumEntries.map((entry) => ({ at: entry.position, id: entry.id, entry })),
  ].sort((a, b) => a.at - b.at || a.id - b.id);

  const ids: number[] = [];
  const blocks: QueueBlock[] = [];
  const entries: PlaylistEntry[] = [];
  let count = 0;
  for (const item of merged) {
    const first = ids.length;
    if ("slot" in item) {
      count += 1;
      if (!presentOnly || item.slot.missing_at == null) ids.push(item.slot.track_id);
      entries.push({ kind: "track", id: item.id, slot: item.slot, first });
      continue;
    }
    const rows = ready ? inAlbumOrder(members.get(item.entry.album_id) ?? []) : [];
    count += rows.length;
    for (const row of rows) {
      if (!presentOnly || row.missing_at == null) ids.push(row.track_id);
    }
    if (item.entry.keep_order && ids.length > first) blocks.push([first, ids.length - first]);
    entries.push({ kind: "album", id: item.id, entry: item.entry, members: rows, first });
  }

  if (!ready) return { entries, ids: [], blocks: [], count: null, ready };
  return { entries, ids, blocks, count, ready };
}
