/*
 * The log panel's read of one plugin's log: once on selection, then again every couple of seconds while
 * the panel is open. A failed read keeps what was shown and marks the log as failed; a result for a
 * plugin that is no longer selected is dropped.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { pluginLogTail } from "../../../lib/ipc";

// -- Type Imports --
import type { PluginLogTail } from "../../../types";

const POLL_MS = 2000;

interface Read {
  id: string;
  tail: PluginLogTail | null;
  failed: boolean;
}

export interface LogTailView {
  /** Null until the first read of the selected plugin finishes. */
  tail: PluginLogTail | null;
  /** The last read failed; `tail` still holds the earlier one, if any. */
  failed: boolean;
}

const sameTail = (a: PluginLogTail | null, b: PluginLogTail): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

export function useLogTail(id: string | null): LogTailView {
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = () =>
      pluginLogTail(id)
        .then((tail) => {
          if (!alive) return;
          setRead((prev) =>
            prev && prev.id === id && !prev.failed && sameTail(prev.tail, tail)
              ? prev
              : { id, tail, failed: false },
          );
        })
        .catch((e: unknown) => {
          console.warn("plugin log read failed", e);
          if (alive) setRead((prev) => ({ id, tail: prev?.id === id ? prev.tail : null, failed: true }));
        });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  const current = read && read.id === id ? read : null;
  return { tail: current?.tail ?? null, failed: current?.failed ?? false };
}
