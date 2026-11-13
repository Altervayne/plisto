// -- Framework Imports --
import { useRef, useState } from "react";

// -- State Imports --
import { usePluginsStore } from "../../../state/plugins/store";

// -- IPC Imports --
import { pluginSetSidebarCollapsed } from "../../../lib/ipc";

/**
 * The fold state of one plugin section. A toggle shows at once and saves through the backend; the
 * saved row replaces the stored one, and a failed save drops the shown value back to the stored one and
 * logs. A press while a save is in flight is ignored.
 */
export function usePluginCollapse(id: string, stored: boolean): { collapsed: boolean; toggle: () => void } {
  const [pending, setPending] = useState<boolean | null>(null);
  const inFlight = useRef(false);

  const toggle = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const next = !(pending ?? stored);
    setPending(next);
    void pluginSetSidebarCollapsed(id, next)
      .then((row) => usePluginsStore.getState().upsertRow(row))
      .catch((e: unknown) => console.warn(`plugin sidebar collapse not saved for ${id}:`, e))
      .finally(() => {
        inFlight.current = false;
        setPending(null);
      });
  };

  return { collapsed: pending ?? stored, toggle };
}
