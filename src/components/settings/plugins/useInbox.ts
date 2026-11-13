/*
 * What waits in the plugins inbox folder. Read on mount and again whenever the installed rows change, so
 * an item that was just installed or removed is reflected without a manual refresh. A failed read keeps
 * the last list.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { pluginInbox } from "../../../lib/ipc";

// -- Type Imports --
import type { PluginInboxItem, PluginRow } from "../../../types";

export function useInbox(rows: PluginRow[]): PluginInboxItem[] {
  const [items, setItems] = useState<PluginInboxItem[]>([]);

  useEffect(() => {
    let alive = true;
    pluginInbox()
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch((e: unknown) => console.warn("plugin inbox read failed", e));
    return () => {
      alive = false;
    };
  }, [rows]);

  return items;
}
