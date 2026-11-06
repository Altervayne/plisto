// -- Type Imports --
import type { AlbumRow } from "../../../types";

/** The DOM id of a record's option, which the listbox names as its active descendant. */
export const recordId = (albumId: number): string => `browse-record-${albumId}`;

/** "Title, Artist, year", skipping what the album does not carry: the record's spoken name. */
export function recordLabel(album: AlbumRow, untitled: string): string {
  const parts = [album.title ?? untitled, album.album_artist, album.year];
  return parts.filter((part) => part != null && part !== "").join(", ");
}
