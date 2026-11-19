// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  GROUP_ORDER,
  GROUP_TEMPERAMENT,
  VISUALIZER_DESCRIPTORS,
  blendFor,
  descriptorOf,
  groupMark,
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
    pond: ["normal", "normal"],
    train: ["normal", "normal"],
    record: ["normal", "normal"],
    snowfall: ["normal", "normal"],
    latte: ["normal", "normal"],
    fireflies: ["normal", "normal"],
    window: ["normal", "normal"],
    lake: ["normal", "normal"],
    "neon-highway": ["normal", "normal"],
    "server-room": ["normal", "normal"],
    "circuit-board": ["normal", "normal"],
    oscilloscope: ["normal", "normal"],
    hologram: ["normal", "normal"],
    "gravitational-waves": ["normal", "normal"],
    "ringed-planet": ["normal", "normal"],
    station: ["normal", "normal"],
    "solar-flare": ["normal", "normal"],
    "event-horizon": ["normal", "normal"],
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
    expect(fills).toEqual([
      "liquid",
      "ink",
      "mercury",
      "silk",
      "pond",
      "glass",
      "train",
      "record",
      "snowfall",
      "latte",
      "fireflies",
      "window",
      "lake",
      "neon-highway",
      "server-room",
      "circuit-board",
      "oscilloscope",
      "hologram",
      "gravitational-waves",
      "ringed-planet",
      "station",
      "solar-flare",
      "event-horizon",
    ]);
  });
});

describe("darkOnly", () => {
  it("is a boolean on every descriptor", () => {
    for (const d of VISUALIZER_DESCRIPTORS) expect(typeof d.darkOnly).toBe("boolean");
  });

  it("gives a dark-only kind the same blend in both themes", () => {
    for (const d of VISUALIZER_DESCRIPTORS.filter((k) => k.darkOnly)) expect(d.blend.light).toBe(d.blend.dark);
  });

  it("holds for the cosmic kinds and no others", () => {
    expect(VISUALIZER_DESCRIPTORS.filter((d) => d.darkOnly).map((d) => d.id)).toEqual([
      "gravitational-waves",
      "ringed-planet",
      "station",
      "solar-flare",
      "event-horizon",
    ]);
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

describe("groupMark", () => {
  it("marks Cyber and Cosmic as flash and Cozy as calm", () => {
    expect(groupMark("cyber")).toBe("flash");
    expect(groupMark("cosmic")).toBe("flash");
    expect(groupMark("cozy")).toBe("calm");
  });

  it("leaves the other families, unknown ids and inherited names unmarked", () => {
    for (const id of ["classic", "dots", "fluid", "plugin:x", "toString", ""]) expect(groupMark(id)).toBeNull();
  });

  it("only names registered families", () => {
    for (const id of Object.keys(GROUP_TEMPERAMENT)) expect(GROUP_ORDER as readonly string[]).toContain(id);
  });
});
