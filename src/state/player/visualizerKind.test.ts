// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  VISUALIZER_KINDS,
  effectiveVisualizerKind,
  nextVisualizerKind,
  needsCoverPixels,
  needsFineSpectrum,
  normalizeReactivity,
  normalizeSpectrumLayout,
  normalizeVisualizerKind,
  REACTIVITY_LEVELS,
  SPECTRUM_LAYOUTS,
  type VisualizerKind,
} from "./visualizerKind";

describe("normalizeVisualizerKind", () => {
  it("keeps every known kind", () => {
    for (const kind of VISUALIZER_KINDS) expect(normalizeVisualizerKind(kind)).toBe(kind);
  });

  it("reads an absent value as Ridge", () => {
    expect(normalizeVisualizerKind(undefined)).toBe("ridge");
    expect(normalizeVisualizerKind(null)).toBe("ridge");
    expect(normalizeVisualizerKind("")).toBe("ridge");
  });

  it("reads an unknown or retired value as Ridge", () => {
    expect(normalizeVisualizerKind("ring")).toBe("ridge");
    expect(normalizeVisualizerKind("horizon")).toBe("ridge");
    expect(normalizeVisualizerKind("Terrain")).toBe("ridge");
    expect(normalizeVisualizerKind("dots")).toBe("ridge");
  });
});

describe("nextVisualizerKind", () => {
  it("cycles Ridge, the WebGL kinds with the dot kinds after Bloom, then Off", () => {
    const seen: VisualizerKind[] = [];
    let kind: VisualizerKind = "ridge";
    for (let i = 0; i < 10; i++) {
      seen.push(kind);
      kind = nextVisualizerKind(kind);
    }
    expect(seen).toEqual([
      "ridge",
      "terrain",
      "liquid",
      "warp",
      "nebula",
      "bloom",
      "halftone",
      "dot-spectrum",
      "dot-cover",
      "off",
    ]);
  });

  it("wraps from Off back to Ridge", () => {
    expect(nextVisualizerKind("off")).toBe("ridge");
  });
});

describe("effectiveVisualizerKind", () => {
  const ok = { glFailed: false, coverPixels: true };

  it("draws the pick when everything is on hand", () => {
    for (const kind of VISUALIZER_KINDS) expect(effectiveVisualizerKind(kind, ok)).toBe(kind);
  });

  it("falls back to Ridge when the WebGL renderer failed", () => {
    expect(effectiveVisualizerKind("warp", { ...ok, glFailed: true })).toBe("ridge");
    expect(effectiveVisualizerKind("liquid", { ...ok, glFailed: true })).toBe("ridge");
  });

  it("falls back to Ridge for Liquid and Dot cover without cover pixels only", () => {
    const noPixels = { ...ok, coverPixels: false };
    expect(effectiveVisualizerKind("liquid", noPixels)).toBe("ridge");
    expect(effectiveVisualizerKind("dot-cover", noPixels)).toBe("ridge");
    expect(effectiveVisualizerKind("terrain", noPixels)).toBe("terrain");
    expect(effectiveVisualizerKind("halftone", noPixels)).toBe("halftone");
    expect(effectiveVisualizerKind("dot-spectrum", noPixels)).toBe("dot-spectrum");
  });

  it("falls back to Ridge for every dot kind when the WebGL renderer failed", () => {
    for (const kind of ["halftone", "dot-spectrum", "dot-cover"] as const) {
      expect(effectiveVisualizerKind(kind, { ...ok, glFailed: true })).toBe("ridge");
    }
  });

  it("never changes Ridge or Off", () => {
    const broken = { glFailed: true, coverPixels: false };
    expect(effectiveVisualizerKind("ridge", broken)).toBe("ridge");
    expect(effectiveVisualizerKind("off", broken)).toBe("off");
  });
});

describe("normalizeReactivity", () => {
  it("keeps every known level", () => {
    for (const level of REACTIVITY_LEVELS) expect(normalizeReactivity(level)).toBe(level);
  });

  it("reads an absent or unknown value as Balanced", () => {
    expect(normalizeReactivity(undefined)).toBe("balanced");
    expect(normalizeReactivity(null)).toBe("balanced");
    expect(normalizeReactivity("wild")).toBe("balanced");
    expect(normalizeReactivity("Calm")).toBe("balanced");
  });
});

describe("needsCoverPixels", () => {
  it("holds for the kinds that draw the art itself", () => {
    expect(VISUALIZER_KINDS.filter(needsCoverPixels)).toEqual(["liquid", "dot-cover"]);
  });
});

describe("needsFineSpectrum", () => {
  it("holds for the kinds that draw the 128-band spectrum", () => {
    expect(VISUALIZER_KINDS.filter(needsFineSpectrum)).toEqual(["terrain", "dot-spectrum"]);
  });
});

describe("normalizeSpectrumLayout", () => {
  it("keeps every known layout", () => {
    for (const layout of SPECTRUM_LAYOUTS) expect(normalizeSpectrumLayout(layout)).toBe(layout);
  });

  it("reads an absent or unknown value as bass-left", () => {
    expect(normalizeSpectrumLayout(undefined)).toBe("bass-left");
    expect(normalizeSpectrumLayout(null)).toBe("bass-left");
    expect(normalizeSpectrumLayout("linear")).toBe("bass-left");
  });
});
