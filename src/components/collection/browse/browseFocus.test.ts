// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { resolveFocus } from "./browseFocus";

const ids = [10, 20, 30, 40];
const offsetOf = (id: number) => {
  const i = ids.indexOf(id);
  return i === -1 ? null : i;
};

describe("resolveFocus", () => {
  it("keeps a present id wherever it sits", () => {
    expect(resolveFocus(offsetOf, 4, 30, 0)).toBe(2);
  });

  it("lands on the record now at the old index when the id is gone", () => {
    expect(resolveFocus(offsetOf, 4, 99, 2)).toBe(2);
  });

  it("clamps the old index when the order shrank past it", () => {
    expect(resolveFocus(offsetOf, 2, 99, 3)).toBe(1);
  });

  it("starts at the beginning on a fresh mount with a stale id", () => {
    expect(resolveFocus(offsetOf, 4, 99, null)).toBe(0);
  });

  it("starts at the beginning with no stored id", () => {
    expect(resolveFocus(offsetOf, 4, null, null)).toBe(0);
  });

  it("is 0 for an empty order", () => {
    expect(resolveFocus(offsetOf, 0, 10, 5)).toBe(0);
  });
});
