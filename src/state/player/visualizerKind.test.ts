// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  VISUALIZER_GROUPS,
  VISUALIZER_KINDS,
  effectiveVisualizerKind,
  fillsStage,
  isDarkOnly,
  lightLook,
  needsCoverPixels,
  needsFineSpectrum,
  normalizeReactivity,
  normalizeSpectrumLayout,
  normalizeVisualizerKind,
  REACTIVITY_LEVELS,
  sceneChanged,
  sceneLight,
  SPECTRUM_LAYOUTS,
  type VisualizerKind,
} from "./visualizerKind";
import { ALL_OFFERED, nextOfferedKind } from "./visualizerCatalog";
import { VISUALIZER_DESCRIPTORS, type BlendMode, type VisualizerDescriptor } from "./visualizerRegistry";

describe("visualizer descriptors", () => {
  // kind, group, engine, needs.fine, needs.cover, fillsStage, blend light, blend dark, darkOnly
  const rows: [string, string, string, boolean, boolean, boolean, BlendMode, BlendMode, boolean][] = [
    ["ridge", "classic", "canvas2d", false, false, false, "soft-light", "soft-light", false],
    ["terrain", "classic", "gl", true, false, false, "multiply", "screen", false],
    ["warp", "classic", "gl", false, false, false, "multiply", "screen", false],
    ["nebula", "classic", "gl", false, false, false, "multiply", "screen", false],
    ["bloom", "classic", "gl", false, false, false, "multiply", "screen", false],
    ["halftone", "dots", "gl", false, false, false, "normal", "screen", false],
    ["dot-spectrum", "dots", "gl", true, false, false, "normal", "screen", false],
    ["dot-cover", "dots", "gl", false, true, false, "normal", "normal", false],
    ["liquid", "fluid", "gl", false, true, true, "normal", "normal", false],
    ["ink", "fluid", "gl", false, true, true, "normal", "normal", false],
    ["mercury", "fluid", "gl", false, true, true, "normal", "normal", false],
    ["silk", "fluid", "gl", false, false, true, "normal", "normal", false],
    ["pond", "fluid", "gl", false, true, true, "normal", "normal", false],
    ["glass", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["train", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["record", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["snowfall", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["latte", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["fireflies", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["window", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["lake", "cozy", "gl", false, true, true, "normal", "normal", false],
    ["neon-highway", "cyber", "gl", false, false, true, "normal", "normal", false],
    ["server-room", "cyber", "gl", false, true, true, "normal", "normal", false],
    ["circuit-board", "cyber", "gl", false, true, true, "normal", "normal", false],
    ["oscilloscope", "cyber", "gl", false, true, true, "normal", "normal", false],
    ["hologram", "cyber", "gl", false, true, true, "normal", "normal", false],
    ["gravitational-waves", "cosmic", "gl", false, true, true, "normal", "normal", true],
    ["ringed-planet", "cosmic", "gl", false, true, true, "normal", "normal", true],
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
        d.darkOnly,
      ]),
    ).toEqual(rows);
  });

  it("drives the predicates from the same rows", () => {
    for (const [kind, , , fine, cover, fills, , , dark] of rows) {
      const k = kind as VisualizerKind;
      expect(needsFineSpectrum(k)).toBe(fine);
      expect(needsCoverPixels(k)).toBe(cover);
      expect(fillsStage(k)).toBe(fills);
      expect(isDarkOnly(k)).toBe(dark);
    }
    expect(needsFineSpectrum("off")).toBe(false);
    expect(needsCoverPixels("off")).toBe(false);
    expect(fillsStage("off")).toBe(false);
    expect(isDarkOnly("off")).toBe(false);
  });

  it("draws light only when the theme is light and the scene has a light variant", () => {
    expect(lightLook(false, true)).toBe(true);
    expect(lightLook(false, false)).toBe(false);
    expect(lightLook(true, true)).toBe(false);
    expect(lightLook(true, false)).toBe(false);
  });

  it("measures again for a new kind or a new scene light, and not otherwise", () => {
    expect(sceneChanged("lake", true, "lake", true)).toBe(false);
    expect(sceneChanged("lake", true, "train", true)).toBe(true);
    expect(sceneChanged("lake", true, "lake", false)).toBe(true);
    expect(sceneChanged("lake", false, "lake", false)).toBe(false);
  });

  it("keeps a kind's own scene light in a light theme and takes the dark look otherwise", () => {
    for (const d of VISUALIZER_DESCRIPTORS) {
      expect(sceneLight(d.id, true)).toBe(!d.darkOnly);
      expect(sceneLight(d.id, false)).toBe(false);
    }
    expect(sceneLight("off", true)).toBe(true);
    expect(sceneLight("off", false)).toBe(false);
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

describe("the V cycle", () => {
  it("walks every kind in picker order, then Off, and wraps", () => {
    const seen: string[] = [];
    let kind: string = VISUALIZER_DESCRIPTORS[0].id;
    for (let i = 0; i < VISUALIZER_KINDS.length; i++) {
      seen.push(kind);
      kind = nextOfferedKind(ALL_OFFERED, kind);
    }
    expect(seen).toEqual([...VISUALIZER_KINDS]);
    expect(kind).toBe(VISUALIZER_DESCRIPTORS[0].id);
  });

  it("walks the same order the picker renders from its sections", () => {
    const pickerOrder = [...VISUALIZER_GROUPS.flatMap((group) => group.kinds), "off"];
    expect([...VISUALIZER_KINDS]).toEqual(pickerOrder);
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
    expect(effectiveVisualizerKind("neon-highway", noPixels)).toBe("neon-highway");
  });

  it("falls back to Ridge without cover pixels for Pond, every cozy kind and the cyber and cosmic kinds that draw the art", () => {
    const noPixels = { ...ok, coverPixels: false };
    const kinds = [
      "pond",
      "glass",
      "train",
      "record",
      "snowfall",
      "latte",
      "fireflies",
      "window",
      "lake",
      "server-room",
      "circuit-board",
      "oscilloscope",
      "hologram",
      "gravitational-waves",
      "ringed-planet",
    ] as const;
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
      "server-room",
      "circuit-board",
      "oscilloscope",
      "hologram",
      "gravitational-waves",
      "ringed-planet",
    ]);
  });
});

describe("fillsStage", () => {
  it("holds for the fluid, cozy, cyber and cosmic kinds, which paint the whole stage", () => {
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
      "neon-highway",
      "server-room",
      "circuit-board",
      "oscilloscope",
      "hologram",
      "gravitational-waves",
      "ringed-planet",
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
