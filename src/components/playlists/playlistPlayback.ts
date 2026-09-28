/*
 * The whole-playlist play math: what a playlist queues and whether it has anything to play. Pure over the
 * slots, so the row disc, the row menu, and the header button share one rule. A gone source stays in the
 * queue like it does for the album and per-track plays: the engine skips a track that fails to open.
 */

// -- Type Imports --
import type { PlaylistTrackRow } from "../../types";

/** Every slot's track id in slot order. A track held twice queues twice, once per slot. */
export function playlistQueue(slots: Pick<PlaylistTrackRow, "track_id" | "position">[]): number[] {
  return [...slots].sort((a, b) => a.position - b.position).map((slot) => slot.track_id);
}

/** True when at least one slot's source is still present. */
export function hasPlayableSlot(slots: Pick<PlaylistTrackRow, "missing_at">[]): boolean {
  return slots.some((slot) => slot.missing_at == null);
}
