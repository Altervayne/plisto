import { describe, expect, it } from "vitest";
import { albumsStampScope, menuStampTarget } from "./stampScope";

describe("menuStampTarget", () => {
  it("acts on the row alone when it is outside the selection", () => {
    const target = menuStampTarget(9, new Set([1, 2, 3]));
    expect(target.trackIds).toEqual([9]);
    expect(target.scope).toEqual({ kind: "tracks", trackIds: [9] });
  });

  it("acts on the row alone when nothing is selected", () => {
    expect(menuStampTarget(4, new Set()).trackIds).toEqual([4]);
  });

  it("acts on the whole selection when the row is in it", () => {
    const target = menuStampTarget(2, new Set([3, 2, 1]));
    expect(target.trackIds).toEqual([3, 2, 1]);
    expect(target.scope).toEqual({ kind: "tracks", trackIds: [3, 2, 1] });
  });

  it("follows the given order and appends ids it does not list", () => {
    const target = menuStampTarget(2, new Set([3, 2, 1, 7]), [1, 2, 3, 8]);
    expect(target.trackIds).toEqual([1, 2, 3, 7]);
  });
});

describe("albumsStampScope", () => {
  it("wraps the ids", () => {
    expect(albumsStampScope([5, 6])).toEqual({ kind: "albums", albumIds: [5, 6] });
  });
});
