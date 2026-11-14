/*
 * Restarts a plugin from a surface that offers it (a crash card or a hub row). A UI plugin's frame is
 * remounted fresh at once; Rust restarts the plugin with a clean crash count and reports `starting`. A
 * refusal is logged and leaves the surface where it is.
 */

// -- State Imports --
import { logInstallError } from "./errors";
import { useFrameHealthStore } from "./frameHealth";

// -- IPC Imports --
import { pluginRestart } from "../../lib/ipc";

// -- Type Imports --
import type { PluginRow } from "../../types";

export function restartPlugin(row: Pick<PluginRow, "id" | "tier">): void {
  if (row.tier === "ui") useFrameHealthStore.getState().restart(row.id);
  pluginRestart(row.id).catch((e) => {
    logInstallError("restart", e);
  });
}
