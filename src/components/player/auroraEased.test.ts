// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { auroraEased } from "./auroraEased";

describe("auroraEased", () => {
  it("is eased while the gate is closed", () => {
    expect(auroraEased(false, "ridge", "balanced")).toBe(true);
  });

  it("is eased while the global pick is Off", () => {
    expect(auroraEased(true, "off", "balanced")).toBe(true);
  });

  it("is eased at Calm", () => {
    expect(auroraEased(true, "ridge", "calm")).toBe(true);
  });

  it("pulses otherwise", () => {
    expect(auroraEased(true, "ridge", "balanced")).toBe(false);
    expect(auroraEased(true, "ridge", "lively")).toBe(false);
  });
});
