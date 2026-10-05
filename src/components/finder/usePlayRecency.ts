// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { usePlaysVersion } from "../../state/player/store";

// -- IPC Imports --
import { getMostPlayedRows } from "../../lib/ipc";

const NO_PLAYS: ReadonlyMap<number, number> = new Map();

// The read per plays version, kept across opens so a reopen with no new play reads nothing over IPC,
// and shared while in flight so a remount never doubles it. A failed read is dropped, so the next open
// retries.
let latest: { version: number; read: Promise<ReadonlyMap<number, number>> } | null = null;
let settled: { version: number; lastPlayed: ReadonlyMap<number, number> } | null = null;

function readFor(version: number): Promise<ReadonlyMap<number, number>> {
  if (latest?.version !== version) {
    const read = getMostPlayedRows().then((rows) => {
      const lastPlayed = new Map(rows.map((row) => [row.track_id, row.last_played_at] as const));
      settled = { version, lastPlayed };
      return lastPlayed;
    });
    read.catch(() => {
      if (latest?.read === read) latest = null;
    });
    latest = { version, read };
  }
  return latest.read;
}

/**
 * Each track's last play (unix seconds), read once when the finder opens and again only after a new
 * play lands. A failed read leaves the map empty, so ranking falls through to its other tie-breaks.
 */
export function usePlayRecency(): ReadonlyMap<number, number> {
  const version = usePlaysVersion();
  const [lastPlayed, setLastPlayed] = useState<ReadonlyMap<number, number>>(() =>
    settled?.version === version ? settled.lastPlayed : NO_PLAYS,
  );

  useEffect(() => {
    let alive = true;
    void readFor(version)
      .then((map) => {
        if (alive) setLastPlayed(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);

  return lastPlayed;
}
