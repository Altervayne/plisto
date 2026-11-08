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
import { VISUALIZER_DESCRIPTORS, type BlendMode, type VisualizerDescriptor } from "./visualizerRegistry";

describe("visualizer descriptors", () => {
  // kind, group, engine, needs.fine, needs.cover, fillsStage, blend light, blend dark
  const rows: [string, string, string, boolean, boolean, boolean, BlendMode, BlendMode][] = [
    ["ridge", "classic", "canvas2d", false, false, false, "soft-light", "soft-light"],
    ["terrain", "classic", "gl", true, false, false, "multiply", "screen"],
    ["warp", "classic", "gl", false, false, false, "multiply", "screen"],
    ["nebula", "classic", "gl", false, false, false, "multiply", "screen"],
    ["bloom", "classic", "gl", false, false, false, "multiply", "screen"],
    ["halftone", "dots", "gl", false, false, false, "normal", "screen"],
    ["dot-spectrum", "dots", "gl", true, false, false, "normal", "screen"],
    ["dot-cover", "dots", "gl", false, true, false, "normal", "normal"],
    ["liquid", "fluid", "gl", false, true, true, "normal", "normal"],
    ["ink", "fluid", "gl", false, true, true, "normal", "normal"],
    ["mercury", "fluid", "gl", false, true, true, "normal", "normal"],
    ["silk", "fluid", "gl", false, false, true, "normal", "normal"],
    ["pond", "fluid", "gl", false, true, true, "normal", "normal"],
    ["glass", "cozy", "gl", false, true, true, "normal", "normal"],
    ["train", "cozy", "gl", false, true, true, "normal", "normal"],
    ["record", "cozy", "gl", false, true, true, "normal", "normal"],
    ["snowfall", "cozy", "gl", false, true, true, "normal", "normal"],
    ["latte", "cozy", "gl", false, true, true, "normal", "normal"],
    ["fireflies", "cozy", "gl", false, true, true, "normal", "normal"],
    ["window", "cozy", "gl", false, true, true, "normal", "normal"],
    ["lake", "cozy", "gl", false, true, true, "normal", "normal"],
  ];

  it("holds every kind's traits, in picker order", () => {
    expect(
      VISUALIZER_DESCRIPTORS.map((d) => [
        d.id,
        d.group,
        d.engine,
        d.needs.fine,
        d.needs.cover,
        d.fillsStage,
        d.blend.light,
        d.blend.dark,
      ]),
    ).toEqual(rows);
  });

  it("drives the predicates from the same rows", () => {
    for (const [kind, , , fine, cover, fills] of rows) {
      const k = kind as VisualizerKind;
      expect(needsFineSpectrum(k)).toBe(fine);
      expect(needsCoverPixels(k)).toBe(cover);
      expect(fillsStage(k)).toBe(fills);
    }
    expect(needsFineSpectrum("off")).toBe(false);
    expect(needsCoverPixels("off")).toBe(false);
    expect(fillsStage("off")).toBe(false);
  });

  it("gives only Dot spectrum a pref of its own", () => {
    const withPrefs = VISUALIZER_DESCRIPTORS.flatMap((d: VisualizerDescriptor) => (d.prefs ? [[d.id, d.prefs]] : []));
    expect(withPrefs).toEqual([["dot-spectrum", ["spectrumLayout"]]]);
  });
});

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
  it("cycles the classic, dot, fluid and cozy sections in picker order, then Off", () => {
    const seen: VisualizerKind[] = [];
    let kind: VisualizerKind = "ridge";
    for (let i = 0; i < 22; i++) {
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

  it("falls back to Ridge without cover pixels for Pond and every cozy kind", () => {
    const noPixels = { ...ok, coverPixels: false };
    const kinds = ["pond", "glass", "train", "record", "snowfall", "latte", "fireflies", "window", "lake"] as const;
    for (const kind of kinds) {
      expect(effectiveVisualizerKind(kind, noPixels)).toBe("ridge");
    }
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
    expect(VISUALIZER_KINDS.filter(needsCoverPixels)).toEqual([
      "dot-cover",
      "liquid",
      "ink",
      "mercury",
      "pond",
      "glass",
      "train",
      "record",
      "snowfall",
      "latte",
      "fireflies",
      "window",
      "lake",
    ]);
  });
});

describe("fillsStage", () => {
  it("holds for the fluid and cozy kinds, which paint the whole stage", () => {
    expect(VISUALIZER_KINDS.filter(fillsStage)).toEqual([
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
    ]);
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
