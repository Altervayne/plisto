// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import { usePluginRuntime, usePlugins } from "../../../state/plugins/store";
import { useAppMode } from "../../../state/player/store";

// -- Unit Imports --
import { pluginZoneModel } from "../../shell/navVisibility";
import type { PluginZoneModel } from "../../shell/navVisibility";
import type { AppMode } from "../../../state/player/store";
import type { PluginRow, PluginRuntime } from "../../../types";

const EMPTY_ZONE: PluginZoneModel = { sections: [], compact: [] };

/** The zone for the rows and mode, empty while the session runs without plugins. */
export function zoneFor(rows: readonly PluginRow[], appMode: AppMode, runtime: PluginRuntime | null): PluginZoneModel {
  return runtime === "safe" ? EMPTY_ZONE : pluginZoneModel(rows, appMode);
}

/**
 * The plugin zone for the current app mode and runtime. Derived only when the registry rows, the mode
 * or the runtime change, so a consumer re-renders on nothing else.
 */
export function usePluginZone(): PluginZoneModel {
  const rows = usePlugins();
  const appMode = useAppMode();
  const runtime = usePluginRuntime();
  return useMemo(() => zoneFor(rows, appMode, runtime), [rows, appMode, runtime]);
}
