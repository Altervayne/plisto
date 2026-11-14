/*
 * Restarts a plugin from a surface that offers it (a crash card or a hub row). Its frame, if it has one, is
 * remounted fresh at once; Rust restarts the plugin with a clean crash count and reports `starting`. A
 * refusal is logged and leaves the surface where it is. A page's crash card restarts only the frame when
 * the plugin is native and its process is running: the process is healthy and may hold the audio output.
 */

// -- State Imports --
import { logInstallError } from "./errors";
import { useFrameHealthStore } from "./frameHealth";

// -- IPC Imports --
import { pluginRestart } from "../../lib/ipc";

// -- Type Imports --
import type { PluginRow, PluginStatus } from "../../types";

export function restartPlugin(row: Pick<PluginRow, "id">): void {
  useFrameHealthStore.getState().restart(row.id);
  pluginRestart(row.id).catch((e) => {
    logInstallError("restart", e);
  });
}

/** What a page's Restart restarts: the page frame alone, or the whole plugin. */
export function pageRestartScope(
  row: Pick<PluginRow, "tier">,
  status: Pick<PluginStatus, "host"> | undefined,
): "frame" | "process" {
  return row.tier === "native" && status?.host === "running" ? "frame" : "process";
}

/** Restart from a plugin page's crash card. */
export function restartFromPage(row: Pick<PluginRow, "id" | "tier">, status: PluginStatus | undefined): void {
  if (pageRestartScope(row, status) === "frame") useFrameHealthStore.getState().restart(row.id);
  else restartPlugin(row);
}
