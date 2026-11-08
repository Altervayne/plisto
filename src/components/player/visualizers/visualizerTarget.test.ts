// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { dipReason, dipTarget, mountedKind, type DipLatch } from "./visualizerTarget";
import type { CoverPixelState } from "./useCoverPixels";
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
    expect(mountedKind("glass", "cover.jpg")).toBe("off");
  });

  it("starts a cover kind with no cover on Ridge", () => {
    expect(mountedKind("glass", null)).toBe("ridge");
  });

  it("starts any other kind on itself", () => {
    expect(mountedKind("warp", "cover.jpg")).toBe("warp");
    expect(mountedKind("ridge", null)).toBe("ridge");
    expect(mountedKind("off", "cover.jpg")).toBe("off");
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
