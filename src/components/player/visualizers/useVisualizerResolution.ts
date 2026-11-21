// -- Framework Imports --
import { useEffect, useMemo } from "react";

// -- State Imports --
import { useAlbumIndex } from "../../../state/organize/store";
import { usePlayerVisualizer, useVisualizerCatalog } from "../../../state/preferences/store";
import { usePluginsListed } from "../../../state/plugins/store";
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
 * override, each held to the kinds the catalog offers. The override ends as soon as the album key it was
 * picked on is no longer the playing one. Until the plugins list has arrived, a stored plugin kind is
 * pending rather than gone.
 */
export function useVisualizerResolution(trackId: number): VisualizerResolution {
  const global = usePlayerVisualizer();
  const catalog = useVisualizerCatalog();
  const albumIndex = useAlbumIndex();
  const place = useMemo(() => placeOf(trackId, albumIndex), [trackId, albumIndex]);
  const { trackDefault, albumDefault } = useStoredDefaults(place);
  const override = useVisualizerOverride();
  const albumKey = keyOfPlace(place);
  const pluginsPending = !usePluginsListed();

  useEffect(() => {
    const held = useVisualizerDefaults.getState().override;
    if (held && held.albumKey !== albumKey) useVisualizerDefaults.getState().clearOverride();
  }, [albumKey]);

  return useMemo(() => {
    const input: ResolveInput = {
      global,
      trackDefault,
      albumDefault,
      override,
      albumKey,
      catalog,
      pluginsPending,
    };
    return { place, input, resolution: resolveVisualizer(input) };
  }, [global, trackDefault, albumDefault, override, albumKey, catalog, pluginsPending, place]);
}
