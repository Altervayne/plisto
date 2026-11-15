/*
 * The restart request shared by the safe-mode banner and the Settings entry. A refusal means the app
 * kept running (nothing was torn down), so it comes back as the error key the surface shows; a restart
 * that went through never resolves.
 */

// -- Framework Imports --
import { useCallback, useState } from "react";

// -- IPC Imports --
import { pluginsRestart } from "../../lib/ipc";

// -- Utils Imports --
import { logInstallError } from "./errors";

// -- Type Imports --
import type { PluginErrorKey } from "./errors";

/** Asks for a restart, with plugins off when `safe`. Null when the call returned, else why it was refused. */
export async function attemptRestart(
  safe: boolean,
  send: (safe: boolean) => Promise<void> = pluginsRestart,
): Promise<PluginErrorKey | null> {
  try {
    await send(safe);
    return null;
  } catch (e) {
    return logInstallError("restart", e);
  }
}

export interface RestartAction {
  error: PluginErrorKey | null;
  restart: (safe: boolean) => void;
  dismiss: () => void;
}

export function useRestart(): RestartAction {
  const [error, setError] = useState<PluginErrorKey | null>(null);
  const restart = useCallback((safe: boolean) => {
    setError(null);
    void attemptRestart(safe).then(setError);
  }, []);
  const dismiss = useCallback(() => setError(null), []);
  return { error, restart, dismiss };
}
