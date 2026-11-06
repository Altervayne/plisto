// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { groupLabelText } from "./groupLabelText";
import { createT } from "../../../i18n";

// -- Type Imports --
import type { RecentBucket } from "./browseOrder";

const en = createT("en");
const fr = createT("fr");

describe("groupLabelText", () => {
  it("shows named groups as written", () => {
    expect(groupLabelText({ kind: "artist", value: "Amber Coast" }, en, 2026)).toBe("Amber Coast");
    expect(groupLabelText({ kind: "genre", value: "Jazz" }, en, 2026)).toBe("Jazz");
  });

  it("names the unknown buckets", () => {
    expect(groupLabelText({ kind: "unknownArtist" }, en, 2026)).toBe("Unknown artist");
    expect(groupLabelText({ kind: "noGenre" }, en, 2026)).toBe("No genre");
    expect(groupLabelText({ kind: "noYear" }, en, 2026)).toBe("Unknown year");
  });

  it("writes a decade without digit grouping", () => {
    expect(groupLabelText({ kind: "decade", value: 1990 }, en, 2026)).toBe("1990s");
    expect(groupLabelText({ kind: "decade", value: 2000 }, fr, 2026)).toBe("Années 2000");
  });

  it("names every recently-added bucket", () => {
    const recent = (bucket: RecentBucket) => groupLabelText({ kind: "recent", bucket }, en, 2026);
    expect(recent({ span: "week" })).toBe("This week");
    expect(recent({ span: "month" })).toBe("Last 30 days");
    expect(recent({ span: "thisYear" })).toBe("Earlier in 2026");
    expect(recent({ span: "year", year: 2025 })).toBe("2025");
    expect(recent({ span: "before", year: 2024 })).toBe("Before 2024");
  });
});
