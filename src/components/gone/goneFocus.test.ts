// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { wrapTab } from "./goneFocus";

describe("wrapTab", () => {
  it("wraps forward from the last item and backward from the first", () => {
    expect(wrapTab(4, 5, false)).toBe(0);
    expect(wrapTab(0, 5, true)).toBe(4);
  });

  it("treats focus outside the list as before the first", () => {
    expect(wrapTab(-1, 5, true)).toBe(4);
  });

  it("lets Tab move normally in the middle and with nothing to focus", () => {
    expect(wrapTab(2, 5, false)).toBeNull();
    expect(wrapTab(2, 5, true)).toBeNull();
    expect(wrapTab(0, 0, false)).toBeNull();
  });
});
