/*
 * How many playlists hold an album, for the delete confirm: deleting an album dissolves its playlist
 * entries into plain tracks, so the confirm says so when any exist. Pure over the entry rows.
 */

// -- Type Imports --
import type { PlaylistAlbumEntryRow } from "../../types";

/** The number of distinct playlists with an entry for the album; two entries in one playlist count once. */
export function playlistsHoldingAlbum(entries: PlaylistAlbumEntryRow[], albumId: number): number {
  return new Set(entries.filter((e) => e.album_id === albumId).map((e) => e.playlist_id)).size;
}

/** The picked albums' ids in the order the wall shows them, whatever order they were picked in. */
export function pickedAlbumIds(wall: { id: number }[], picked: ReadonlySet<number>): number[] {
  return wall.filter((album) => picked.has(album.id)).map((album) => album.id);
}

/** How many of the albums sit in at least one playlist. */
export function albumsInPlaylists(entries: PlaylistAlbumEntryRow[], albumIds: number[]): number {
  const held = new Set(entries.map((e) => e.album_id));
  return albumIds.filter((id) => held.has(id)).length;
}
