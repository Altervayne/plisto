// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { versionChange } from "./version";

describe("versionChange", () => {
  it("orders numerically, not as text", () => {
    expect(versionChange("1.9.0", "1.10.0")).toBe("upgrade");
    expect(versionChange("2.0.0", "1.9.9")).toBe("downgrade");
    expect(versionChange("1.0.0", "1.0.0")).toBe("same");
  });

  it("treats a missing part as zero", () => {
    expect(versionChange("1.0", "1.0.0")).toBe("same");
  });

  it("ranks a pre-release below its release", () => {
    expect(versionChange("1.0.0", "1.0.0-beta")).toBe("downgrade");
    expect(versionChange("1.0.0-beta", "1.0.0")).toBe("upgrade");
  });

  it("says unknown for a version it cannot read", () => {
    expect(versionChange("", "1.0.0")).toBe("unknown");
    expect(versionChange("1.0.0", "next")).toBe("unknown");
  });
});
