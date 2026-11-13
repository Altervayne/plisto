// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { SANDBOX_PROBE, sheetVariant, tagKind } from "./trust";

describe("the sheet variant", () => {
  it("is heavy for a native plugin whatever the probe says", () => {
    expect(sheetVariant("native", "passed")).toBe("heavy");
    expect(sheetVariant("native", "not_passed")).toBe("heavy");
  });

  it("is calm for a UI plugin once the sandbox passed, unsandboxed until then", () => {
    expect(sheetVariant("ui", "passed")).toBe("calm");
    expect(sheetVariant("ui", "not_passed")).toBe("unsandboxed");
  });

  it("follows the recorded outcome by default", () => {
    expect(sheetVariant("ui")).toBe(sheetVariant("ui", SANDBOX_PROBE));
    expect(SANDBOX_PROBE).toBe("passed");
  });
});

describe("the tag", () => {
  it("marks native always, unsandboxed only while unproven, and a proven UI plugin not at all", () => {
    expect(tagKind("native", "passed")).toBe("native");
    expect(tagKind("ui", "not_passed")).toBe("unsandboxed");
    expect(tagKind("ui", "passed")).toBeNull();
  });
});
