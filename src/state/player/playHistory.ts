/*
 * The play-history reads for the Home previews: the recently- and most-played track ids fetched on
 * mount and on each recorded play, mapped through the in-memory track index to rows. The engine records
 * plays by id alone, so the ids resolve here against the same full library snapshot the player queue
 * reads. An id with no row - gone since it last played - drops out, and a cold empty result yields an
 * empty list.
 */

// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";

// -- State Imports --
import { useTracks } from "../store";
import { usePlaysVersion } from "./store";

// -- IPC Imports --
import {
  getMostPlayed,
  getMostPlayedRows,
  getPlayTimeline,
  getRecentlyPlayed,
  getRecentlyPlayedRows,
} from "../../lib/ipc";

// -- Type Imports --
import type { HistoryLens } from "../shell/store";
import type { HistoryStat, PlayEvent, TrackRow } from "../../types";

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

/**
 * Fetches a history query on mount and on each recorded play, then keeps its ids resolved against the
 * live track index. The plays version rises after the insert lands, so the refetch reads the new row in.
 */
function usePlayHistory(fetchIds: (limit: number) => Promise<number[]>, limit: number): TrackRow[] {
  const tracks = useTracks();
  const playsVersion = usePlaysVersion();
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
  }, [fetchIds, limit, playsVersion]);

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

/**
 * The full History listing for a lens: every play-log row (unbounded), resolved to library rows in
 * the read's order, plus a stat map the trailing column reads. Refetches on mount and on each recorded
 * play. An id whose track is gone drops from both the rows and the stats, so the two never disagree.
 */
export function useHistory(
  lens: HistoryLens,
  since?: number,
): { rows: TrackRow[]; stats: Map<number, HistoryStat> } {
  const tracks = useTracks();
  const playsVersion = usePlaysVersion();
  const [historyRows, setHistoryRows] = useState<Array<HistoryStat & { track_id: number }>>([]);

  useEffect(() => {
    let alive = true;
    // `since` windows the most-played ranking only; the recent list has no window.
    const load = lens === "recent" ? getRecentlyPlayedRows() : getMostPlayedRows(undefined, since);
    void load
      .then((result) => {
        if (alive) {
          setHistoryRows(
            result.map((r) => ({
              track_id: r.track_id,
              lastPlayedAt: r.last_played_at,
              playCount: r.play_count,
            })),
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lens, since, playsVersion]);

  return useMemo(() => {
    const rows = resolveTrackRows(
      historyRows.map((r) => r.track_id),
      tracks,
    );
    // Stats only for the ids that survived the resolve, so a gone track leaves no orphan stat behind.
    const surviving = new Set(rows.map((r) => r.id));
    const stats = new Map<number, HistoryStat>();
    for (const r of historyRows) {
      if (surviving.has(r.track_id)) {
        stats.set(r.track_id, { lastPlayedAt: r.lastPlayedAt, playCount: r.playCount });
      }
    }
    return { rows, stats };
  }, [historyRows, tracks]);
}

/**
 * One resolved timeline entry: the play's own id, its library row, when it played, and whether it ran
 * to the end. Keyed by playId, so a repeat of the same track stays a distinct entry.
 */
export interface TimelineEntry {
  playId: number;
  track: TrackRow;
  playedAt: number;
  completed: boolean;
}

/**
 * The full play-log timeline (unbounded), every listen resolved to its library row in the read's
 * newest-first order. Refetches on mount and on each recorded play. A repeat is kept - the log is
 * chronological, not deduped - and an event whose track is gone drops out, so no orphan entry survives.
 */
export function usePlayTimeline(): TimelineEntry[] {
  const tracks = useTracks();
  const playsVersion = usePlaysVersion();
  const [events, setEvents] = useState<PlayEvent[]>([]);

  useEffect(() => {
    let alive = true;
    void getPlayTimeline()
      .then((result) => {
        if (alive) setEvents(result);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [playsVersion]);

  return useMemo(() => {
    const byId = new Map(tracks.map((t) => [t.id, t] as const));
    const entries: TimelineEntry[] = [];
    for (const e of events) {
      const track = byId.get(e.track_id);
      if (track) {
        entries.push({ playId: e.play_id, track, playedAt: e.played_at, completed: e.completed });
      }
    }
    return entries;
  }, [events, tracks]);
}
