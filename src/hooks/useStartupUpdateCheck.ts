/*
 * The quiet update check after launch. It waits past boot so the request never competes with the library
 * load, and it runs only in the main window's full app: the tray popup, the pop-out widget and the
 * open-file player never call it. Nothing shows unless an update exists.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- State Imports --
import { useCheckForUpdate } from "../state/updater/store";

/** How long after boot the check waits. */
const STARTUP_DELAY_MS = 5000;

/** Schedules the one startup check once `enabled` turns true. */
export function useStartupUpdateCheck(enabled: boolean): void {
  const check = useCheckForUpdate();

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void check("startup"), STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, check]);
}
