/*
 * Clears a plugin family's stored off flag in the visualizer catalog, so a plugin that lands in or moves
 * into the catalog listing is on as soon as it is enabled. A read-only or unread catalog is left alone.
 */

// -- State Imports --
import { parseCatalog } from "../player/visualizerCatalog";
import {
  PREF_KEYS,
  persistVisualizerCatalog,
  selectCatalogUnreadable,
  usePreferencesStore,
} from "../preferences/store";

/** Removes `family` from the stored off families; a no-op when it is not there. */
export function clearFamilyFlag(family: string): void {
  const prefs = usePreferencesStore.getState();
  const { state, writable } = parseCatalog(
    prefs.values[PREF_KEYS.playerVisualizerCatalog],
    selectCatalogUnreadable(prefs),
  );
  if (!writable || !state.groups.includes(family)) return;
  persistVisualizerCatalog({ kinds: state.kinds, groups: state.groups.filter((g) => g !== family) });
}
