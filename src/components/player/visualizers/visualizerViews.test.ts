// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { VISUALIZER_VIEWS, thumbFor } from "./visualizerViews";
import { createBloom } from "./gl/bloom";
import { createDotCover } from "./gl/dotCover";
import { createDotSpectrum } from "./gl/dotSpectrum";
import { createFireflies } from "./gl/fireflies";
import { createGlass } from "./gl/glass";
import { createHalftone } from "./gl/halftone";
import { createInk } from "./gl/ink";
import { createLake } from "./gl/lake";
import { createLatte } from "./gl/latte";
import { createLiquid } from "./gl/liquid";
import { createMercury } from "./gl/mercury";
import { createNebula } from "./gl/nebula";
import { createPond } from "./gl/pond";
import { createRecord } from "./gl/record";
import { createSilk } from "./gl/silk";
import { createSnowfall } from "./gl/snowfall";
import { createTerrain } from "./gl/terrain";
import { createTrain } from "./gl/train";
import { createWarp } from "./gl/warp";
import { createWindow } from "./gl/window";

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
      pond: createPond,
      train: createTrain,
      record: createRecord,
      snowfall: createSnowfall,
      latte: createLatte,
      fireflies: createFireflies,
      window: createWindow,
      lake: createLake,
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

describe("thumbFor", () => {
  it("returns null where no still was captured", () => {
    expect(thumbFor("off", "light")).toBeNull();
    expect(thumbFor("off", "dark")).toBeNull();
  });
});
