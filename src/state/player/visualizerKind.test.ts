// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  VISUALIZER_GROUPS,
  VISUALIZER_KINDS,
  effectiveVisualizerKind,
  fillsStage,
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
  it("cycles the classic, dot and fluid sections in picker order, then Off", () => {
    const seen: VisualizerKind[] = [];
    let kind: VisualizerKind = "ridge";
    for (let i = 0; i < 14; i++) {
      seen.push(kind);
      kind = nextVisualizerKind(kind);
    }
    expect(seen).toEqual([
      "ridge",
      "terrain",
      "warp",
      "nebula",
      "bloom",
      "halftone",
      "dot-spectrum",
      "dot-cover",
      "liquid",
      "ink",
      "mercury",
      "glass",
      "silk",
      "off",
    ]);
  });

  it("walks the same order the picker renders from its sections", () => {
    const pickerOrder = [...VISUALIZER_GROUPS.flatMap((group) => group.kinds), "off"];
    expect([...VISUALIZER_KINDS]).toEqual(pickerOrder);
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

  it("falls back to Ridge without cover pixels only for the kinds that draw the art", () => {
    const noPixels = { ...ok, coverPixels: false };
    for (const kind of ["liquid", "dot-cover", "ink", "mercury", "glass"] as const) {
      expect(effectiveVisualizerKind(kind, noPixels)).toBe("ridge");
    }
    expect(effectiveVisualizerKind("terrain", noPixels)).toBe("terrain");
    expect(effectiveVisualizerKind("halftone", noPixels)).toBe("halftone");
    expect(effectiveVisualizerKind("dot-spectrum", noPixels)).toBe("dot-spectrum");
    expect(effectiveVisualizerKind("silk", noPixels)).toBe("silk");
  });

  it("falls back to Ridge for every fluid kind when the WebGL renderer failed", () => {
    for (const kind of ["ink", "mercury", "glass", "silk"] as const) {
      expect(effectiveVisualizerKind(kind, { ...ok, glFailed: true })).toBe("ridge");
    }
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
    expect(VISUALIZER_KINDS.filter(needsCoverPixels)).toEqual(["dot-cover", "liquid", "ink", "mercury", "glass"]);
  });
});

describe("fillsStage", () => {
  it("holds for Liquid and the fluid kinds, which paint the whole stage", () => {
    expect(VISUALIZER_KINDS.filter(fillsStage)).toEqual(["liquid", "ink", "mercury", "glass", "silk"]);
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
