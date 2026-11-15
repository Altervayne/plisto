// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { zoneFor } from "./usePluginZone";
import { manifest, row } from "../../../state/plugins/fixtures";

const rows = [row({ id: "lyrics", manifest: manifest({ name: "Lyrics" }) })];

describe("zoneFor", () => {
  it("lists the live plugins while they run", () => {
    expect(zoneFor(rows, "both", "running").compact.map((p) => p.id)).toEqual(["lyrics"]);
    expect(zoneFor(rows, "both", null).compact).toHaveLength(1);
  });

  it("is empty in safe mode", () => {
    const zone = zoneFor(rows, "both", "safe");
    expect(zone.sections).toEqual([]);
    expect(zone.compact).toEqual([]);
  });
});
