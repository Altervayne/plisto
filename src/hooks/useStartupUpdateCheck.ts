/*
 * The quiet update check after launch. It waits past boot so the request never competes with the library
 * load, and it runs only in the main window's full app: the tray popup, the pop-out widget and the
 * open-file player never call it. It also waits for the preferences, so an absent switch is never read
 * as on before the stored value arrives, and it stays off when the user turned the check off. Nothing
 * shows unless an update exists.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- State Imports --
import { usePreferencesLoaded, useUpdaterAutoCheck } from "../state/preferences/store";
import { startupCheckArmed } from "../state/updater/machine";
import { useCheckForUpdate } from "../state/updater/store";

/** How long after boot the check waits. */
const STARTUP_DELAY_MS = 5000;

/** Schedules the one startup check once `enabled` turns true, preferences are loaded and auto-check is on. */
export function useStartupUpdateCheck(enabled: boolean): void {
  const check = useCheckForUpdate();
  const loaded = usePreferencesLoaded();
  const autoCheck = useUpdaterAutoCheck();
  const armed = startupCheckArmed({ ready: enabled, prefsLoaded: loaded, autoCheck });

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => void check("startup"), STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [armed, check]);
}
