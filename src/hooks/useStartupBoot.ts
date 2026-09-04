/*
 * The boot probe that decides what the one main window opens on: the shell in standalone player mode when
 * the OS cold-launched Plisto with a file, else the full library. It PULLS the take-once startup file on
 * mount rather than waiting on a push, so a slow first render never misses it. The pull is boot-race safe:
 * a rejection falls to the library, which boots normally, so a transient failure degrades to the full app
 * rather than stranding on the player. The window is full size on every path, so nothing here resizes it -
 * the App reveals the sidebar in place when the standalone player opens the library.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { getStartupFile } from "../lib/ipc";

// -- Local Imports --
import { withRetry } from "../lib/withRetry";

// The probe is take-once on the backend: the second read of a launch always comes back empty. StrictMode
// mounts the hook twice in dev, so the call is memoized at module scope and both mounts await the one
// promise - the file is read once, and a real reload (a fresh module) correctly re-reads it as empty.
//
// It is RETRIED: get_startup_file reads managed state, which setup() may not have finished standing up
// when the webview's first render fires it. A transient rejection must NOT read as "no file" - that
// stranded a real file-open on the full organizer, unplayed (the same boot race the library reads retry
// for). withRetry backs off until the state is up; a rejection only wins after every
// attempt is spent, and a genuinely empty read still resolves at once. Retries never consume the take -
// only a SUCCESSFUL read clears the stash, so at most one attempt ever takes the file.
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

/**
 * Probes the launch once and yields the phase the App renders from. The App owns the standalone player's
 * "Open library" reveal now: the shell stays mounted and only its sidebar slides in, so nothing here holds
 * the reveal state.
 */
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
        // Only after every retry is spent - managed state never came up, which means the app is broken
        // anyway. Fall to the full library as a last resort so it still opens rather than hanging on the
        // pending hold; a transient boot-race rejection was already retried away above.
        if (alive) setPhase("library");
      });
    return () => {
      alive = false;
    };
  }, []);

  return { phase, files };
}
