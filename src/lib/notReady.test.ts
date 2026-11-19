// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { isNotReady, isStaleProposal, notReadyError } from "./ipc";

describe("isNotReady", () => {
  it("recognises the store's refusal", () => {
    expect(isNotReady(notReadyError())).toBe(true);
  });

  it("recognises it after it crossed a string boundary", () => {
    expect(isNotReady(String(notReadyError()))).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isNotReady(new Error("disk full"))).toBe(false);
    expect(isNotReady("the proposal is out of date")).toBe(false);
    expect(isNotReady(null)).toBe(false);
    expect(isStaleProposal(notReadyError())).toBe(false);
  });
});
