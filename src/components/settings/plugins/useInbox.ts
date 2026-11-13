/*
 * What waits in the plugins inbox folder. Read on mount, when the installed rows change, when the window
 * regains focus, and on a quiet interval while visible, so a dropped file shows up without leaving
 * Settings. A failed read keeps the last list.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { pluginInbox } from "../../../lib/ipc";

// -- Local Imports --
import { browserInboxEnv, sameInboxItems, startInboxPoller } from "./inboxPoller";

// -- Type Imports --
import type { PluginInboxItem, PluginRow } from "../../../types";

export function useInbox(rows: PluginRow[]): PluginInboxItem[] {
  const [items, setItems] = useState<PluginInboxItem[]>([]);

  useEffect(
    () =>
      startInboxPoller({
        read: pluginInbox,
        // Keep the previous array when nothing changed so the list does not re-render.
        onList: (list) => setItems((prev) => (sameInboxItems(prev, list) ? prev : list)),
        onError: (e) => console.warn("plugin inbox read failed", e),
        env: browserInboxEnv,
      }),
    [rows],
  );

  return items;
}
