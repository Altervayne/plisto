// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { CATALOG, cardState, runAllOrder, runDisabled } from "./catalog";
import { collectProbes } from "./registry";

function entry(id: string) {
  const found = CATALOG.find((e) => e.id === id);
  if (!found) throw new Error(`no catalog entry ${id}`);
  return found;
}

describe("catalog", () => {
  it("has unique ids, and a reason on every probe that runs nothing", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) expect(e.kind === "X").toBe(!!e.outOfV0);
  });

  it("lists P7a and P7b last and holds back P7c, P13, P14b and P14c", () => {
    expect(CATALOG.slice(-2).map((e) => e.id)).toEqual(["P7a", "P7b"]);
    expect(CATALOG.filter((e) => e.outOfV0).map((e) => e.id).sort()).toEqual(["P13", "P14b", "P14c", "P7c"]);
  });

  it("orders Run all with P1 and P2 first and without P7b, P9 or any held-back probe", () => {
    const order = runAllOrder(CATALOG);
    expect(order.slice(0, 2)).toEqual(["P1", "P2"]);
    expect(order).toContain("P7a");
    expect(order).toContain("P14a");
    for (const id of ["P7b", "P9", "P13", "P14b", "P14c", "P7c"]) expect(order).not.toContain(id);
  });

  it("disables Run for a held-back probe, a missing module, a busy page and an unticked warning", () => {
    expect(runDisabled(entry("P13"), true, false, false, false)).toBe(true);
    expect(runDisabled(entry("P1"), false, false, false, false)).toBe(true);
    expect(runDisabled(entry("P1"), true, false, false, true)).toBe(true);
    expect(runDisabled(entry("P1"), true, false, false, false)).toBe(false);
    expect(runDisabled(entry("P7b"), true, true, false, false)).toBe(true);
    expect(runDisabled(entry("P7b"), true, true, true, false)).toBe(false);
  });

  it("needs the tick for a manual probe whose module supplies no warning", () => {
    expect(entry("P7b").warning).toBeTruthy();
    expect(runDisabled(entry("P7b"), true, false, false, false)).toBe(true);
    expect(runDisabled(entry("P7b"), true, false, true, false)).toBe(false);
  });

  it("shows not built for a probe with no module and not in V0 for a held-back one", () => {
    expect(cardState(entry("P1"), false, undefined)).toBe("not built");
    expect(cardState(entry("P1"), true, undefined)).toBe("not run");
    expect(cardState(entry("P13"), true, undefined)).toBe("not in V0");
  });
});

describe("collectProbes", () => {
  it("keeps modules that export a probe and ignores the rest", () => {
    const run = async () => ({ state: "pass" as const, lines: [] });
    const found = collectProbes({
      "./probes/p01.ts": { probe: { id: "P1", run } },
      "./probes/p02.ts": { helper: 1 },
      "./probes/p03.ts": { probe: { id: "P1", run } },
    });
    expect([...found.keys()]).toEqual(["P1"]);
  });
});
