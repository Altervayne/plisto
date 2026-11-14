// -- Framework Imports --
import { useCallback, useState } from "react";

// -- Utils Imports --
import { pluginTakeoverRelease } from "../../lib/ipc";
import { returnOutput } from "./returnOutput";

/**
 * Drives the Return button: one release at a time, and Plisto's app-level notice after a successful one.
 * `holderId` is null when no holder is known.
 */
export function useReturnOutput(): { busy: boolean; giveBack: (holderId: string | null) => void } {
  const [busy, setBusy] = useState(false);

  const giveBack = useCallback((holderId: string | null) => {
    setBusy(true);
    void returnOutput(pluginTakeoverRelease, holderId).finally(() => setBusy(false));
  }, []);

  return { busy, giveBack };
}
