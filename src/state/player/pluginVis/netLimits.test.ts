// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { HANG_LIMIT_MS, SLOW_FRAME_LIMIT_MS, SLOW_SPAN_MS } from "./netLimits";

describe("netLimits", () => {
  it("pins the limits so none moves unnoticed", () => {
    expect(HANG_LIMIT_MS).toBe(2000);
    expect(SLOW_FRAME_LIMIT_MS).toBe(50);
    expect(SLOW_SPAN_MS).toBe(5000);
  });

  it("holds a hang limit longer than a slow frame and a span longer than the hang limit", () => {
    expect(HANG_LIMIT_MS).toBeGreaterThan(SLOW_FRAME_LIMIT_MS);
    expect(SLOW_SPAN_MS).toBeGreaterThan(HANG_LIMIT_MS);
  });
});
