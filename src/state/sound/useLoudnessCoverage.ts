/*
 * The levelling coverage for the Settings block. It fetches on mount, when levelling turns on, and when a
 * scan ends (new files change the buckets), and follows the worker's `loudness:progress` events. A stale
 * fetch never overwrites a newer event.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { useAppStore } from "../store";

// -- IPC Imports --
import { loudnessCoverage } from "../../lib/ipc";

// -- Type Imports --
import type { LoudnessCoverage } from "../../types";

/** The latest coverage, or null until the first answer. */
export function useLoudnessCoverage(on: boolean): LoudnessCoverage | null {
  const [coverage, setCoverage] = useState<LoudnessCoverage | null>(null);
  const scanning = useAppStore((s) => s.scan.status === "scanning");

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    let eventSeen = false;

    void listen<LoudnessCoverage>("loudness:progress", (e) => {
      eventSeen = true;
      if (alive) setCoverage(e.payload);
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});

    loudnessCoverage()
      .then((fetched) => {
        if (alive && !eventSeen) setCoverage(fetched);
      })
      .catch(() => {});

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [on, scanning]);

  return coverage;
}
