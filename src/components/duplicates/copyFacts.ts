/*
 * What one copy in a duplicate set shows, worded for display, and which of those facts differ across
 * the set. The card emphasizes only the differing ones, so the copies read as a comparison.
 */

// -- Utils Imports --
import { formatBytes, formatDuration } from "../../lib/format";

// -- Type Imports --
import type { AlbumRow, TrackRow } from "../../types";

/** One copy's displayed facts. `plays` is null while the play counts are unknown. */
export interface CopyFacts {
  id: number;
  sourcePath: string;
  filename: string;
  folder: string;
  format: string;
  size: string;
  duration: string;
  placement: string;
  playlists: number;
  plays: number | null;
  gone: boolean;
  identical: boolean;
}

/** The facts the card compares across copies. */
export type CopyField =
  | "filename"
  | "folder"
  | "format"
  | "size"
  | "duration"
  | "placement"
  | "playlists"
  | "plays";

const COMPARED: readonly CopyField[] = [
  "filename",
  "folder",
  "format",
  "size",
  "duration",
  "placement",
  "playlists",
  "plays",
];

/** What the facts are read against: organization, playlist slots, play counts and the placement words. */
export interface CopyContext {
  albumIndex: Map<number, AlbumRow>;
  playlistsByTrack: Map<number, number>;
  plays: Map<number, number> | null;
  identical: ReadonlySet<number>;
  labels: { single: string; unsorted: string; untitled: string };
}

/** The folder a track sits in, as the path reads on disk, without the filename. */
export function folderOf(track: TrackRow): string {
  const path = track.display_path ?? track.source_path;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** How many distinct playlists hold each track. */
export function countPlaylistsByTrack(
  slots: { playlist_id: number; track_id: number }[],
): Map<number, number> {
  const seen = new Map<number, Set<number>>();
  for (const slot of slots) {
    const lists = seen.get(slot.track_id);
    if (lists) lists.add(slot.playlist_id);
    else seen.set(slot.track_id, new Set([slot.playlist_id]));
  }
  return new Map([...seen].map(([trackId, lists]) => [trackId, lists.size]));
}

/** One copy's facts. A track with no play row has played zero times once the counts are known. */
export function describeCopy(track: TrackRow, ctx: CopyContext): CopyFacts {
  const album = ctx.albumIndex.get(track.id);
  const placement =
    album == null
      ? ctx.labels.unsorted
      : album.kind === "single"
        ? ctx.labels.single
        : (album.title ?? ctx.labels.untitled);
  return {
    id: track.id,
    sourcePath: track.source_path,
    filename: track.filename,
    folder: folderOf(track),
    format: track.ext.toUpperCase(),
    size: formatBytes(track.size_bytes),
    duration: formatDuration(track.duration_secs),
    placement,
    playlists: ctx.playlistsByTrack.get(track.id) ?? 0,
    plays: ctx.plays == null ? null : (ctx.plays.get(track.id) ?? 0),
    gone: track.missing_at != null,
    identical: ctx.identical.has(track.id),
  };
}

/** The facts that are not the same on every copy. */
export function differingFields(copies: CopyFacts[]): Set<CopyField> {
  const differing = new Set<CopyField>();
  for (const field of COMPARED) {
    if (new Set(copies.map((c) => c[field])).size > 1) differing.add(field);
  }
  return differing;
}
