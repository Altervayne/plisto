// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  ALL_OFFERED,
  BUILTIN_ENTRIES,
  buildCatalog,
  canTurnOff,
  catalogOf,
  familyState,
  isOffered,
  nextOfferedKind,
  offeredGroups,
  parseCatalog,
  serializeCatalog,
  toggleGroup,
  toggleKind,
  type Catalog,
  type CatalogEntry,
  type CatalogState,
} from "./visualizerCatalog";
import { GROUP_ORDER, VISUALIZER_DESCRIPTORS } from "./visualizerRegistry";

const NOTHING_OFF: CatalogState = { kinds: [], groups: [] };
const ALL_KINDS = VISUALIZER_DESCRIPTORS.map((d) => d.id as string);
const kindsOf = (group: string) => BUILTIN_ENTRIES.filter((e) => e.group === group).map((e) => e.id);

const stored = (kinds: unknown[], groups: unknown[] = []) => JSON.stringify({ v: 1, kinds, groups });
const catalog = (kinds: string[], groups: string[] = [], entries?: readonly CatalogEntry[]) =>
  buildCatalog(stored(kinds, groups), false, entries);
const after = (c: Catalog, next: CatalogState | null, entries?: readonly CatalogEntry[]) => {
  if (!next) throw new Error("toggle refused");
  return buildCatalog(serializeCatalog(next), false, entries ?? c.entries);
};

describe("parseCatalog", () => {
  it.each([undefined, null, "", "[]", '"x"', "null", "{not json", "42"])(
    "reads %s as nothing disabled and writable",
    (raw) => {
      expect(parseCatalog(raw, false)).toEqual({ state: NOTHING_OFF, writable: true });
    },
  );

  it("refuses writes for a newer version and offers everything", () => {
    expect(parseCatalog(stored(["ridge"]).replace('"v":1', '"v":2'), false)).toEqual({
      state: NOTHING_OFF,
      writable: false,
    });
  });

  it("refuses writes for a fractional version above the next one", () => {
    expect(parseCatalog('{"v":2.5,"kinds":["ridge"]}', false)).toEqual({ state: NOTHING_OFF, writable: false });
  });

  it.each([
    '{"v":1.5,"kinds":["ridge"]}',
    '{"v":"1","kinds":["ridge"]}',
    '{"v":"2","kinds":["ridge"]}',
    '{"v":null,"kinds":["ridge"]}',
    '{"v":0,"kinds":["ridge"]}',
    '{"v":-1,"kinds":["ridge"]}',
    '{"kinds":["ridge"]}',
  ])(
    "reads a garbage version %s as nothing disabled and writable",
    (raw) => {
      expect(parseCatalog(raw, false)).toEqual({ state: NOTHING_OFF, writable: true });
    },
  );

  it("reads a failed key as nothing disabled and not writable, whatever the value", () => {
    expect(parseCatalog(stored(["ridge"]), true)).toEqual({ state: NOTHING_OFF, writable: false });
  });

  it("drops non-string members and duplicates and keeps the valid ids in stored order", () => {
    expect(parseCatalog(stored(["ink", 3, null, "ink", "train", {}], ["cozy", false]), false)).toEqual({
      state: { kinds: ["ink", "train"], groups: ["cozy"] },
      writable: true,
    });
  });

  it("reads a missing array as empty", () => {
    expect(parseCatalog('{"v":1,"groups":["cozy"]}', false).state).toEqual({ kinds: [], groups: ["cozy"] });
  });
});

describe("serializeCatalog", () => {
  it("writes the empty catalog in compact form", () => {
    expect(serializeCatalog(NOTHING_OFF)).toBe('{"v":1,"kinds":[],"groups":[]}');
  });

  it("round-trips in stored order without duplicates", () => {
    const raw = serializeCatalog({ kinds: ["train", "ink", "train"], groups: ["cozy"] });
    expect(raw).toBe('{"v":1,"kinds":["train","ink"],"groups":["cozy"]}');
    expect(serializeCatalog(parseCatalog(raw, false).state)).toBe(raw);
  });
});

