// -- Framework Imports --
import { useCallback } from "react";

// -- Hook Imports --
import { useVisualizerResolution } from "./useVisualizerResolution";

// -- State Imports --
import { useSetPlayerVisualizer } from "../../../state/preferences/store";
import { useVisualizerDefaults } from "../../../state/player/visualizerDefaults";
import { applyManualPick, type ManualPick } from "../../../state/player/visualizerResolve";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

/**
 * A manual pick for the playing track `trackId`, from the picker or V. Over a default it sets a temporary
 * override, otherwise it writes the global pref. Returns what the pick did, so a caller can tell whether
 * a default was set aside.
 */
export function useVisualizerPick(trackId: number): (kind: VisualizerKind) => ManualPick {
  const { input } = useVisualizerResolution(trackId);
  const setGlobal = useSetPlayerVisualizer();
  return useCallback(
    (kind) => {
      const pick = applyManualPick(input, kind);
      if (pick.global) setGlobal(pick.global);
      const { setOverride, clearOverride } = useVisualizerDefaults.getState();
      if (pick.override) setOverride(pick.override);
      else clearOverride();
      return pick;
    },
    [input, setGlobal],
  );
}
