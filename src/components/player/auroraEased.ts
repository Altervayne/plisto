// -- Type Imports --
import type { Reactivity, VisualizerKind } from "../../state/player/visualizerKind";

/**
 * Whether the Player's aurora breathes on the eased level instead of pulsing on the beat. It does while the
 * flash notice is unacknowledged, while the stored global pick is Off, and while Reactivity is Calm.
 */
export function auroraEased(allowed: boolean, globalPick: VisualizerKind, reactivity: Reactivity): boolean {
  return !allowed || globalPick === "off" || reactivity === "calm";
}
