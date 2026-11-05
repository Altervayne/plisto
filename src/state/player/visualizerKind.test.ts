// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  VISUALIZER_KINDS,
  effectiveVisualizerKind,
  nextVisualizerKind,
  normalizeReactivity,
  normalizeVisualizerKind,
  REACTIVITY_LEVELS,
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
  });
});

describe("nextVisualizerKind", () => {
  it("cycles Ridge, the five WebGL kinds, then Off", () => {
    const seen: VisualizerKind[] = [];
    let kind: VisualizerKind = "ridge";
    for (let i = 0; i < 7; i++) {
      seen.push(kind);
      kind = nextVisualizerKind(kind);
    }
    expect(seen).toEqual(["ridge", "terrain", "liquid", "warp", "nebula", "bloom", "off"]);
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

  it("falls back to Ridge for Liquid without cover pixels only", () => {
    const noPixels = { ...ok, coverPixels: false };
    expect(effectiveVisualizerKind("liquid", noPixels)).toBe("ridge");
    expect(effectiveVisualizerKind("terrain", noPixels)).toBe("terrain");
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
