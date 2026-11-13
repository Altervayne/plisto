/*
 * A plugin's saved data size, read once when the calling component mounts. A failed read is its own
 * outcome, so a caller can show nothing rather than a wrong zero.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { pluginDataSize } from "../../../lib/ipc";

export type DataSize = { status: "loading" } | { status: "ready"; bytes: number } | { status: "failed" };

export function useDataSize(id: string): DataSize {
  const [size, setSize] = useState<DataSize>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    pluginDataSize(id)
      .then((bytes) => alive && setSize({ status: "ready", bytes }))
      .catch((e: unknown) => {
        console.warn("plugin data size read failed", e);
        if (alive) setSize({ status: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return size;
}
