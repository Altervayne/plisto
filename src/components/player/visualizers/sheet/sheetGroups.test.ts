// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { sheetGroupLabel, sheetGroupsOf, showsChips } from "./sheetGroups";
import { createT } from "../../../../i18n";
import { ALL_OFFERED, buildCatalog, serializeCatalog } from "../../../../state/player/visualizerCatalog";
import { VISUALIZER_DESCRIPTORS } from "../../../../state/player/visualizerRegistry";
import { resolveVisualizer } from "../../../../state/player/visualizerResolve";

const without = (kinds: string[], groups: string[] = []) =>
  buildCatalog(serializeCatalog({ kinds, groups }), false);

describe("sheetGroupsOf", () => {
  it("lists every family in registry order, Off last", () => {
    expect(sheetGroupsOf(ALL_OFFERED).map((g) => g.id)).toEqual(["classic", "dots", "fluid", "cozy", "cyber", "off"]);
    const groups = sheetGroupsOf(ALL_OFFERED);
    expect(groups[groups.length - 1].kinds).toEqual(["off"]);
  });

  it("drops a turned-off family and a family with no offered kind", () => {
    const ids = (c: ReturnType<typeof without>) => sheetGroupsOf(c).map((g) => g.id);
    expect(ids(without([], ["dots"]))).toEqual(["classic", "fluid", "cozy", "cyber", "off"]);
    expect(ids(without(["halftone", "dot-spectrum", "dot-cover"]))).toEqual(["classic", "fluid", "cozy", "cyber", "off"]);
  });

  it("drops a turned-off kind from its run", () => {
    const cozy = sheetGroupsOf(without(["train"])).find((g) => g.id === "cozy");
    expect(cozy?.kinds).not.toContain("train");
    expect(cozy?.kinds).toHaveLength(7);
  });

  it("keeps Off alone when one family is left", () => {
    const groups = sheetGroupsOf(without([], ["classic", "dots", "fluid", "cyber"]));
    expect(groups.map((g) => g.id)).toEqual(["cozy", "off"]);
    expect(showsChips(groups)).toBe(false);
  });

  it("shows chips from two families up", () => {
    expect(showsChips(sheetGroupsOf(ALL_OFFERED))).toBe(true);
    expect(showsChips(sheetGroupsOf(without([], ["fluid", "cozy", "cyber"])))).toBe(true);
  });

  it("holds the resolved kind in a run under any catalog (seeded)", () => {
    const ids = VISUALIZER_DESCRIPTORS.map((d) => d.id);
    const families = ["classic", "dots", "fluid", "cozy", "cyber"];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 300; i++) {
      const kinds = ids.filter(() => rand() < 0.6);
      const groups = families.filter(() => rand() < 0.3);
      const catalog = without(kinds, groups);
      const picks = [...ids, "off", "ghost"];
      const input = (global: string, trackDefault: string | null) => ({
        global: global as never,
        trackDefault,
        albumDefault: picks[Math.floor(rand() * picks.length)],
        override: null,
        albumKey: "album:1",
        catalog,
      });
      const res = resolveVisualizer(input(picks[Math.floor(rand() * picks.length)], picks[Math.floor(rand() * picks.length)]));
      const held = sheetGroupsOf(catalog).some((g) => g.kinds.includes(res.picked));
      expect(held).toBe(true);
    }
  });
});

describe("sheetGroupLabel", () => {
  it("names a family and Off in each locale", () => {
    const en = createT("en");
    const fr = createT("fr");
    expect(sheetGroupLabel("cozy", en)).toBe("Cozy");
    expect(sheetGroupLabel("cozy", fr)).toBe("Cosy");
    expect(sheetGroupLabel("cyber", en)).toBe("Cyber");
    expect(sheetGroupLabel("cyber", fr)).toBe("Cyber");
    expect(sheetGroupLabel("off", en)).toBe("Off");
  });

  it("reads an unknown family as its id", () => {
    expect(sheetGroupLabel("cosmic", createT("en"))).toBe("cosmic");
    expect(sheetGroupLabel("constructor", createT("en"))).toBe("constructor");
  });
});
