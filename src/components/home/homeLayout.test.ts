// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  addBox,
  cycleSize,
  nearestAllowedSize,
  parseLayout,
  removeBox,
  reorderLayout,
  resizeLayout,
  serializeLayout,
} from "./homeLayout";
import { seedLayout } from "./boxCatalog";

describe("parseLayout", () => {
  it("falls back to the seed on an absent pref", () => {
    expect(parseLayout(undefined, "both")).toEqual(seedLayout("both"));
  });

  it("falls back to the seed on unparseable json", () => {
    expect(parseLayout("{not json", "player")).toEqual(seedLayout("player"));
  });

  it("falls back to the seed on a non-array", () => {
    expect(parseLayout('{"type":"mostPlayed"}', "player")).toEqual(seedLayout("player"));
  });

  it("falls back to the seed when nothing survives validation", () => {
    expect(parseLayout('[{"type":"ghost","size":"1x1"}]', "organizer")).toEqual(
      seedLayout("organizer"),
    );
  });

  it("keeps a deliberately-cleared layout empty, never re-seeding it", () => {
    // Removing every box saves "[]"; it must read back empty, or an emptied Home refills itself.
    expect(parseLayout("[]", "both")).toEqual([]);
  });

  it("keeps a valid saved layout verbatim", () => {
    const saved = '[{"type":"mostPlayed","size":"2x2"},{"type":"recentlyPlayed","size":"2x1"}]';
    expect(parseLayout(saved, "player")).toEqual([
      { type: "mostPlayed", size: "2x2" },
      { type: "recentlyPlayed", size: "2x1" },
    ]);
  });

  it("drops an unknown box type", () => {
    const saved = '[{"type":"ghost","size":"2x1"},{"type":"mostPlayed","size":"2x1"}]';
    expect(parseLayout(saved, "player")).toEqual([{ type: "mostPlayed", size: "2x1" }]);
  });

  it("drops a duplicate type, keeping its first placement", () => {
    const saved = '[{"type":"mostPlayed","size":"2x2"},{"type":"mostPlayed","size":"2x1"}]';
    expect(parseLayout(saved, "player")).toEqual([{ type: "mostPlayed", size: "2x2" }]);
  });

  it("clamps a size the type disallows to its default", () => {
    // A stat allows only 1x1; a saved 2x2 clamps back to the 1x1 default.
    const saved = '[{"type":"missingCovers","size":"2x2"}]';
    expect(parseLayout(saved, "organizer")).toEqual([{ type: "missingCovers", size: "1x1" }]);
  });

  it("drops a well-formed but unauthorized footprint to the box default", () => {
    expect(parseLayout('[{"type":"mostPlayed","size":"1x2"}]', "player")).toEqual([
      { type: "mostPlayed", size: "2x1" },
    ]);
    expect(parseLayout('[{"type":"mostPlayed","size":"4x4"}]', "player")).toEqual([
      { type: "mostPlayed", size: "2x1" },
    ]);
  });

  it("round-trips through serializeLayout", () => {
    const layout = seedLayout("both");
    expect(parseLayout(serializeLayout(layout), "both")).toEqual(layout);
  });
});

describe("parseLayout legacy migration", () => {
  it("migrates a list box's legacy L to 2x2", () => {
    expect(parseLayout('[{"type":"mostPlayed","size":"L"}]', "player")).toEqual([
      { type: "mostPlayed", size: "2x2" },
    ]);
  });

  it("migrates a list box's legacy M to 2x1", () => {
    expect(parseLayout('[{"type":"recentlyPlayed","size":"M"}]', "player")).toEqual([
      { type: "recentlyPlayed", size: "2x1" },
    ]);
  });

  it("migrates a stat's legacy M down to its only 1x1", () => {
    expect(parseLayout('[{"type":"missingCovers","size":"M"}]', "organizer")).toEqual([
      { type: "missingCovers", size: "1x1" },
    ]);
  });

  it("migrates a stat's legacy S to 1x1", () => {
    expect(parseLayout('[{"type":"missingCovers","size":"S"}]', "organizer")).toEqual([
      { type: "missingCovers", size: "1x1" },
    ]);
  });

  it("migrates playNext's legacy T through 2x2 to its only 2x1", () => {
    expect(parseLayout('[{"type":"playNext","size":"T"}]', "player")).toEqual([
      { type: "playNext", size: "2x1" },
    ]);
  });
});

