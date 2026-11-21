// -- Test Imports --
import { afterEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  BUILTIN_ENTRIES,
  buildCatalog,
  canTurnOff,
  catalogOf,
  familyOrder,
  nextOfferedKind,
  serializeCatalog,
  toggleGroup,
  toggleKind,
  type CatalogEntry,
} from "./visualizerCatalog";
import { applyPluginRows } from "./pluginVisualizers";
import { GROUP_ORDER, groupLabel } from "./visualizerRegistry";
import { visualizerDecl as decl, visualizerRow as visRow } from "../plugins/fixtures";

const BUILTIN_IDS = BUILTIN_ENTRIES.map((e) => e.id);
const stored = (kinds: string[], groups: string[] = []) => serializeCatalog({ kinds, groups });

const installTwo = () =>
  applyPluginRows([
    visRow("com.zeta.vis", "Zeta", [decl({ id: "z1" }), decl({ id: "z2" })]),
    visRow("com.alpha.vis", "Alpha", [decl({ id: "a1" })]),
  ]);

afterEach(() => applyPluginRows([]));

describe("catalogOf with plugin kinds", () => {
  it("offers only built-ins while no plugin kind is installed", () => {
    expect(catalogOf(undefined, false).entries).toBe(BUILTIN_ENTRIES);
  });

  it("adds installed plugin kinds after the built-ins, families by plugin name", () => {
    installTwo();
    const c = catalogOf(undefined, false);
    expect(c.offeredKinds).toEqual([...BUILTIN_IDS, "com.alpha.vis/a1", "com.zeta.vis/z1", "com.zeta.vis/z2"]);
    expect(c.offeredFamilies.map((f) => f.id)).toEqual([...GROUP_ORDER, "plugin:com.alpha.vis", "plugin:com.zeta.vis"]);
  });

  it("returns one reference until the plugin table changes", () => {
    const raw = stored(["ink"]);
    const a = catalogOf(raw, false);
    expect(catalogOf(raw, false)).toBe(a);
    installTwo();
    const b = catalogOf(raw, false);
    expect(b).not.toBe(a);
    expect(catalogOf(raw, false)).toBe(b);
  });

  it("reads a kind stored under a former id as the current id, written only by the next toggle", () => {
    applyPluginRows([visRow("com.zeta.vis", "Zeta", [decl({ id: "z1", aliases: ["old"] })])]);
    const raw = stored(["com.zeta.vis/old", "com.zeta.vis/z1"]);
    const c = catalogOf(raw, false);
    expect(c.state.kinds).toEqual(["com.zeta.vis/z1"]);
    expect(c.offeredKinds).not.toContain("com.zeta.vis/z1");
    expect(canTurnOff(c, "kind", "com.zeta.vis/z1")).toBe(false);
    expect(serializeCatalog(toggleKind(c, "ink")!)).toBe(stored(["com.zeta.vis/z1", "ink"]));
  });

  it("walks plugin kinds in the V cycle after the built-ins and before Off", () => {
    installTwo();
    const c = catalogOf(undefined, false);
    expect(nextOfferedKind(c, "event-horizon")).toBe("com.alpha.vis/a1");
    expect(nextOfferedKind(c, "com.zeta.vis/z2")).toBe("off");
  });
});

describe("the last-on guard", () => {
  const plugin: CatalogEntry = { id: "com.example.vis/glow", group: "plugin:com.example.vis" };
  const entries = [...BUILTIN_ENTRIES, plugin];
  const allBut = (keep: string) => BUILTIN_IDS.filter((id) => id !== keep);

  it("refuses to turn off the last built-in while a plugin kind is still offered", () => {
    const c = buildCatalog(stored(allBut("warp")), false, entries);
    expect(c.offeredKinds).toEqual(["warp", plugin.id]);
    expect(toggleKind(c, "warp")).toBeNull();
    expect(toggleGroup(c, "classic")).toBeNull();
  });

  it("never locks a plugin kind or family on", () => {
    const c = buildCatalog(stored(allBut("warp")), false, entries);
    expect(canTurnOff(c, "kind", plugin.id)).toBe(true);
    expect(canTurnOff(c, "group", plugin.group)).toBe(true);
  });

  it("turns the built-ins back on for a stored value that offers only plugin kinds, keeping plugin ids", () => {
    const c = buildCatalog(stored([...BUILTIN_IDS, "com.gone.vis/x"], ["plugin:com.gone.vis"]), false, entries);
    expect(c.state).toEqual({ kinds: ["com.gone.vis/x"], groups: ["plugin:com.gone.vis"] });
    expect(c.offeredKinds).toEqual([...BUILTIN_IDS, plugin.id]);
  });

  it("falls back to a built-in, never a plugin kind", () => {
    const c = buildCatalog(stored(["ridge"]), false, [plugin, ...BUILTIN_ENTRIES]);
    expect(c.offeredKinds[0]).toBe(plugin.id);
    expect(c.fallback).toBe("terrain");
  });
});

describe("familyOrder", () => {
  it("puts plugin families after the built-ins, sorted by plugin name, then by id when not installed", () => {
    installTwo();
    const entries: CatalogEntry[] = [
      { id: "com.zeta.vis/z1", group: "plugin:com.zeta.vis" },
      { id: "com.mid.vis/m", group: "plugin:com.mid.vis" },
      { id: "glass", group: "cozy" },
      { id: "com.alpha.vis/a1", group: "plugin:com.alpha.vis" },
      { id: "ridge", group: "classic" },
    ];
    expect(familyOrder(entries)).toEqual([
      "classic",
      "cozy",
      "plugin:com.alpha.vis",
      "plugin:com.mid.vis",
      "plugin:com.zeta.vis",
    ]);
  });

  it("labels an installed plugin family with its plugin's name", () => {
    installTwo();
    const t = ((get: (d: unknown) => string) => get({ player: { visualizerGroupCozy: "Cozy" } })) as never;
    expect(groupLabel("plugin:com.alpha.vis", t)).toBe("Alpha");
    expect(groupLabel("plugin:com.gone.vis", t)).toBe("plugin:com.gone.vis");
    expect(groupLabel("cozy", t)).toBe("Cozy");
  });

  it("keeps a non-plugin family the registry does not name after the registry's own", () => {
    const entries: CatalogEntry[] = [
      { id: "com.a.vis/k", group: "plugin:com.a.vis" },
      { id: "hearth", group: "hearth" },
      { id: "ridge", group: "classic" },
    ];
    expect(familyOrder(entries)).toEqual(["classic", "hearth", "plugin:com.a.vis"]);
  });
});
