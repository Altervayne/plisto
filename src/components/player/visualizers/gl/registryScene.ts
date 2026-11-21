/*
 * Resolves a built-in kind to the factory and traits the renderer takes. Kept apart from the renderer so
 * the renderer imports no registry and no view table. The composite is derived from the registry's slot
 * blend, which stays on the descriptor for the slot's CSS blend.
 */

// -- Local Imports --
import type { Composite, SceneSource } from "./renderer";
import { VISUALIZER_VIEWS } from "../visualizerViews";

// -- State Imports --
import { blendFor, descriptorOf, type GlBlendMode } from "../../../../state/player/visualizerRegistry";
import type { GlKind } from "../../../../state/player/visualizerKind";

/** The CSS blend the canvas takes over the stage for a kind and theme. */
export { blendFor as blendModeFor };

/** The composite each built-in slot blend stands for. */
export const COMPOSITE_OF_BLEND: Record<GlBlendMode, Composite> = {
  screen: "light",
  multiply: "ink",
  normal: "image",
};

/** A built-in kind's factory and traits from the registry. */
export function registryScene(kind: GlKind): SceneSource {
  const view = VISUALIZER_VIEWS[kind];
  if (!view.factory) throw new Error(`no GL factory for ${kind}`);
  const light = blendFor(kind, true);
  const dark = blendFor(kind, false);
  return {
    factory: view.factory,
    descriptor: {
      fillsStage: descriptorOf(kind).fillsStage,
      blend: { light, dark },
      composite: { light: COMPOSITE_OF_BLEND[light], dark: COMPOSITE_OF_BLEND[dark] },
    },
  };
}
