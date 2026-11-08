// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  GROUP_ORDER,
  VISUALIZER_DESCRIPTORS,
  blendFor,
  descriptorOf,
  isVisualizerKind,
  type GlVisualizerId,
} from "./visualizerRegistry";

describe("blendFor", () => {
  // [light, dark] per GL kind.
  const table: Record<GlVisualizerId, [string, string]> = {
    terrain: ["multiply", "screen"],
    warp: ["multiply", "screen"],
    nebula: ["multiply", "screen"],
    bloom: ["multiply", "screen"],
    halftone: ["normal", "screen"],
    "dot-spectrum": ["normal", "screen"],
    "dot-cover": ["normal", "normal"],
    liquid: ["normal", "normal"],
    ink: ["normal", "normal"],
    mercury: ["normal", "normal"],
    glass: ["normal", "normal"],
    silk: ["normal", "normal"],
  };

  it("gives every GL kind the blend the renderer composites in each theme", () => {
    for (const [kind, [light, dark]] of Object.entries(table) as [GlVisualizerId, [string, string]][]) {
      expect(blendFor(kind, true)).toBe(light);
      expect(blendFor(kind, false)).toBe(dark);
    }
  });

  it("covers exactly the GL kinds", () => {
    const gl = VISUALIZER_DESCRIPTORS.filter((d) => d.engine === "gl").map((d) => d.id);
    expect(gl.sort()).toEqual(Object.keys(table).sort());
  });

  it("gives Ridge soft-light in both themes", () => {
    expect(blendFor("ridge", true)).toBe("soft-light");
    expect(blendFor("ridge", false)).toBe("soft-light");
  });
});

describe("fillsStage", () => {
  it("holds for the kinds that draw across the whole stage, ignoring the mask", () => {
    const fills = VISUALIZER_DESCRIPTORS.filter((d) => d.fillsStage).map((d) => d.id);
    expect(fills).toEqual(["liquid", "ink", "mercury", "glass", "silk"]);
  });
});

describe("descriptorOf", () => {
  it("returns each kind's own descriptor", () => {
    for (const d of VISUALIZER_DESCRIPTORS) expect(descriptorOf(d.id)).toBe(d);
  });

  it("keeps the descriptors in group order with unique ids", () => {
    const groups = VISUALIZER_DESCRIPTORS.map((d) => GROUP_ORDER.indexOf(d.group));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    expect(new Set(VISUALIZER_DESCRIPTORS.map((d) => d.id)).size).toBe(VISUALIZER_DESCRIPTORS.length);
  });
});

describe("isVisualizerKind", () => {
  it("accepts every registry id and Off", () => {
    for (const d of VISUALIZER_DESCRIPTORS) expect(isVisualizerKind(d.id)).toBe(true);
    expect(isVisualizerKind("off")).toBe(true);
  });

  it("rejects an absent, unknown or miscased value", () => {
    expect(isVisualizerKind(undefined)).toBe(false);
    expect(isVisualizerKind(null)).toBe(false);
    expect(isVisualizerKind("")).toBe(false);
    expect(isVisualizerKind("horizon")).toBe(false);
    expect(isVisualizerKind("Glass")).toBe(false);
    expect(isVisualizerKind("toString")).toBe(false);
  });
});
