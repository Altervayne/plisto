import { afterEach, describe, expect, it } from "vitest";

import { catalogFamilies } from "./useCatalogRows";
import { applyPluginRows } from "../../../state/player/pluginVisualizers";
import { buildCatalog, catalogOf } from "../../../state/player/visualizerCatalog";
import { manifest, row, status, visualizerDecl, visualizerRow } from "../../../state/plugins/fixtures";
import { GROUP_ORDER } from "../../../state/player/visualizerRegistry";
import type { PluginCatalogInput } from "./useCatalogRows";

const RUNNING = { runtime: "running", unclean: false, safe_flag: false } as const;
const decls = [visualizerDecl({ id: "rings", name: "Rings" }), visualizerDecl({ id: "glow", name: "Glow" })];
const pulse = visualizerRow("com.test.pulse", "Pulse", decls);
const night = visualizerRow("com.test.night", "Night", [visualizerDecl()], { enabled: false });
const setlist = row({
  id: "com.test.setlist",
  manifest: manifest({ name: "Setlist", visualizers: [visualizerDecl({ id: "wall", name: "Wall" })] }),
});
const plain = row({ id: "com.test.plain" });

const input = (rows: PluginCatalogInput["rows"], over: Partial<PluginCatalogInput> = {}): PluginCatalogInput => ({
  rows,
  boot: RUNNING,
  statuses: {},
  ...over,
});

afterEach(() => applyPluginRows([]));

describe("catalogFamilies with plugins", () => {
  it("keeps the built-in families exactly as they are", () => {
    const alone = catalogFamilies(buildCatalog(undefined, false));
    const withPlugins = catalogFamilies(buildCatalog(undefined, false), input([pulse]));
    const shape = (list: typeof alone) => list.map((f) => [f.id, f.rows.map((r) => r.id)]);
    expect(shape(withPlugins.slice(0, alone.length))).toEqual(shape(alone));
    expect(alone.map((f) => f.id)).toEqual([...GROUP_ORDER]);
    expect(alone.every((f) => f.plugin === undefined)).toBe(true);
  });

  it("adds one family per plugin with a family, by plugin name, after the built-ins", () => {
    applyPluginRows([pulse, setlist]);
    const families = catalogFamilies(catalogOf(undefined, false), input([pulse, plain, night, setlist]));
    const plugins = families.filter((f) => f.plugin);
    expect(plugins.map((f) => f.id)).toEqual(["plugin:com.test.night", "plugin:com.test.pulse", "plugin:com.test.setlist"]);
    expect(families.indexOf(plugins[0])).toBe(GROUP_ORDER.length);
  });

  it("draws plugin rows from the descriptor table with no still", () => {
    applyPluginRows([pulse]);
    const family = catalogFamilies(catalogOf(undefined, false), input([pulse])).find((f) => f.plugin)!;
    expect(family.rows.map((r) => [r.id, r.source, r.group])).toEqual([
      ["com.test.pulse/rings", "plugin", "plugin:com.test.pulse"],
      ["com.test.pulse/glow", "plugin", "plugin:com.test.pulse"],
    ]);
    expect(family.rows.every((r) => r.thumb("light") === null && r.thumb("dark") === null)).toBe(true);
    expect(family.plugin?.icon).toEqual({ kind: "installed", id: "com.test.pulse", hash: "hash-1" });
  });

  it("lists the kinds of a plugin that is not in the table from its manifest", () => {
    applyPluginRows([night]);
    const family = catalogFamilies(catalogOf(undefined, false), input([night])).find((f) => f.plugin)!;
    expect(family.rows.map((r) => r.id)).toEqual(["com.test.night/aurora-rings"]);
    expect(family.plugin?.view.status).toBe("off");
  });

  it("carries the family state from the row, the boot view, the status and the stored flags", () => {
    const flagged = buildCatalog(JSON.stringify({ v: 1, kinds: [], groups: ["plugin:com.test.setlist"] }), false);
    const crashed = { "com.test.pulse": status({ id: "com.test.pulse", host: "crash_loop" }) };
    const families = catalogFamilies(flagged, input([pulse, setlist], { statuses: crashed }));
    const byId = Object.fromEntries(families.filter((f) => f.plugin).map((f) => [f.id, f.plugin!]));
    expect(byId["plugin:com.test.pulse"].view.status).toBe("crash");
    expect(byId["plugin:com.test.setlist"]).toMatchObject({ mixed: true, view: { status: "off" } });
  });

  it("keeps a broken plugin's family with no rows", () => {
    const broken = visualizerRow("com.test.broken", "Broken", [], { state: "broken", problem: "missing file" });
    const family = catalogFamilies(buildCatalog(undefined, false), input([broken])).find((f) => f.plugin)!;
    expect(family.rows).toEqual([]);
    expect(family.plugin?.view.status).toBe("broken");
  });
});
