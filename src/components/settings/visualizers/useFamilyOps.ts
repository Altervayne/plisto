/*
 * What the catalog's plugin families can do: the same one-at-a-time operations as the Plugins section
 * (switch, review, uninstall, reload), one review sheet for installs from the Add visualizers row, and
 * the restart that leaves safe mode. Each section owns its controller, and the sheet covers the page
 * while it is open, so two sections never run an operation at once in practice.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Hook Imports --
import { useOperationLock } from "../plugins/useOperationLock";
import { useReviewFlow } from "../plugins/useReviewFlow";
import { useRowActions } from "../plugins/useRowActions";

// -- State Imports --
import { useDevMode } from "../../../state/plugins/store";
import { useRestart } from "../../../state/plugins/useRestart";

// -- Utils Imports --
import { appVersion } from "../../../lib/updater";

// -- Type Imports --
import type { RestartAction } from "../../../state/plugins/useRestart";
import type { PluginRow } from "../../../types";

/** The verbs a family's heading row and panel call. */
export interface FamilyOps {
  busy: boolean;
  devMode: boolean;
  /** The running Plisto version, when known, for a plugin that needs a newer one. */
  currentVersion: string | null;
  setEnabled: (row: PluginRow, on: boolean) => void;
  review: (row: PluginRow) => void;
  uninstall: (row: PluginRow) => void;
  reload: (row: PluginRow) => void;
  /** Restarts Plisto with plugins on again. */
  restartNormally: () => void;
}

export function useFamilyOps() {
  const lock = useOperationLock();
  const flow = useReviewFlow(lock, "catalog");
  const actions = useRowActions(lock, flow.openReview);
  const restart: RestartAction = useRestart();
  const [uninstalling, setUninstalling] = useState<PluginRow | null>(null);
  const devMode = useDevMode();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void appVersion().then((v) => {
      if (alive) setCurrentVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const busy = lock.busy || flow.sheet !== null;

  const ops: FamilyOps = {
    busy,
    devMode,
    currentVersion,
    setEnabled: (row, on) => void actions.setEnabled(row, on),
    review: (row) => void flow.openReview(row),
    uninstall: setUninstalling,
    reload: (row) => void actions.reload(row),
    restartNormally: () => restart.restart(false),
  };
  return { ops, flow, actions, restart, lock, uninstalling, setUninstalling, busy };
}
