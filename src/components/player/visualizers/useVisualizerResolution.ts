// -- Framework Imports --
import { useEffect, useMemo } from "react";

// -- State Imports --
import { useAlbumIndex } from "../../../state/organize/store";
import { usePlayerVisualizer } from "../../../state/preferences/store";
import {
  useStoredDefaults,
  useVisualizerDefaults,
  useVisualizerOverride,
} from "../../../state/player/visualizerDefaults";
import {
  keyOfPlace,
  placeOf,
  resolveVisualizer,
  type Resolution,
  type ResolveInput,
  type TrackPlace,
} from "../../../state/player/visualizerResolve";

export interface VisualizerResolution {
  place: TrackPlace;
  input: ResolveInput;
  resolution: Resolution;
}

/**
 * What track `trackId` resolves to: the global pick, then its album and track defaults, then the session
 * override. The override ends as soon as the album key it was picked on is no longer the playing one.
 */
export function useVisualizerResolution(trackId: number): VisualizerResolution {
  const global = usePlayerVisualizer();
  const albumIndex = useAlbumIndex();
  const place = useMemo(() => placeOf(trackId, albumIndex), [trackId, albumIndex]);
  const { trackDefault, albumDefault } = useStoredDefaults(place);
  const override = useVisualizerOverride();
  const albumKey = keyOfPlace(place);

  useEffect(() => {
    const held = useVisualizerDefaults.getState().override;
    if (held && held.albumKey !== albumKey) useVisualizerDefaults.getState().clearOverride();
  }, [albumKey]);

  return useMemo(() => {
    const input: ResolveInput = { global, trackDefault, albumDefault, override, albumKey };
    return { place, input, resolution: resolveVisualizer(input) };
  }, [global, trackDefault, albumDefault, override, albumKey, place]);
}
