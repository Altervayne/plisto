/*
 * The production wiring of the host shim: the real window, the `plugin_call` and `plugin_fetch` commands,
 * the theme runtime, the frame-gone report to Rust and the plugins' grants.
 */

// -- State Imports --
import { useFrameHealthStore } from "./frameHealth";
import { defaultSleep } from "./hostCall";
import { useSidebarState } from "./sidebarState";
import { usePluginsStore } from "./store";

// -- IPC Imports --
import { pluginCall, pluginFetch, pluginFrameEvent } from "../../lib/ipc";

// -- Utils Imports --
import { isDarkTheme, subscribeTheme } from "../../theme";

// -- Type Imports --
import type { HostDeps } from "./pluginHost";
import type { PluginFrameCrashReason, PluginFrameEventKind } from "../../types";

/**
 * Tells Rust how a plugin's frame stands. Best-effort: Rust's own deadlines still free what a lost
 * report would have released, and the next report overwrites a stale one.
 */
export function reportFrame(pluginId: string, kind: PluginFrameEventKind, reason?: PluginFrameCrashReason): void {
  pluginFrameEvent(pluginId, kind, reason).catch(() => {});
}

/** The production dependencies: the real window, the `plugin_call` and `plugin_fetch` commands and the theme runtime. */
export function browserHostDeps(): HostDeps {
  return {
    addListener: (onMessage) => {
      const handler = (event: MessageEvent) => onMessage(event);
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
    invoke: pluginCall,
    fetch: pluginFetch,
    theme: () => (isDarkTheme() ? "dark" : "light"),
    subscribeTheme,
    sleep: defaultSleep,
    frameGone: (pluginId) => {
      const health = useFrameHealthStore.getState().health[pluginId];
      const crashed = health?.phase === "crashed";
      reportFrame(pluginId, crashed ? "crashed" : "detached", crashed ? health.reason : undefined);
      if (crashed) useSidebarState.getState().drop(pluginId);
    },
    granted: (pluginId) => usePluginsStore.getState().rows.find((row) => row.id === pluginId)?.granted ?? [],
    devMode: () => usePluginsStore.getState().devMode,
  };
}
