/*
 * The queue's per-track display snapshot. The engine's queue is bare ids, and the up-next view outlives
 * the view that launched it - play an album, then browse Files, and the album rows are no longer in the
 * active cache. So play captures a metadata snapshot here, resolved from the rows loaded at play-time,
 * and the view renders from it rather than chasing rows that have moved on.
 */

// -- Type Imports --
import type { TrackRow } from "../../types";

/**
 * One queue row's display fields. `artist` is null when neither layer holds one, left for the view to
 * localize the way every other now-playing surface does; `title` always resolves to a string, falling
 * back to the filename. `durationSecs` is null for a track whose length is unknown.
 */
export interface QueueTrackMeta {
  title: string;
  artist: string | null;
  durationSecs: number | null;
}

/**
 * Resolves the display snapshot for each queued id from the rows on hand, edit layer over the raw scan
 * tag - the same coalescing the grid and the mini use. An id with no row (a filtered or evicted cache)
 * yields an empty placeholder rather than a hole, so the view never reads undefined for a queue slot.
 */
export function snapshotQueueMeta(
  trackIds: number[],
  rows: TrackRow[],
): Record<number, QueueTrackMeta> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const meta: Record<number, QueueTrackMeta> = {};
  for (const id of trackIds) {
    const row = byId.get(id);
    meta[id] = row
      ? {
          title: row.title_edit ?? row.raw_title ?? row.filename,
          artist: row.artist_edit ?? row.raw_artist ?? null,
          durationSecs: row.duration_secs,
        }
      : { title: "", artist: null, durationSecs: null };
  }
  return meta;
}
