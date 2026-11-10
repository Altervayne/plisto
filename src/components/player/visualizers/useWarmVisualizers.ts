// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Hook Imports --
import type { VisualizerResolution } from "./useVisualizerResolution";

// -- State Imports --
import { useAlbumIndex } from "../../../state/organize/store";
import { usePlayerVisualizer } from "../../../state/preferences/store";
import { usePlayerStatus } from "../../../state/player/store";
import {
  useStoredDefaults,
  useVisualizerDefaultsStatus,
  useVisualizerOverride,
} from "../../../state/player/visualizerDefaults";
import { keyOfPlace, placeOf, resolveVisualizer } from "../../../state/player/visualizerResolve";
import { normalizeVisualizerKind } from "../../../state/player/visualizerKind";

// -- Local Imports --
import { warmKind, whenIdle } from "./gl/warm";

/** Warms the kind track `trackId` resolves to, once, at idle after the stored defaults have loaded. */
export function useWarmCurrentVisualizer(): void {
  const trackId = usePlayerStatus().track_id;
  const global = usePlayerVisualizer();
  const albumIndex = useAlbumIndex();
  const override = useVisualizerOverride();
  const ready = useVisualizerDefaultsStatus() === "ready";
  const place = trackId == null ? null : placeOf(trackId, albumIndex);
  const { trackDefault, albumDefault } = useStoredDefaults(place ?? { kind: "adhoc" });
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready || place == null) return;
    done.current = true;
    const input = { global, trackDefault, albumDefault, override, albumKey: keyOfPlace(place) };
    return whenIdle(() => warmKind(resolveVisualizer(input).picked));
  }, [ready, place, global, trackDefault, albumDefault, override]);
}

/** Warms the picked kind and the stored album and track defaults while the sheet is open. */
export function useWarmSheetKinds({ place, resolution }: VisualizerResolution): void {
  const { trackDefault, albumDefault } = useStoredDefaults(place);
  const { picked } = resolution;
  useEffect(() => {
    warmKind(picked);
    if (trackDefault) warmKind(normalizeVisualizerKind(trackDefault));
    if (albumDefault) warmKind(normalizeVisualizerKind(albumDefault));
  }, [picked, trackDefault, albumDefault]);
}
