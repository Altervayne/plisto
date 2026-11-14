// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { entryKey, pluginEntries } from "./finderIndex";
import { parseRecents, pushRecent, resolveRecents } from "./finderRecents";
import { searchFinder } from "./finderMatch";
import { pluginZoneModel } from "../shell/navVisibility";
import { manifest, row } from "../../state/plugins/fixtures";

// -- Type Imports --
import type { FinderEntry, PluginEntryText } from "./finderIndex";
import type { PluginRow, PluginSidebarItem } from "../../types";

const text: PluginEntryText = { sublabel: "Plugin", item: (plugin, item) => `${plugin}: ${item}` };

const nav = (id: string, route: string | null): PluginSidebarItem => ({
  id,
  type: "nav",
  label: id[0].toUpperCase() + id.slice(1),
  route,
  icon: null,
});

function plugin(id: string, over: Partial<PluginRow>, items: PluginSidebarItem[], layout: "compact" | "section") {
  return row({
    id,
    manifest: manifest({ name: id[0].toUpperCase() + id.slice(1), sidebar: { layout, items } }),
    ...over,
  });
}

const entriesFor = (rows: PluginRow[]) => pluginEntries(pluginZoneModel(rows, "both"), text, "passed");

describe("pluginEntries and the sandbox outcome", () => {
  it("tags a UI plugin only when the probe is not passed", () => {
    const zone = pluginZoneModel([plugin("lyrics", {}, [nav("home", "/")], "compact")], "both");
    expect(pluginEntries(zone, text, "passed")[0].tag).toBeNull();
    expect(pluginEntries(zone, text, "not_passed")[0].tag).toBe("unsandboxed");
  });
});

describe("pluginEntries", () => {
  it("gives a compact plugin one row that opens its page", () => {
    const [entry] = entriesFor([plugin("lyrics", {}, [nav("home", "/")], "compact")]);
    expect(entry).toMatchObject({
      kind: "plugin",
      id: "lyrics",
      pluginId: "lyrics",
      route: null,
      label: "Lyrics",
      sublabel: "Plugin",
      tag: null,
    });
    expect(entryKey(entry.kind, entry.id)).toBe("plugin:lyrics");
  });

  it("gives a section plugin one row per nav item, named plugin: item", () => {
    const items: PluginSidebarItem[] = [
      nav("outputs", "/outputs"),
      { id: "state", type: "status", label: "State", route: null, icon: null },
      nav("sync", null),
    ];
    const entries = entriesFor([plugin("tandem", { tier: "native" }, items, "section")]);
    expect(entries.map((e) => e.label)).toEqual(["Tandem: Outputs", "Tandem: Sync"]);
    expect(entries.map((e) => entryKey(e.kind, e.id))).toEqual(["plugin:tandem:outputs", "plugin:tandem:sync"]);
    expect(entries.map((e) => e.route)).toEqual(["/outputs", null]);
    expect(entries.every((e) => e.tag === "native" && e.pluginId === "tandem")).toBe(true);
  });

  it("keeps a section with no nav item reachable through one plugin row", () => {
    const items: PluginSidebarItem[] = [{ id: "state", type: "status", label: "State", route: null, icon: null }];
    const entries = entriesFor([plugin("quiet", {}, items, "section")]);
    expect(entries.map((e) => e.label)).toEqual(["Quiet"]);
  });

  it("has no row for a plugin the rail does not draw", () => {
    const rows = [
      plugin("off", { enabled: false }, [nav("a", null)], "section"),
      plugin("consent", { state: "needs_consent" }, [nav("a", null)], "compact"),
      plugin("on", {}, [nav("a", null)], "compact"),
    ];
    expect(entriesFor(rows).map((e) => e.id)).toEqual(["on"]);
  });

  it("lists sections before the shared group, as the rail does", () => {
    const rows = [
      plugin("small", {}, [nav("a", null)], "compact"),
      plugin("big", {}, [nav("a", null)], "section"),
    ];
    expect(entriesFor(rows).map((e) => e.id)).toEqual(["big:a", "small"]);
  });

  it("matches by plugin name or item name and files the row under Go to", () => {
    const entries = entriesFor([plugin("tandem", {}, [nav("outputs", null)], "section")]);
    for (const query of ["tandem", "outputs", "tan out"]) {
      const { groups } = searchFinder([entries], query, new Map());
      expect(groups.map((g) => g.key)).toEqual(["destinations"]);
      expect(groups[0].hits[0].entry.id).toBe("tandem:outputs");
    }
    expect(searchFinder([entries], "zzz", new Map()).groups).toEqual([]);
  });
});

describe("plugin recents", () => {
  const rows = [
    plugin("big", {}, [nav("a", null), nav("b", null)], "section"),
    plugin("small", {}, [nav("a", null)], "compact"),
  ];
  const lookupOf = (entries: FinderEntry[]) => {
    const byKey = new Map(entries.map((e) => [entryKey(e.kind, e.id), e] as const));
    return (key: string) => byKey.get(key);
  };

  it("stores a plugin row under plugin:<id> or plugin:<id>:<item>", () => {
    const entries = entriesFor(rows);
    const lookup = lookupOf(entries);
    const refs = pushRecent(pushRecent([], entries[0], lookup), entries[2], lookup);
    expect(refs.map((r) => entryKey(r.kind, r.id))).toEqual(["plugin:small", "plugin:big:a"]);
    expect(parseRecents(JSON.stringify(refs))).toEqual(refs);
  });

  it("skips a recent whose plugin no longer qualifies", () => {
    const refs = [
      { kind: "plugin" as const, id: "big:a" },
      { kind: "plugin" as const, id: "small" },
    ];
    const disabled = rows.map((r) => (r.id === "small" ? { ...r, enabled: false } : r));
    const live = resolveRecents(refs, lookupOf(entriesFor(disabled)));
    expect(live.map((e) => e.id)).toEqual(["big:a"]);
  });
});
