/*
 * The play-history reads for the Home previews: the recently- and most-played track ids fetched on
 * mount, mapped through the in-memory track index to rows. The engine records plays by id alone, so the
 * ids resolve here against the same full library snapshot the player queue reads. An id with no row -
 * gone since it last played - drops out, and a cold empty result yields an empty list.
 */

// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";

// -- State Imports --
import { useTracks } from "../store";

// -- IPC Imports --
import { getMostPlayed, getRecentlyPlayed } from "../../lib/ipc";

// -- Type Imports --
import type { TrackRow } from "../../types";

/**
 * Resolves play-history ids to their library rows in id order, dropping any id the index no longer
 * carries. Pure so the previews and the tests read one source.
 */
export function resolveTrackRows(ids: number[], tracks: TrackRow[]): TrackRow[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const rows: TrackRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) rows.push(row);
  }
  return rows;
}

/** Fetches a history query once on mount, then keeps its ids resolved against the live track index. */
function usePlayHistory(fetchIds: (limit: number) => Promise<number[]>, limit: number): TrackRow[] {
  const tracks = useTracks();
  const [ids, setIds] = useState<number[]>([]);

  useEffect(() => {
    let alive = true;
    void fetchIds(limit)
      .then((result) => {
        if (alive) setIds(result);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fetchIds, limit]);

  return useMemo(() => resolveTrackRows(ids, tracks), [ids, tracks]);
}

/** The most recently played tracks, newest first, resolved to rows. */
export function useRecentlyPlayed(limit: number): TrackRow[] {
  return usePlayHistory(getRecentlyPlayed, limit);
}

/** The most played tracks by weighted score, highest first, resolved to rows. */
export function useMostPlayed(limit: number): TrackRow[] {
  return usePlayHistory(getMostPlayed, limit);
}
