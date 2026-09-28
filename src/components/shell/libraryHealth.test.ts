// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { healthReasons } from "./libraryHealth";

const clean = { offlineRoots: [], checkFailed: false, goneCount: 0 };

describe("healthReasons", () => {
  it("reads in sync when nothing is wrong", () => {
    expect(healthReasons(clean)).toEqual([]);
  });

  it("flags each signal on its own", () => {
    expect(healthReasons({ ...clean, offlineRoots: [4] })).toEqual([
      { kind: "offline", rootIds: [4] },
    ]);
    expect(healthReasons({ ...clean, checkFailed: true })).toEqual([{ kind: "checkFailed" }]);
    expect(healthReasons({ ...clean, goneCount: 7 })).toEqual([{ kind: "gone", n: 7 }]);
  });

  it("lists every reason at once, offline first", () => {
    expect(healthReasons({ offlineRoots: [1, 2], checkFailed: true, goneCount: 3 })).toEqual([
      { kind: "offline", rootIds: [1, 2] },
      { kind: "checkFailed" },
      { kind: "gone", n: 3 },
    ]);
  });
});
