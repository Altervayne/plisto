import { describe, expect, it } from "vitest";

import { planLanding } from "./handoffLanding";

const wall = new Set([1, 2, 3]);
const all = new Set([1, 2, 3]);

describe("planLanding", () => {
  it("ignores a missing hand-off and a target from the other wall", () => {
    expect(planLanding(null, wall, all, true)).toEqual({ kind: "ignore" });
    expect(planLanding({ albumId: 9, how: "open" }, wall, all, true)).toEqual({ kind: "ignore" });
  });

  it("lands open and select by album id", () => {
    expect(planLanding({ albumId: 2, how: "open" }, wall, all, true)).toEqual({
      kind: "land",
      albumId: 2,
      how: "open",
    });
    expect(planLanding({ albumId: 2, how: "select" }, wall, all, true)).toEqual({
      kind: "land",
      albumId: 2,
      how: "select",
    });
  });

  it("clears the filter first when it hides the target", () => {
    expect(planLanding({ albumId: 3, how: "open" }, wall, new Set([1]), true)).toEqual({
      kind: "clear-filter",
    });
  });

  it("lands select as open in Player mode", () => {
    expect(planLanding({ albumId: 1, how: "select" }, wall, all, false)).toEqual({
      kind: "land",
      albumId: 1,
      how: "open",
    });
  });
});
