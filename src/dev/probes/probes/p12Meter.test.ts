// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { judgeMeter } from "./p12Meter";
import type { MeterReading } from "./p12Meter";

const ok = (median: number, over: Partial<MeterReading> = {}): MeterReading => ({
  samples: 600,
  median,
  steps: 6000,
  skipped: 0,
  ...over,
});

describe("judgeMeter", () => {
  it("passes medians under 0.3 ms at both sizes", () => {
    expect(judgeMeter([ok(0.05), ok(0.2999)], 2)).toBe("pass");
  });

  it("fails a median of 0.3 ms or more at either size", () => {
    expect(judgeMeter([ok(0.05), ok(0.3)], 2)).toBe("fail");
    expect(judgeMeter([ok(0.4), ok(0.05)], 2)).toBe("fail");
  });

  it("is invalid when a size produced no reading", () => {
    expect(judgeMeter([ok(0.05)], 2)).toBe("invalid");
  });

  it("is invalid, not a pass, when a size has no samples", () => {
    expect(judgeMeter([ok(0.05), ok(0, { samples: 0 })], 2)).toBe("invalid");
  });

  it("is invalid when more than half the steps skipped their readback, valid at exactly half", () => {
    expect(judgeMeter([ok(0.05), ok(0.05, { skipped: 3001 })], 2)).toBe("invalid");
    expect(judgeMeter([ok(0.05), ok(0.05, { skipped: 3000 })], 2)).toBe("pass");
  });
});
