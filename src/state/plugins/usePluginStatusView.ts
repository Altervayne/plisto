/*
 * The one hook every plugin surface reads its status through: the runtime gate and the plugin's status,
 * run through the pure model.
 */

// -- State Imports --
import { usePluginStatusOf } from "./pluginStatus";
import { statusView } from "./statusModel";
import { usePluginRuntime } from "./store";

// -- Type Imports --
import type { StatusView } from "./statusModel";
import type { PluginRow } from "../../types";

export function usePluginStatusView(row: PluginRow): StatusView {
  const runtime = usePluginRuntime();
  const status = usePluginStatusOf(row.id);
  return statusView(runtime, row, status);
}
