// -- Type Imports --
import type { AlbumTrackRow, PlaylistAlbumEntryRow, PlaylistTrackRow } from "../../types";

/** A track slot with only the fields the expansion reads; the rest are inert. */
export function slotRow(
  id: number,
  position: number,
  track_id: number,
  missing_at: number | null = null,
  playlist_id = 1,
): PlaylistTrackRow {
  return {
    id,
    playlist_id,
    track_id,
    position,
    source_path: "",
    display_path: null,
    filename: "",
    duration_secs: null,
    raw_title: null,
    raw_artist: null,
    title: null,
    artist: null,
    missing_at,
  };
}

/** An album entry row. */
export function entryRow(
  id: number,
  position: number,
  album_id: number,
  keep_order: boolean,
  playlist_id = 1,
): PlaylistAlbumEntryRow {
  return { id, playlist_id, album_id, position, keep_order };
}

/** A membership row with only the fields the expansion reads; the rest are inert. */
export function memberRow(
  album_id: number,
  track_id: number,
  disc_no: number | null,
  track_no: number | null,
  missing_at: number | null = null,
): AlbumTrackRow {
  return {
    album_id,
    track_id,
    source_path: "",
    filename: "",
    duration_secs: null,
    track_no,
    disc_no,
    raw_title: null,
    raw_artist: null,
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at,
    keep_own_cover: false,
    genre_ids: [],
  };
}