describe("a failed read", () => {
  const failed = buildCatalog(stored(["ridge"], ["cozy"]), true);

  it("offers every kind", () => {
    expect(failed.offeredKinds).toEqual(ALL_KINDS);
  });

  it("refuses both toggles", () => {
    expect(toggleKind(failed, "ink")).toBeNull();
    expect(toggleGroup(failed, "fluid")).toBeNull();
    expect(canTurnOff(failed, "kind", "ink")).toBe(false);
  });

  it("offers every kind and refuses writes for a newer version too", () => {
    const newer = buildCatalog('{"v":2,"kinds":["ridge"],"groups":[]}', false);
    expect(newer.offeredKinds).toEqual(ALL_KINDS);
    expect(toggleKind(newer, "ink")).toBeNull();
    expect(toggleGroup(newer, "cozy")).toBeNull();
  });
});

describe("unknown ids", () => {
  const c = catalog(["retired-kind", "ink"], ["gone-family"]);

  it("are never offered", () => {
    expect(isOffered(c, "retired-kind")).toBe(false);
    expect(c.offeredKinds).not.toContain("retired-kind");
    expect(offeredGroups(c).map((g) => g.id)).not.toContain("gone-family");
  });

  it("are preserved after an unrelated toggle", () => {
    const next = toggleKind(c, "train");
    expect(serializeCatalog(next!)).toBe('{"v":1,"kinds":["retired-kind","ink","train"],"groups":["gone-family"]}');
    const back = toggleGroup(c, "cozy");
    expect(back!.kinds).toContain("retired-kind");
    expect(back!.groups).toEqual(["gone-family", "cozy"]);
  });

  it("cannot be toggled", () => {
    expect(toggleKind(c, "retired-kind")).toBeNull();
    expect(toggleKind(c, "never-seen")).toBeNull();
    expect(toggleGroup(c, "gone-family")).toBeNull();
    expect(toggleKind(c, "off")).toBeNull();
  });
});

describe("families", () => {
  it("an off family offers none of its kinds whatever kinds says", () => {
    const c = catalog(["train"], ["cozy"]);
    for (const id of kindsOf("cozy")) expect(isOffered(c, id)).toBe(false);
    expect(familyState(c, "cozy")).toEqual({ state: "off", offered: 0, total: kindsOf("cozy").length });
  });

  it("an off family does not offer a kind added to it later", () => {
    const entries = [...BUILTIN_ENTRIES, { id: "hearth", group: "cozy" }];
    const c = catalog([], ["cozy"], entries);
    expect(isOffered(c, "hearth")).toBe(false);
    expect(isOffered(catalog([], [], entries), "hearth")).toBe(true);
  });

  it("kinds inside an off family are locked and keep their own states", () => {
    const c = catalog(["train"], ["cozy"]);
    expect(toggleKind(c, "glass")).toBeNull();
    expect(toggleKind(c, "train")).toBeNull();
    const on = after(c, toggleGroup(c, "cozy"));
    expect(isOffered(on, "train")).toBe(false);
    expect(isOffered(on, "glass")).toBe(true);
  });

  it("a family on with some kinds off reads mixed and keeps them off", () => {
    const c = catalog(["train", "lake"]);
    expect(familyState(c, "cozy")).toEqual({ state: "mixed", offered: kindsOf("cozy").length - 2, total: kindsOf("cozy").length });
    expect(familyState(c, "classic").state).toBe("on");
  });

  it("a family on with all kinds off reads mixed with count 0; its kinds stay off and unlocked", () => {
    const c = catalog(kindsOf("dots"));
    expect(familyState(c, "dots")).toEqual({ state: "mixed", offered: 0, total: kindsOf("dots").length });
    expect(toggleKind(c, "halftone")).not.toBeNull();
    const cycled = after(c, toggleGroup(after(c, toggleGroup(c, "dots")), "dots"));
    expect(cycled.state.kinds).toEqual(kindsOf("dots"));
    expect(familyState(cycled, "dots").offered).toBe(0);
  });

  it("a family turned off and on restores exactly its kinds' earlier states", () => {
    const c = catalog(["train", "lake"]);
    const cycled = after(c, toggleGroup(after(c, toggleGroup(c, "cozy")), "cozy"));
    expect(cycled.state).toEqual({ kinds: ["train", "lake"], groups: [] });
    expect(cycled.offeredKinds).toEqual(c.offeredKinds);
  });

  it("a kind id equal to a family id toggles independently in both lists", () => {
    const entries: CatalogEntry[] = [
      { id: "aurora", group: "aurora" },
      { id: "spark", group: "aurora" },
      { id: "ridge", group: "classic" },
    ];
    const c = buildCatalog(undefined, false, entries);
    const kindOff = after(c, toggleKind(c, "aurora"), entries);
    expect(kindOff.state).toEqual({ kinds: ["aurora"], groups: [] });
    expect(familyState(kindOff, "aurora").state).toBe("mixed");
    const groupOff = after(c, toggleGroup(c, "aurora"), entries);
    expect(groupOff.state).toEqual({ kinds: [], groups: ["aurora"] });
    expect(isOffered(groupOff, "aurora")).toBe(false);
    expect(after(kindOff, toggleKind(kindOff, "aurora"), entries).state).toEqual({ kinds: [], groups: [] });
  });

  it("offeredGroups drops a family with no offered kind and keeps registry order", () => {
    const c = catalog(kindsOf("dots"), ["fluid"]);
    expect(offeredGroups(c).map((g) => g.id)).toEqual(["classic", "cozy", "cyber"]);
    expect(offeredGroups(c)[0].kinds).toEqual(kindsOf("classic"));
  });
});

