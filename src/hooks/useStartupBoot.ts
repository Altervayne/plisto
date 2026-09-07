/*
 * The boot probe that decides what the one main window opens on: standalone player mode when the OS
 * cold-launched Plisto with a file, else the full library. It PULLS the take-once startup file on mount
 * so a slow first render never misses it, and is boot-race safe: a rejection falls to the library. The
 * window is full size on every path, so nothing here resizes it.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { getStartupFile } from "../lib/ipc";

// -- Local Imports --
import { withRetry } from "../lib/withRetry";

// The probe is take-once on the backend, so a second read comes back empty. StrictMode mounts the hook
// twice in dev, so the promise is memoized at module scope and both mounts await the one read.
//
// Retried: get_startup_file reads managed state setup() may not have finished when the first render fires
// (the same boot race the library reads retry for). A transient rejection must not read as "no file" and
// strand a real file-open on the organizer; only a successful read consumes the take.
let startupProbe: Promise<string[] | null> | null = null;
function probeStartupFile(): Promise<string[] | null> {
  if (!startupProbe) startupProbe = withRetry(() => getStartupFile());
  return startupProbe;
}

/** Which content the window shows: pending while the probe is in flight, then standalone or library. */
export type StartupPhase = "pending" | "standalone" | "library";

export interface StartupBoot {
  phase: StartupPhase;
  // The files the launch carried, for the standalone player to play. Empty off the standalone phase.
  files: string[];
}

/** Probes the launch once and yields the phase the App renders from. */
export function useStartupBoot(): StartupBoot {
  const [phase, setPhase] = useState<StartupPhase>("pending");
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void probeStartupFile()
      .then((paths) => {
        if (!alive) return;
        if (paths && paths.length > 0) {
          setFiles(paths);
          setPhase("standalone");
        } else {
          setPhase("library");
        }
      })
      .catch(() => {
        // Only after every retry is spent: managed state never came up. Fall to the full library so the
        // app still opens rather than hanging on the pending hold.
        if (alive) setPhase("library");
      });
    return () => {
      alive = false;
    };
  }, []);

  return { phase, files };
}
