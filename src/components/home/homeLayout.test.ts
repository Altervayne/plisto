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
    expect(parseLayout('[{"type":"ghost","size":"S"}]', "organizer")).toEqual(
      seedLayout("organizer"),
    );
  });

  it("keeps a valid saved layout verbatim", () => {
    const saved = '[{"type":"mostPlayed","size":"L"},{"type":"recentlyPlayed","size":"M"}]';
    expect(parseLayout(saved, "player")).toEqual([
      { type: "mostPlayed", size: "L" },
      { type: "recentlyPlayed", size: "M" },
    ]);
  });

  it("drops an unknown box type", () => {
    const saved = '[{"type":"ghost","size":"M"},{"type":"mostPlayed","size":"M"}]';
    expect(parseLayout(saved, "player")).toEqual([{ type: "mostPlayed", size: "M" }]);
  });

  it("drops a duplicate type, keeping its first placement", () => {
    const saved =
      '[{"type":"mostPlayed","size":"L"},{"type":"mostPlayed","size":"M"}]';
    expect(parseLayout(saved, "player")).toEqual([{ type: "mostPlayed", size: "L" }]);
  });

  it("clamps a size the type disallows to its default", () => {
    // A stat allows only S and M; a saved L clamps back to the S default.
    const saved = '[{"type":"missingCovers","size":"L"}]';
    expect(parseLayout(saved, "organizer")).toEqual([{ type: "missingCovers", size: "S" }]);
  });

  it("round-trips through serializeLayout", () => {
    const layout = seedLayout("both");
    expect(parseLayout(serializeLayout(layout), "both")).toEqual(layout);
  });
});

describe("reorderLayout", () => {
  const base = [
    { type: "missingCovers" as const, size: "S" as const },
    { type: "unsortedStat" as const, size: "S" as const },
    { type: "recentlyPlayed" as const, size: "M" as const },
  ];

  it("moves a box backward onto the target's slot", () => {
    expect(reorderLayout(base, "recentlyPlayed", "missingCovers")).toEqual([
      { type: "recentlyPlayed", size: "M" },
      { type: "missingCovers", size: "S" },
      { type: "unsortedStat", size: "S" },
    ]);
  });

  it("moves a box forward to after the target, not before it", () => {
    expect(reorderLayout(base, "missingCovers", "recentlyPlayed")).toEqual([
      { type: "unsortedStat", size: "S" },
      { type: "recentlyPlayed", size: "M" },
      { type: "missingCovers", size: "S" },
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
  const base = [{ type: "recentlyPlayed" as const, size: "M" as const }];

  it("sets an allowed size", () => {
    expect(resizeLayout(base, "recentlyPlayed", "L")).toEqual([
      { type: "recentlyPlayed", size: "L" },
    ]);
  });

  it("clamps a disallowed size to the default", () => {
    // A preview forbids S, so a request for it lands on the M default.
    expect(resizeLayout(base, "recentlyPlayed", "S")).toEqual([
      { type: "recentlyPlayed", size: "M" },
    ]);
  });
});

describe("removeBox", () => {
  it("drops the named box", () => {
    const base = [
      { type: "missingCovers" as const, size: "S" as const },
      { type: "unsortedStat" as const, size: "S" as const },
    ];
    expect(removeBox(base, "missingCovers")).toEqual([{ type: "unsortedStat", size: "S" }]);
  });
});

describe("addBox", () => {
  it("appends a box at its default size", () => {
    expect(addBox([], "mostPlayed")).toEqual([{ type: "mostPlayed", size: "M" }]);
  });

  it("is a no-op when the type is already placed", () => {
    const base = [{ type: "mostPlayed" as const, size: "L" as const }];
    expect(addBox(base, "mostPlayed")).toEqual(base);
  });
});

describe("nearestAllowedSize", () => {
  it("snaps a stat to S near one cell and M near two", () => {
    expect(nearestAllowedSize("missingCovers", 1, 1)).toBe("S");
    expect(nearestAllowedSize("missingCovers", 2, 1)).toBe("M");
  });

  it("snaps a preview to the closest of its wide and large footprints", () => {
    expect(nearestAllowedSize("recentlyPlayed", 2, 1)).toBe("M");
    expect(nearestAllowedSize("recentlyPlayed", 2, 2)).toBe("L");
  });

  it("clamps a target past the largest footprint to the largest allowed", () => {
    expect(nearestAllowedSize("recentlyPlayed", 3, 3)).toBe("L");
  });
});

describe("cycleSize", () => {
  it("advances to the next allowed size", () => {
    expect(cycleSize([{ type: "recentlyPlayed", size: "M" }], "recentlyPlayed")).toEqual([
      { type: "recentlyPlayed", size: "L" },
    ]);
  });

  it("wraps past the last allowed size back to the first", () => {
    // A preview cycles M -> L -> M.
    expect(cycleSize([{ type: "recentlyPlayed", size: "L" }], "recentlyPlayed")).toEqual([
      { type: "recentlyPlayed", size: "M" },
    ]);
  });
});
