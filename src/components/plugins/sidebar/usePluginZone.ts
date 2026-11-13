// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import { usePlugins } from "../../../state/plugins/store";
import { useAppMode } from "../../../state/player/store";

// -- Unit Imports --
import { pluginZoneModel } from "../../shell/navVisibility";
import type { PluginZoneModel } from "../../shell/navVisibility";

/**
 * The plugin zone for the current app mode. Derived only when the registry rows or the mode change, so
 * a consumer re-renders on nothing else.
 */
export function usePluginZone(): PluginZoneModel {
  const rows = usePlugins();
  const appMode = useAppMode();
  return useMemo(() => pluginZoneModel(rows, appMode), [rows, appMode]);
}