describe("a stored value from before the cyber family", () => {
  const cyber = ["neon-highway", "server-room", "circuit-board", "oscilloscope", "hologram"];
  const older = catalog(["ink"], ["dots"]);

  it("offers the cyber kinds, on and in registry order after the cozy kinds", () => {
    for (const id of cyber) expect(isOffered(older, id)).toBe(true);
    expect(kindsOf("cyber")).toEqual(cyber);
    expect(older.offeredKinds.slice(-cyber.length)).toEqual(cyber);
    expect(offeredGroups(older).map((g) => g.id)).toEqual(["classic", "fluid", "cozy", "cyber"]);
    expect(familyState(older, "cyber")).toEqual({ state: "on", offered: cyber.length, total: cyber.length });
  });

  it("keeps the stored choices when written back", () => {
    expect(serializeCatalog(toggleKind(older, "hologram")!)).toBe('{"v":1,"kinds":["ink","hologram"],"groups":["dots"]}');
  });
});

describe("last-on guard", () => {
  const onlyRidge = catalog(ALL_KINDS.filter((id) => id !== "ridge"));

  it("refuses to turn off the last kind", () => {
    expect(toggleKind(onlyRidge, "ridge")).toBeNull();
    expect(canTurnOff(onlyRidge, "kind", "ridge")).toBe(false);
  });

  it("refuses to turn off the family holding the last kinds", () => {
    expect(toggleGroup(onlyRidge, "classic")).toBeNull();
    const onlyCozy = catalog([], ["classic", "dots", "fluid", "cyber"]);
    expect(toggleGroup(onlyCozy, "cozy")).toBeNull();
    expect(canTurnOff(onlyCozy, "group", "cozy")).toBe(false);
    expect(canTurnOff(onlyCozy, "kind", "train")).toBe(true);
  });

  it("allows turning a kind back on", () => {
    expect(toggleKind(onlyRidge, "ink")).not.toBeNull();
  });

  it("reads a stored value that offers nothing as nothing known turned off, keeping unknown ids", () => {
    const c = catalog([...ALL_KINDS, "retired"], ["gone"]);
    expect(c.offeredKinds).toEqual(ALL_KINDS);
    expect(c.state).toEqual({ kinds: ["retired"], groups: ["gone"] });
  });

  it("writes the rescued state with unknown ids kept and the toggle applied", () => {
    const c = catalog([...ALL_KINDS, "retired"], ["gone", "classic"]);
    expect(serializeCatalog(toggleKind(c, "ink")!)).toBe('{"v":1,"kinds":["retired","ink"],"groups":["gone"]}');
  });
});

