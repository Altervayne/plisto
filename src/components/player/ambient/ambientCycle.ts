// -- State Imports --
import { nextOfferedKind, type Catalog } from "../../../state/player/visualizerCatalog";

// -- Type Imports --
import type { VisualizerKind } from "../../../state/player/visualizerKind";

/** The kind the V key moves to, or null while the flash notice is unacknowledged and nothing may change. */
export function ambientCycleTarget(allowed: boolean, catalog: Catalog, picked: VisualizerKind): VisualizerKind | null {
  return allowed ? (nextOfferedKind(catalog, picked) as VisualizerKind) : null;
}
