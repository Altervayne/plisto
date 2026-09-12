/*
 * The Home layout hook: binds the pure layout engine to the preferences store, one saved layout per app
 * mode. It reads the mode's pref, parses it (seed fallback when absent), and each mutator writes the
 * next layout back through the store. The in-memory pref cache updates synchronously, so the grid
 * re-renders at once; the disk write is best-effort like every other pref. Switching mode swaps to that
 * mode's saved layout and never re-seeds a customized one.
 */

// -- Framework Imports --
import { useMemo } from "react";

// -- Unit Imports --
import { seedLayout } from "./boxCatalog";
import {
  addBox,
  cycleSize,
  parseLayout,
  removeBox,
  reorderLayout,
  resizeLayout,
  serializeLayout,
} from "./homeLayout";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- Type Imports --
import type { BoxSeed, BoxSize, BoxType } from "./boxCatalog";
import type { AppMode } from "../../state/player/store";

/** Each mode's layout pref key. */
const MODE_KEY: Record<AppMode, string> = {
  player: PREF_KEYS.homeLayoutPlayer,
  organizer: PREF_KEYS.homeLayoutOrganizer,
  both: PREF_KEYS.homeLayoutBoth,
};

/** The arrange surface's read and mutators for one mode. */
export interface HomeLayout {
  layout: BoxSeed[];
  reorder: (fromType: BoxType, toType: BoxType) => void;
  cycle: (type: BoxType) => void;
  resize: (type: BoxType, size: BoxSize) => void;
  remove: (type: BoxType) => void;
  add: (type: BoxType) => void;
  reset: () => void;
}

export function useHomeLayout(mode: AppMode): HomeLayout {
  const key = MODE_KEY[mode];
  const raw = usePreference(key);
  const setPreference = useSetPreference();

  const layout = useMemo(() => parseLayout(raw, mode), [raw, mode]);

  return useMemo(() => {
    const persist = (next: BoxSeed[]) => setPreference(key, serializeLayout(next));
    return {
      layout,
      reorder: (fromType, toType) => persist(reorderLayout(layout, fromType, toType)),
      cycle: (type) => persist(cycleSize(layout, type)),
      resize: (type, size) => persist(resizeLayout(layout, type, size)),
      remove: (type) => persist(removeBox(layout, type)),
      add: (type) => persist(addBox(layout, type)),
      reset: () => persist(seedLayout(mode)),
    };
  }, [layout, key, mode, setPreference]);
}
