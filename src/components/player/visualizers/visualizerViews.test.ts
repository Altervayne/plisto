// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { VISUALIZER_VIEWS } from "./visualizerViews";
import { createBloom } from "./gl/bloom";
import { createDotCover } from "./gl/dotCover";
import { createDotSpectrum } from "./gl/dotSpectrum";
import { createGlass } from "./gl/glass";
import { createHalftone } from "./gl/halftone";
import { createInk } from "./gl/ink";
import { createLiquid } from "./gl/liquid";
import { createMercury } from "./gl/mercury";
import { createNebula } from "./gl/nebula";
import { createSilk } from "./gl/silk";
import { createTerrain } from "./gl/terrain";
import { createWarp } from "./gl/warp";

// -- State Imports --
import { VISUALIZER_DESCRIPTORS, type GlVisualizerId } from "../../../state/player/visualizerRegistry";
import { VISUALIZER_KINDS } from "../../../state/player/visualizerKind";

describe("VISUALIZER_VIEWS", () => {
  it("builds each GL kind with its own module's factory", () => {
    const factories: Record<GlVisualizerId, unknown> = {
      terrain: createTerrain,
      warp: createWarp,
      nebula: createNebula,
      bloom: createBloom,
      halftone: createHalftone,
      "dot-spectrum": createDotSpectrum,
      "dot-cover": createDotCover,
      liquid: createLiquid,
      ink: createInk,
      mercury: createMercury,
      glass: createGlass,
      silk: createSilk,
    };
    for (const [kind, create] of Object.entries(factories) as [GlVisualizerId, unknown][]) {
      expect(VISUALIZER_VIEWS[kind].factory).toBe(create);
    }
  });

  it("carries a factory exactly for the GL engine", () => {
    for (const d of VISUALIZER_DESCRIPTORS) {
      expect(VISUALIZER_VIEWS[d.id].factory !== undefined).toBe(d.engine === "gl");
    }
    expect(VISUALIZER_VIEWS.off.factory).toBeUndefined();
  });

  it("covers every kind, Off included, and nothing else", () => {
    expect(Object.keys(VISUALIZER_VIEWS).sort()).toEqual([...VISUALIZER_KINDS].sort());
  });
});
