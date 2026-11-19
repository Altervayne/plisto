// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Hook Imports --
import type { VisualizerResolution } from "./useVisualizerResolution";

// -- State Imports --
import { useAlbumIndex } from "../../../state/organize/store";
import { usePlayerVisualizer, usePreferencesLoaded, useVisualizerCatalog } from "../../../state/preferences/store";
import { usePlayerStatus } from "../../../state/player/store";
import {
  useStoredDefaults,
  useVisualizerDefaultsStatus,
  useVisualizerOverride,
} from "../../../state/player/visualizerDefaults";
import { isOffered } from "../../../state/player/visualizerCatalog";
import { useVisualizersAllowed } from "../../../state/player/visualizerWarning";
import { keyOfPlace, placeOf, resolveVisualizer } from "../../../state/player/visualizerResolve";
import { normalizeVisualizerKind } from "../../../state/player/visualizerKind";

// -- Local Imports --
import { warmKind, whenIdle } from "./gl/warm";

/**
 * Warms the kind track `trackId` resolves to, once, at idle after the preferences and the stored defaults
 * have loaded. Before the preferences load the global pick and the catalog are placeholders.
 */
export function useWarmCurrentVisualizer(): void {
  const trackId = usePlayerStatus().track_id;
  const global = usePlayerVisualizer();
  const catalog = useVisualizerCatalog();
  const albumIndex = useAlbumIndex();
  const override = useVisualizerOverride();
  const prefsLoaded = usePreferencesLoaded();
  const ready = useVisualizerDefaultsStatus() === "ready" && prefsLoaded;
  const allowed = useVisualizersAllowed();
  const place = trackId == null ? null : placeOf(trackId, albumIndex);
  const { trackDefault, albumDefault } = useStoredDefaults(place ?? { kind: "adhoc" });
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready || !allowed || place == null) return;
    done.current = true;
    const input = { global, trackDefault, albumDefault, override, albumKey: keyOfPlace(place), catalog };
    return whenIdle(() => warmKind(resolveVisualizer(input).picked));
  }, [ready, allowed, place, global, trackDefault, albumDefault, override, catalog]);
}

/** Warms the picked kind and the stored album and track defaults the catalog offers while the sheet is open. */
export function useWarmSheetKinds({ place, resolution }: VisualizerResolution): void {
  const { trackDefault, albumDefault } = useStoredDefaults(place);
  const catalog = useVisualizerCatalog();
  const { picked } = resolution;
  useEffect(() => {
    warmKind(picked);
    for (const stored of [trackDefault, albumDefault]) {
      if (!stored) continue;
      const kind = normalizeVisualizerKind(stored);
      if (isOffered(catalog, kind)) warmKind(kind);
    }
  }, [picked, trackDefault, albumDefault, catalog]);
}
