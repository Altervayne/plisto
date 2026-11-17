// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { MAX_CRASHES, WARNING, classifyGpuOutcome, continuesAfter, probe } from "./p07GpuLoss";
import { p7aVerdict } from "./p07aContextLoss";

// -- Local Imports --
import { CATALOG, runAllOrder, runDisabled } from "../catalog";

const seen = { webglAvailable: true, rendererBefore: "GPU A", rendererAfter: "GPU A", lost: 2, restored: 2 };

describe("P7b rules", () => {
  it("names each outcome", () => {
    expect(classifyGpuOutcome(seen)).toBe("clean-restart");
    expect(classifyGpuOutcome({ ...seen, rendererAfter: "Software" })).toBe("renderer-changed");
    expect(classifyGpuOutcome({ ...seen, webglAvailable: false })).toBe("webgl-refused");
    expect(classifyGpuOutcome({ ...seen, lost: 0, restored: 0 })).toBe("not-lost");
    expect(classifyGpuOutcome({ ...seen, restored: 1 })).toBe("not-restored");
  });

  it("goes on only after a clean restart, at most three times", () => {
    expect(continuesAfter("clean-restart")).toBe(true);
    for (const o of ["renderer-changed", "webgl-refused", "not-lost", "not-restored"] as const) {
      expect(continuesAfter(o)).toBe(false);
    }
    expect(MAX_CRASHES).toBe(3);
  });

  it("is absent from Run all and disabled until acknowledged", () => {
    const entry = CATALOG.find((e) => e.id === "P7b");
    expect(entry).toBeDefined();
    expect(runAllOrder(CATALOG)).not.toContain("P7b");
    expect(runDisabled(entry!, true, true, false, false)).toBe(true);
    expect(runDisabled(entry!, true, true, true, false)).toBe(false);
  });

  it("supplies the card warning, matching the catalog's", () => {
    expect(probe.warning).toBe(WARNING);
    expect(WARNING).toBe(CATALOG.find((e) => e.id === "P7b")?.warning);
  });
});

describe("p7aVerdict", () => {
  it("passes when the frame lost its context and the page saw none", () => {
    expect(p7aVerdict({ frameLost: true, watched: 2, mainLost: 0 }).state).toBe("pass");
  });

  it("fails when a page context was lost", () => {
    expect(p7aVerdict({ frameLost: true, watched: 2, mainLost: 1 }).state).toBe("fail");
  });

  it("is invalid when the loss was not exercised", () => {
    expect(p7aVerdict({ frameLost: false, watched: 2, mainLost: 0 }).state).toBe("invalid");
    expect(p7aVerdict({ frameLost: true, watched: 1, mainLost: 0 }).state).toBe("invalid");
  });
});
