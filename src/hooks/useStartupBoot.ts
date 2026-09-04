/*
 * The boot probe that decides which tree the one main window renders: the compact standalone player when
 * the OS cold-launched Plisto with a file, else the full library. It PULLS the take-once startup file on
 * mount rather than waiting on a push, so a slow first render never misses it. The pull is boot-race safe:
 * a rejection falls to the library, which boots normally, so a transient failure degrades to the full app
 * rather than stranding on the player.
 */

// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";

// -- IPC Imports --
import { getStartupFile } from "../lib/ipc";

// -- Window Imports --
import { resizeWindow, setWindowMinSize } from "../lib/appWindow";

/** The full window's size and floor, matching tauri.conf.json, restored when the player escalates. */
const FULL_WIDTH = 1200;
const FULL_HEIGHT = 800;
const FULL_MIN_WIDTH = 900;
const FULL_MIN_HEIGHT = 600;

// The probe is take-once on the backend: the second read of a launch always comes back empty. StrictMode
// mounts the hook twice in dev, so the call is memoized at module scope and both mounts await the one
// promise - the file is read once, and a real reload (a fresh module) correctly re-reads it as empty.
let startupProbe: Promise<string[] | null> | null = null;
function probeStartupFile(): Promise<string[] | null> {
  if (!startupProbe) startupProbe = getStartupFile();
  return startupProbe;
}

/** Which tree the window shows: pending while the probe is in flight, then standalone or library. */
export type StartupPhase = "pending" | "standalone" | "library";

export interface StartupBoot {
  phase: StartupPhase;
  // The files the launch carried, for the standalone player to play. Empty off the standalone phase.
  files: string[];
  // Set once the user leaves the compact player for the full library. One-way for the session.
  escalated: boolean;
  // Swaps the window to the library: lifts the min size, grows to the full size, then flips the tree.
  escalate: () => void;
}

/**
 * Probes the launch once and yields the phase the App renders from. `escalate` is the compact player's
 * "Open library" path: it grows the window back to full and flips `escalated`, so the App drops the
 * player for the normal library gate. The grow lifts the min size before the size, so the old compact
 * floor never clamps the target.
 */
export function useStartupBoot(): StartupBoot {
  const [phase, setPhase] = useState<StartupPhase>("pending");
  const [files, setFiles] = useState<string[]>([]);
  const [escalated, setEscalated] = useState(false);

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
        // A failed probe falls to the full library rather than the player: the launch file is lost, but
        // the app still opens and boots its library normally.
        if (alive) setPhase("library");
      });
    return () => {
      alive = false;
    };
  }, []);

  const escalate = useCallback(() => {
    setEscalated(true);
    // Min first, then the grow: the min must lift before the size, or the compact floor clamps it.
    void setWindowMinSize(FULL_MIN_WIDTH, FULL_MIN_HEIGHT).then(() =>
      resizeWindow(FULL_WIDTH, FULL_HEIGHT),
    );
  }, []);

  return { phase, files, escalated, escalate };
}