describe("reorderLayout", () => {
  const base = [
    { type: "missingCovers" as const, size: "1x1" as const },
    { type: "unsortedStat" as const, size: "1x1" as const },
    { type: "recentlyPlayed" as const, size: "2x1" as const },
  ];

  it("moves a box backward onto the target's slot", () => {
    expect(reorderLayout(base, "recentlyPlayed", "missingCovers")).toEqual([
      { type: "recentlyPlayed", size: "2x1" },
      { type: "missingCovers", size: "1x1" },
      { type: "unsortedStat", size: "1x1" },
    ]);
  });

  it("moves a box forward to after the target, not before it", () => {
    expect(reorderLayout(base, "missingCovers", "recentlyPlayed")).toEqual([
      { type: "unsortedStat", size: "1x1" },
      { type: "recentlyPlayed", size: "2x1" },
      { type: "missingCovers", size: "1x1" },
    ]);
  });

  it("is a no-op when a type is absent", () => {
    expect(reorderLayout(base, "mostPlayed", "missingCovers")).toEqual(base);
  });

  it("returns a new array", () => {
    expect(reorderLayout(base, "missingCovers", "missingCovers")).not.toBe(base);
  });
});

describe("resizeLayout", () => {
  const base = [{ type: "recentlyPlayed" as const, size: "2x1" as const }];

  it("sets an allowed size", () => {
    expect(resizeLayout(base, "recentlyPlayed", "2x2")).toEqual([
      { type: "recentlyPlayed", size: "2x2" },
    ]);
  });

  it("clamps a disallowed size to the default", () => {
    // A list box forbids 1x1, so a request for it lands on the 2x1 default.
    expect(resizeLayout(base, "recentlyPlayed", "1x1")).toEqual([
      { type: "recentlyPlayed", size: "2x1" },
    ]);
  });
});

describe("removeBox", () => {
  it("drops the named box", () => {
    const base = [
      { type: "missingCovers" as const, size: "1x1" as const },
      { type: "unsortedStat" as const, size: "1x1" as const },
    ];
    expect(removeBox(base, "missingCovers")).toEqual([{ type: "unsortedStat", size: "1x1" }]);
  });
});

describe("addBox", () => {
  it("appends a box at its default size", () => {
    expect(addBox([], "mostPlayed")).toEqual([{ type: "mostPlayed", size: "2x1" }]);
  });

  it("is a no-op when the type is already placed", () => {
    const base = [{ type: "mostPlayed" as const, size: "2x2" as const }];
    expect(addBox(base, "mostPlayed")).toEqual(base);
  });
});

describe("nearestAllowedSize", () => {
  it("snaps a stat to its single footprint from any target", () => {
    expect(nearestAllowedSize("missingCovers", 1, 1)).toBe("1x1");
    expect(nearestAllowedSize("missingCovers", 2, 1)).toBe("1x1");
  });

  it("snaps a list box to the closest authorized footprint", () => {
    expect(nearestAllowedSize("recentlyPlayed", 2, 1)).toBe("2x1");
    expect(nearestAllowedSize("recentlyPlayed", 3, 2)).toBe("3x2");
    expect(nearestAllowedSize("recentlyPlayed", 2, 3)).toBe("2x3");
  });

  it("clamps a target past the largest footprint to the largest allowed", () => {
    expect(nearestAllowedSize("recentlyPlayed", 4, 4)).toBe("3x3");
  });
});

describe("cycleSize", () => {
  it("advances to the next allowed size", () => {
    expect(cycleSize([{ type: "recentlyPlayed", size: "2x1" }], "recentlyPlayed")).toEqual([
      { type: "recentlyPlayed", size: "3x1" },
    ]);
  });

  it("wraps past the last allowed size back to the first", () => {
    // A list box cycles the six-long ring, 3x3 wrapping to 2x1.
    expect(cycleSize([{ type: "recentlyPlayed", size: "3x3" }], "recentlyPlayed")).toEqual([
      { type: "recentlyPlayed", size: "2x1" },
    ]);
  });
});
