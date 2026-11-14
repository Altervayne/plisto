// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { probeOutcome, sheetVariant, tagKind } from "./trust";

describe("the sheet variant", () => {
  it("is heavy for a native plugin whatever the probe says", () => {
    expect(sheetVariant("native", "passed")).toBe("heavy");
    expect(sheetVariant("native", "not_passed")).toBe("heavy");
  });

  it("is calm for a UI plugin once the sandbox passed, unsandboxed until then", () => {
    expect(sheetVariant("ui", "passed")).toBe("calm");
    expect(sheetVariant("ui", "not_passed")).toBe("unsandboxed");
  });

  it("reads the live check outcome: only a leak makes it unsandboxed", () => {
    expect(sheetVariant("ui", probeOutcome("leaking"))).toBe("unsandboxed");
    for (const outcome of ["pending", "passed", "unverified"] as const) {
      expect(sheetVariant("ui", probeOutcome(outcome))).toBe("calm");
    }
  });
});

describe("the probe outcome", () => {
  it("maps a leak to not_passed and every other state to passed", () => {
    expect(probeOutcome("leaking")).toBe("not_passed");
    expect(probeOutcome("passed")).toBe("passed");
    expect(probeOutcome("pending")).toBe("passed");
    expect(probeOutcome("unverified")).toBe("passed");
  });
});

describe("the tag", () => {
  it("marks native always, unsandboxed only while unproven, and a proven UI plugin not at all", () => {
    expect(tagKind("native", "passed")).toBe("native");
    expect(tagKind("ui", "not_passed")).toBe("unsandboxed");
    expect(tagKind("ui", "passed")).toBeNull();
  });
});
