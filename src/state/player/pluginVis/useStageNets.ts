/*
 * Mounts the stage nets once for the app: the marks reads, the sweep of crash crumbs left by offscreen
 * mounts, the hang, slow-frame and flash nets with the shown-hosts report, the meter switch and the
 * graphics-reset sentinel. Mounted by the shell.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Local Imports --
import { startVisMarks } from "./netPolicy";
import { startCrumbSweep } from "./offscreenCrumbs";
import { layReset, startStageNets, watchMeters } from "./stageNets";
import { useResetSentinel, type TrialKind } from "./useResetSentinel";

// -- State Imports --
import { showPluginNotice } from "../../plugins/pluginNotice";

// -- IPC Imports --
import { pluginVisShown } from "../../../lib/ipc";

const NO_KINDS: TrialKind[] = [];

export function useStageNets(): void {
  const [kinds, setKinds] = useState<TrialKind[]>(NO_KINDS);

  useEffect(() => startVisMarks(), []);
  useEffect(() => startCrumbSweep(), []);
  useEffect(() => watchMeters(), []);

  useEffect(() => {
    const nets = startStageNets({
      frame: (step) => requestAnimationFrame(step),
      cancelFrame: (id) => cancelAnimationFrame(id),
      every: (ms, beat) => setInterval(beat, ms),
      stopEvery: (id) => clearInterval(id),
      report: (hosts) => void pluginVisShown(hosts).catch(() => {}),
      notice: showPluginNotice,
      log: (kind, reading) => console.info(`visualizer ${kind} tripped the flash meter`, reading),
      onKinds: setKinds,
      docVisible: () => document.visibilityState === "visible",
    });
    // Samples after the mounts' own listeners have taken the change.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = () => {
      if (pending != null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        nets.sample();
      }, 0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (pending != null) clearTimeout(pending);
      nets.stop();
    };
  }, []);

  useResetSentinel(kinds, (lost) => layReset(lost, showPluginNotice));
}
