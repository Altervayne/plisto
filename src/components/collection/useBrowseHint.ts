// -- Framework Imports --
import { useEffect } from "react";

// -- State Imports --
import { useBrowseHintSeen, useRetireBrowseHint } from "../../state/collection/store";
import { usePreferencesLoaded } from "../../state/preferences/store";

// -- Type Imports --
import type { CollectionSegment } from "../../state/collection/store";

/**
 * Whether the Browse hint shows: on any segment but Browse itself, as the mockup draws it. Before the
 * prefs have loaded it stays hidden (an absent flag would flash it for a returning user), and never
 * once retired.
 */
export function hintShows(loaded: boolean, seen: boolean, segment: CollectionSegment): boolean {
  return loaded && !seen && segment !== "browse";
}

/** The hint's visibility and its retire action. Entering Browse by any route retires it for good. */
export function useBrowseHint(segment: CollectionSegment): { show: boolean; retire: () => void } {
  const loaded = usePreferencesLoaded();
  const seen = useBrowseHintSeen();
  const retire = useRetireBrowseHint();
  const entered = loaded && !seen && segment === "browse";
  useEffect(() => {
    if (entered) retire();
  }, [entered, retire]);
  return { show: hintShows(loaded, seen, segment), retire };
}
