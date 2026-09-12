// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { BOX_CATALOG, BOX_ORDER, SIZE_SPAN, seedLayout } from "./boxCatalog";

describe("seedLayout", () => {
  it("seeds the organizer landing with the covers and unsorted boxes", () => {
    expect(seedLayout("organizer")).toEqual([
      { type: "missingCovers", size: "S" },
      { type: "unsortedStat", size: "S" },
      { type: "unsortedPreview", size: "M" },
    ]);
  });

  it("seeds the player landing with the two play-history previews", () => {
    expect(seedLayout("player")).toEqual([
      { type: "recentlyPlayed", size: "M" },
      { type: "mostPlayed", size: "M" },
    ]);
  });

  it("seeds the both landing with the stats and the play-history previews", () => {
    expect(seedLayout("both")).toEqual([
      { type: "missingCovers", size: "S" },
      { type: "unsortedStat", size: "S" },
      { type: "recentlyPlayed", size: "M" },
      { type: "mostPlayed", size: "M" },
    ]);
  });

  it("emits boxes in the catalog's placement order", () => {
    const order = seedLayout("both").map((seed) => seed.type);
    const expected = BOX_ORDER.filter((type) => BOX_CATALOG[type].modes.includes("both"));
    expect(order).toEqual(expected);
  });
});

describe("SIZE_SPAN", () => {
  it("maps each size to its column and row footprint", () => {
    expect(SIZE_SPAN.S).toEqual({ cols: 1, rows: 1 });
    expect(SIZE_SPAN.M).toEqual({ cols: 2, rows: 1 });
    expect(SIZE_SPAN.T).toEqual({ cols: 1, rows: 2 });
    expect(SIZE_SPAN.L).toEqual({ cols: 2, rows: 2 });
  });
});
