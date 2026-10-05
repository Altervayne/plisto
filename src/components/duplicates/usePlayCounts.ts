// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { usePlaysVersion } from "../../state/player/store";

// -- IPC Imports --
import { getMostPlayedRows } from "../../lib/ipc";

// The last read and the plays version it answers, kept across opens so a reopen paints at once.
let cached: { version: number; counts: Map<number, number> } | null = null;

/**
 * Every track's raw play count from one play-log read, refetched only when the plays version moves.
 * Null until the first read lands, or when it fails.
 */
export function usePlayCounts(): Map<number, number> | null {
  const version = usePlaysVersion();
  const [counts, setCounts] = useState<Map<number, number> | null>(() =>
    cached?.version === version ? cached.counts : null,
  );

  useEffect(() => {
    if (cached?.version === version) {
      setCounts(cached.counts);
      return;
    }
    let alive = true;
    void getMostPlayedRows()
      .then((rows) => {
        const map = new Map(rows.map((r) => [r.track_id, r.play_count] as const));
        cached = { version, counts: map };
        if (alive) setCounts(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);

  return counts;
}
