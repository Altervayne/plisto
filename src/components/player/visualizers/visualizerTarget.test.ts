// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { boundaryKey, composePixels, dipReason, dipTarget, fallbackOf, mountedKind, shouldRetryDefaults, type DipLatch } from "./visualizerTarget";
import type { CoverPixels, CoverPixelState } from "./useCoverPixels";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

describe("dipTarget", () => {
  const cases: [string, VisualizerKind, boolean, CoverPixelState, VisualizerKind, boolean][] = [
    ["a cover kind with its pixels", "glass", false, "ready", "glass", true],
    ["a cover kind holds, not Ridge, while its pixels load", "glass", false, "pending", "glass", false],
    ["a cover kind falls back to Ridge without pixels", "glass", false, "absent", "ridge", true],
    ["a cover kind whose WebGL failed", "glass", true, "pending", "ridge", true],
    ["Liquid holds while its pixels load", "liquid", false, "pending", "liquid", false],
    ["a kind that draws no cover ignores the pixels", "warp", false, "pending", "warp", true],
    ["a WebGL kind that failed", "warp", true, "absent", "ridge", true],
    ["Ridge", "ridge", false, "absent", "ridge", true],
    ["Off", "off", false, "pending", "off", true],
  ];

  it.each(cases)("%s", (_, picked, glFailed, pixels, target, ready) => {
    expect(dipTarget(picked, glFailed, pixels)).toEqual({ target, ready });
  });
});

describe("mountedKind", () => {
  it("starts a cover kind from Off while its pixels load", () => {
    expect(mountedKind("glass")).toBe("off");
  });

  it("starts a cover kind with no cover from Off too, for the seed to land", () => {
    expect(mountedKind("liquid")).toBe("off");
  });

  it("starts any other kind on itself", () => {
    expect(mountedKind("warp")).toBe("warp");
    expect(mountedKind("ridge")).toBe("ridge");
    expect(mountedKind("off")).toBe("off");
  });
});

describe("composePixels", () => {
  const bitmap = (name: string) => name as unknown as ImageBitmap;
  const cover = (state: CoverPixelState): CoverPixels => ({ pixels: state === "absent" ? null : bitmap("cover"), state });
  const seed = (state: CoverPixelState): CoverPixels => ({ pixels: state === "absent" ? null : bitmap("seed"), state });

  it("draws the seed for a coverless track, whatever the seed's state", () => {
    expect(composePixels(cover("absent"), seed("ready"), "coverless")).toEqual(seed("ready"));
    expect(composePixels(cover("absent"), seed("pending"), "coverless")).toEqual(seed("pending"));
    expect(composePixels(cover("absent"), seed("absent"), "coverless")).toEqual(seed("absent"));
  });

  it("keeps the cover while it loads or is ready", () => {
    expect(composePixels(cover("ready"), seed("ready"), "present")).toEqual(cover("ready"));
    expect(composePixels(cover("pending"), seed("ready"), "present")).toEqual(cover("pending"));
  });

  it("falls to the seed when a cover that exists fails to read", () => {
    expect(composePixels(cover("absent"), seed("ready"), "present")).toEqual(seed("ready"));
  });

  it("reads as pending, never absent, while the cover is unsettled with no src", () => {
    expect(composePixels(cover("absent"), seed("ready"), "pending")).toEqual({ pixels: bitmap("seed"), state: "pending" });
    expect(composePixels(cover("absent"), seed("absent"), "pending")).toEqual({ pixels: null, state: "pending" });
  });

  it("keeps a stale cover's pixels while the next track settles", () => {
    expect(composePixels(cover("ready"), seed("absent"), "pending")).toEqual(cover("ready"));
  });
});

describe("fallbackOf", () => {
  it("names no fallback while the stage draws the pick", () => {
    expect(fallbackOf("glass", "glass", false)).toBeNull();
  });

  it("names the missing cover, or the failed renderer", () => {
    expect(fallbackOf("glass", "ridge", false)).toBe("cover");
    expect(fallbackOf("glass", "ridge", true)).toBe("gl");
  });
});

describe("shouldRetryDefaults", () => {
  it("retries only a failed read on a track change", () => {
    expect(shouldRetryDefaults("failed", 1, 2)).toBe(true);
    expect(shouldRetryDefaults("failed", 2, 2)).toBe(false);
    expect(shouldRetryDefaults("ready", 1, 2)).toBe(false);
    expect(shouldRetryDefaults("loading", 1, 2)).toBe(false);
  });
});

describe("boundaryKey", () => {
  it("differs per track and between loading and ready defaults", () => {
    const keys = [-3, -1, 0, 1, 2].flatMap((id) => [boundaryKey(id, false), boundaryKey(id, true)]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reads the defaults landing as a boundary and an album key flip as manual", () => {
    const loading: DipLatch = { trackId: boundaryKey(5, false), target: "ridge", reason: "manual" };
    expect(dipReason(loading, boundaryKey(5, true), "glass")).toBe("boundary");
    const ready: DipLatch = { trackId: boundaryKey(5, true), target: "ridge", reason: "manual" };
    expect(dipReason(ready, boundaryKey(5, true), "glass")).toBe("manual");
  });
});

describe("dipReason", () => {
  const latch: DipLatch = { trackId: 1, target: "ridge", reason: "manual" };

  it("reads a target that changes with the track as a boundary", () => {
    expect(dipReason(latch, 2, "glass")).toBe("boundary");
  });

  it("reads a target that changes on the same track as manual", () => {
    expect(dipReason(latch, 1, "glass")).toBe("manual");
    expect(dipReason({ ...latch, reason: "boundary" }, 1, "glass")).toBe("manual");
  });

  it("keeps the latched reason while the target holds", () => {
    expect(dipReason({ ...latch, reason: "boundary" }, 1, "ridge")).toBe("boundary");
    expect(dipReason(latch, 2, "ridge")).toBe("manual");
  });
});
