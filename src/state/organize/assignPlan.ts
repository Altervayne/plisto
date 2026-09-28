/*
 * Builds the assign command for tracks joining an album, mirroring the backend move-or-add. Each joining
 * track lands after the highest position on its own disc in the target, and its row carries the disc it
 * really resolves to. The command's rows are also what the write stamps back, so the numbering here is
 * the numbering that ships.
 */

// -- Utils Imports --
import { discOf } from "../../components/albums/albumLayout";

// -- Type Imports --
import type { AlbumTrackRow, TrackRow } from "../../types";
import type { AssignTracks, Placement } from "./orgCommands";

/**
 * The assign command for `trackIds` joining `albumId`, in the given order, or null when nothing would
 * change. A track already in the album is left untouched; a loose id with no scan row is skipped.
 */
export function planAssign(
  membership: AlbumTrackRow[],
  tracks: TrackRow[],
  albumId: number,
  trackIds: number[],
): AssignTracks | null {
  const tops = new Map<number, number>();
  for (const r of membership) {
    if (r.album_id !== albumId) continue;
    const disc = discOf(r);
    tops.set(disc, Math.max(tops.get(disc) ?? 0, r.track_no ?? 0));
  }
  const place = (discNo: number | null): number => {
    const disc = discNo ?? 1;
    const next = (tops.get(disc) ?? 0) + 1;
    tops.set(disc, next);
    return next;
  };

  const before: Placement[] = [];
  const after: Placement[] = [];
  const affected: number[] = [];
  for (const trackId of trackIds) {
    const current = membership.find((r) => r.track_id === trackId);
    if (current && current.album_id === albumId) continue;
    const row = joiningRow(albumId, trackId, current, tracks, place);
    if (!row) continue;
    affected.push(trackId);
    before.push(current ? { assigned: true, row: current } : { assigned: false, trackId });
    after.push({ assigned: true, row });
  }

  if (affected.length === 0) return null;
  return { kind: "assign", albumId, trackIds: affected, before, after };
}

/**
 * The row a track takes in `albumId`, shaped the way a reload returns it. A moving track keeps its
 * current row, whose edits and disc are already resolved; a loose one is built from the scan index, its
 * disc the edit over the raw tag. Edits and keep-own-cover follow a moving track; a loose one takes the
 * container cover. `place` claims the position on the track's disc.
 */
function joiningRow(
  albumId: number,
  trackId: number,
  current: AlbumTrackRow | undefined,
  tracks: TrackRow[],
  place: (disc: number | null) => number,
): AlbumTrackRow | null {
  if (current) {
    return { ...current, album_id: albumId, track_no: place(current.disc_no) };
  }
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const disc = track.disc_edit ?? track.raw_disc_no;
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: track.source_path,
    filename: track.filename,
    duration_secs: track.duration_secs,
    track_no: place(disc),
    disc_no: disc,
    raw_title: track.raw_title,
    raw_artist: track.raw_artist,
    title_override: track.title_edit,
    artist_override: track.artist_edit,
    has_embedded_cover: null,
    missing_at: track.missing_at,
    keep_own_cover: false,
    genre_ids: track.genre_ids,
  };
}
