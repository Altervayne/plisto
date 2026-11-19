// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { combineStates } from "./projectionStatus";

describe("combineStates", () => {
  it("is ready only when both are", () => {
    expect(combineStates("ready", "ready")).toBe("ready");
    expect(combineStates("ready", "loading")).toBe("loading");
  });

  it("is stalled when either waiting one has stalled", () => {
    expect(combineStates("ready", "stalled")).toBe("stalled");
    expect(combineStates("stalled", "loading")).toBe("stalled");
  });
});
