/*
 * The proxy state of the current network, read once when a surface that shows a network line mounts.
 * A failed read is "none": the warning is information and never blocks anything.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { pluginNetEnvironment } from "../../lib/ipc";

// -- Type Imports --
import type { PluginNetEnvironment } from "../../types";

/** One read; a rejected call reads as "none". */
export function readProxy(): Promise<PluginNetEnvironment["proxy"]> {
  return pluginNetEnvironment().then(
    (env) => env.proxy,
    () => "none" as const,
  );
}

/** Makes no call while `enabled` is false. */
export function useNetEnvironment(enabled: boolean): PluginNetEnvironment["proxy"] {
  const [proxy, setProxy] = useState<PluginNetEnvironment["proxy"]>("none");

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    readProxy().then((value) => alive && setProxy(value));
    return () => {
      alive = false;
    };
  }, [enabled]);

  return proxy;
}
