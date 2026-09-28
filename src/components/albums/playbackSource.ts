// -- Type Imports --
import type { AlbumRow, PlaybackSource } from "../../types";

/**
 * The playback source for a play launched from an album row. A single shares the album row but has no
 * full pane of its own, so it tags the Singles view instead of an album.
 */
export function sourceForContainer(
  album: Pick<AlbumRow, "id" | "kind" | "title">,
  untitled: string,
): PlaybackSource {
  if (album.kind === "single") return { kind: "singles" };
  return { kind: "album", id: album.id, label: album.title ?? untitled };
}
