// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { BOX_CATALOG, BOX_ORDER, SIZE_SPAN, boxInMode, seedLayout } from "./boxCatalog";

// -- Type Imports --
import type { BoxSize, BoxType } from "./boxCatalog";

describe("seedLayout", () => {
  it("seeds the organizer landing with the covers, unsorted, and missing-metadata boxes", () => {
    expect(seedLayout("organizer")).toEqual([
      { type: "missingCovers", size: "1x1" },
      { type: "unsortedStat", size: "1x1" },
      { type: "unsortedPreview", size: "2x1" },
      { type: "missingMetadata", size: "1x1" },
    ]);
  });

  it("seeds the player landing with the play-history previews and the suggestions", () => {
    expect(seedLayout("player")).toEqual([
      { type: "recentlyPlayed", size: "2x1" },
      { type: "mostPlayed", size: "2x1" },
      { type: "playNext", size: "2x1" },
      { type: "moreFromArtist", size: "2x1" },
    ]);
  });

  it("seeds the both landing with the stats, the play-history previews, and the suggestions", () => {
    expect(seedLayout("both")).toEqual([
      { type: "missingCovers", size: "1x1" },
      { type: "unsortedStat", size: "1x1" },
      { type: "unsortedPreview", size: "2x1" },
      { type: "recentlyPlayed", size: "2x1" },
      { type: "mostPlayed", size: "2x1" },
      { type: "missingMetadata", size: "1x1" },
      { type: "playNext", size: "2x1" },
      { type: "moreFromArtist", size: "2x1" },
    ]);
  });

  it("emits boxes in the catalog's placement order", () => {
    const order = seedLayout("both").map((seed) => seed.type);
    const expected = BOX_ORDER.filter((type) => boxInMode(type, "both"));
    expect(order).toEqual(expected);
  });

  it("treats the both landing as the union of the base modes", () => {
    // Every box seeds organizer or player, so the union is every box in placement order.
    expect(seedLayout("both").map((seed) => seed.type)).toEqual([...BOX_ORDER]);
  });
});

describe("SIZE_SPAN", () => {
  it("maps each authorized footprint to its column and row span", () => {
    expect(SIZE_SPAN["1x1"]).toEqual({ cols: 1, rows: 1 });
    expect(SIZE_SPAN["2x1"]).toEqual({ cols: 2, rows: 1 });
    expect(SIZE_SPAN["3x1"]).toEqual({ cols: 3, rows: 1 });
    expect(SIZE_SPAN["2x2"]).toEqual({ cols: 2, rows: 2 });
    expect(SIZE_SPAN["3x2"]).toEqual({ cols: 3, rows: 2 });
    expect(SIZE_SPAN["2x3"]).toEqual({ cols: 2, rows: 3 });
    expect(SIZE_SPAN["3x3"]).toEqual({ cols: 3, rows: 3 });
  });

  it("holds exactly the seven authorized footprints, with no 1x2 or 1x3 tower", () => {
    expect(Object.keys(SIZE_SPAN).sort()).toEqual(
      ["1x1", "2x1", "2x2", "2x3", "3x1", "3x2", "3x3"],
    );
    expect(SIZE_SPAN).not.toHaveProperty("1x2");
    expect(SIZE_SPAN).not.toHaveProperty("1x3");
  });
});

describe("BOX_CATALOG", () => {
  const authorized = new Set(Object.keys(SIZE_SPAN));

  it("draws every box's allowed sizes only from the authorized footprints", () => {
    for (const type of BOX_ORDER) {
      for (const size of BOX_CATALOG[type].allowedSizes) {
        expect(authorized.has(size)).toBe(true);
      }
    }
  });

  it("keeps every box's default size within its own allowed sizes", () => {
    for (const type of BOX_ORDER) {
      expect(BOX_CATALOG[type].allowedSizes).toContain(BOX_CATALOG[type].size);
    }
  });

  it("pins playNext to the single wide footprint", () => {
    expect(BOX_CATALOG.playNext.allowedSizes).toEqual<BoxSize[]>(["2x1"]);
  });

  it("pins each stat box to the single cell", () => {
    const stats: BoxType[] = ["missingCovers", "unsortedStat", "missingMetadata"];
    for (const type of stats) {
      expect(BOX_CATALOG[type].allowedSizes).toEqual<BoxSize[]>(["1x1"]);
    }
  });
});