describe("fallback", () => {
  it("is Ridge while it is offered", () => {
    expect(ALL_OFFERED.fallback).toBe("ridge");
  });

  it("is the first offered kind when Ridge is off", () => {
    expect(catalog(["ridge"]).fallback).toBe("terrain");
  });

  it("is the first offered kind when Ridge's family is off", () => {
    expect(catalog([], ["classic"]).fallback).toBe("halftone");
  });
});

describe("nextOfferedKind", () => {
  const c = catalog(["terrain"], ["fluid"]);

  it("skips turned-off kinds", () => {
    expect(nextOfferedKind(c, "ridge")).toBe("warp");
    expect(nextOfferedKind(c, "dot-cover")).toBe("glass");
  });

  it("ends at off and wraps", () => {
    expect(nextOfferedKind(c, "hologram")).toBe("off");
    expect(nextOfferedKind(c, "off")).toBe("ridge");
  });

  it("alternates one offered kind with off", () => {
    const one = catalog(ALL_KINDS.filter((id) => id !== "ink"));
    expect(nextOfferedKind(one, "ink")).toBe("off");
    expect(nextOfferedKind(one, "off")).toBe("ink");
  });

  it("starts an unlisted kind at the first offered kind", () => {
    expect(nextOfferedKind(c, "terrain")).toBe("ridge");
    expect(nextOfferedKind(c, "unknown")).toBe("ridge");
  });

  it("walks the whole registry then off with nothing turned off", () => {
    const walked: string[] = [];
    let kind = "off";
    do {
      kind = nextOfferedKind(ALL_OFFERED, kind);
      walked.push(kind);
    } while (kind !== "off");
    expect(walked).toEqual([...ALL_KINDS, "off"]);
  });
});

describe("reachable states", () => {
  // Mulberry32: a small seeded generator, so the walk is the same on every run.
  function seeded(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("always offer a kind and never list an empty family", () => {
    const groups = [...GROUP_ORDER] as string[];
    // Counted on the toggle's own result, so the read-side rescue in buildCatalog cannot mask a bad state.
    const offeredIn = (s: CatalogState) =>
      BUILTIN_ENTRIES.filter((e) => !s.kinds.includes(e.id) && !s.groups.includes(e.group)).length;
    let applied = 0;
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const rand = seeded(seed);
      let c = catalog(["retired"], ["gone"]);
      for (let step = 0; step < 400; step++) {
        const next =
          rand() < 0.75
            ? toggleKind(c, ALL_KINDS[Math.floor(rand() * ALL_KINDS.length)])
            : toggleGroup(c, groups[Math.floor(rand() * groups.length)]);
        if (!next) continue;
        applied++;
        expect(offeredIn(next)).toBeGreaterThan(0);
        expect(next.kinds).toContain("retired");
        expect(next.groups).toContain("gone");
        c = after(c, next);
        expect(isOffered(c, c.fallback)).toBe(true);
        for (const g of offeredGroups(c)) expect(g.kinds.length).toBeGreaterThan(0);
      }
    }
    expect(applied).toBeGreaterThan(0);
  });
});

describe("catalogOf", () => {
  it("returns one reference for equal inputs", () => {
    const raw = stored(["ink"]);
    const a = catalogOf(raw, false);
    expect(catalogOf(`${raw}`, false)).toBe(a);
    expect(catalogOf(raw, true)).not.toBe(a);
    expect(catalogOf(undefined, false)).not.toBe(a);
  });
});
