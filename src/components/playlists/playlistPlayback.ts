/*
 * Whether a playlist has anything to play. Pure over the expanded entries, so the row disc, the row menu,
 * and the header button share one rule. A gone source stays in the queue like it does for the album and
 * per-track plays: the engine skips a track that fails to open.
 */

// -- Type Imports --
import type { PlaylistEntry } from "./playlistExpand";

/** True when at least one track is still present, whether a slot or a member of an album entry. */
export function hasPlayableSlot(entries: PlaylistEntry[]): boolean {
  return entries.some((item) =>
    item.kind === "track"
      ? item.slot.missing_at == null
      : item.members.some((member) => member.missing_at == null),
  );
}
