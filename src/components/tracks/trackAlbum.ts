/*
 * The track-album resolver: a track's displayed album, album-artist, and year, joining the row's own
 * edits over the album it is filed into. A member inherits the album's fields; a per-track edit still
 * wins; the stale raw file tag is hidden for a member. A loose track keeps edit-over-raw. This is the one
 * place the membership-join precedence lives, so the grid, the facets, and the Home counts stay in step.
 */

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

/**
 * Maps each membership row's track to its AlbumRow, so a member can inherit its container's fields. Built
 * from every album, both kinds, since a single's member needs its single's title. UNIQUE(track_id) means a
 * track sits in one album, so a plain last-write Map needs no tie-break.
 */
export function buildAlbumIndex(
  membership: AlbumTrackRow[],
  albums: AlbumRow[],
): Map<number, AlbumRow> {
  const albumById = new Map(albums.map((a) => [a.id, a] as const));
  const index = new Map<number, AlbumRow>();
  for (const row of membership) {
    const album = albumById.get(row.album_id);
    if (album) index.set(row.track_id, album);
  }
  return index;
}

/** The displayed album: a member's per-track edit over its album's title, a loose track's edit over its
 *  raw tag. An empty result folds to null. */
export function resolveTrackAlbum(track: TrackRow, index: Map<number, AlbumRow>): string | null {
  const album = index.get(track.id);
  const value = album ? track.album_edit ?? album.title : track.album_edit ?? track.raw_album;
  return value ? value : null;
}

/** The displayed album-artist: a member's per-track edit over its album's album-artist, a loose track's
 *  edit over its raw tag. An empty result folds to null. */
export function resolveTrackAlbumArtist(
  track: TrackRow,
  index: Map<number, AlbumRow>,
): string | null {
  const album = index.get(track.id);
  const value = album
    ? track.album_artist_edit ?? album.album_artist
    : track.album_artist_edit ?? track.raw_album_artist;
  return value ? value : null;
}

/** The displayed year as a string: a member's per-track edit over its album's year, a loose track's edit
 *  over its raw tag. Null when absent. */
export function resolveTrackYear(track: TrackRow, index: Map<number, AlbumRow>): string | null {
  const album = index.get(track.id);
  const value = album ? track.year_edit ?? album.year : track.year_edit ?? track.raw_year;
  return value != null ? String(value) : null;
}

/** Whether the track is filed into a single. The missing-metadata predicate exempts a single from
 *  needing an album. */
export function isSingleMember(track: TrackRow, index: Map<number, AlbumRow>): boolean {
  return index.get(track.id)?.kind === "single";
}
