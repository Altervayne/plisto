/*
 * Brings a crashed background frame back when Rust has restarted its plugin. The edge into `starting` is
 * the signal, and only that edge: a status that stays `starting`, or any other change, remounts nothing.
 * A crashed page frame is never touched here; it waits for the user's Restart.
 */

// -- State Imports --
import { remountsOnStarting } from "./frameModel";
import { useFrameHealthStore } from "./frameHealth";
import { startingEdges, usePluginStatusStore } from "./pluginStatus";
import { usePluginsStore } from "./store";

/** Starts watching the status store and returns the teardown. The frame layer is the only caller. */
export function startFrameRemount(): () => void {
  return usePluginStatusStore.subscribe((state, prev) => {
    if (state.statuses === prev.statuses) return;
    for (const id of startingEdges(prev.statuses, state.statuses)) {
      const row = usePluginsStore.getState().rows.find((r) => r.id === id);
      const { crashed, restart } = useFrameHealthStore.getState();
      if (row && remountsOnStarting(row, crashed)) restart(id);
    }
  });
}
