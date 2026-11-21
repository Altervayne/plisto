// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  dropsScope,
  namesGroup,
  scopedGroups,
  sectionEntries,
  settingEntries,
  withGroupWord,
} from "./finderSettingsEntries";
import { scopedView, settingsShowAll } from "./finderScopedView";
import { openSetting } from "./useFinderActions";
import { entryKey } from "./finderIndex";
import { GROUP_CAP, searchFinder } from "./finderMatch";
import { parseRecents, pushRecent, resolveRecents } from "./finderRecents";
import { hubSettingId, visibleSettings } from "../settings/settingsRegistry";
import { SETTINGS_SECTIONS } from "../settings/settingsSections";

// -- i18n Imports --
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { FinderEntry, SettingFinderEntry } from "./finderIndex";
import type { HubSource } from "./finderSettingsEntries";

const NO_PLAYS = new Map<number, number>();
const HUBS: HubSource[] = [{ id: "tandem", name: "Tandem", listing: "plugins", tag: "native" }];

function build(dict: Dict, windows: boolean, hubs: HubSource[] = HUBS): SettingFinderEntry[] {
  const group = dict.settings.nav;
  return settingEntries(dict, { windows }, hubs, {
    group,
    path: (section) => `${group} > ${section}`,
  });
}

const settingRows = (entries: SettingFinderEntry[]) => entries.filter((e) => e.variant === "setting");
const idsOf = (entries: readonly FinderEntry[]) => entries.map((e) => e.id);

describe("settingEntries", () => {
  it("has one row per visible registry setting, per section and per hub", () => {
    for (const windows of [true, false]) {
      const entries = build(en, windows);
      expect(settingRows(entries).map((e) => e.id)).toEqual(
        visibleSettings({ windows }).map((e) => e.id),
      );
      expect(entries.filter((e) => e.variant === "section")).toHaveLength(SETTINGS_SECTIONS.length);
      expect(entries.filter((e) => e.variant === "hub").map((e) => e.id)).toEqual([hubSettingId("tandem")]);
    }
  });

  it("files a catalog-listed plugin under Visualizers, not Plugins", () => {
    const hubs: HubSource[] = [...HUBS, { id: "glow", name: "Glow", listing: "catalog", tag: null }];
    const hubRows = build(en, true, hubs).filter((e) => e.variant === "hub");
    expect(hubRows.map((e) => [e.id, e.section, e.pluginId])).toEqual([
      ["family-glow", "visualizers", "glow"],
      [hubSettingId("tandem"), "plugins", "tandem"],
    ]);
  });

  it("never offers the tag-write setting while the feature is off", () => {
    expect(idsOf(build(en, true))).not.toContain("stampFiles");
  });

  it("leaves out a setting the registry hides in this app state", () => {
    expect(idsOf(build(en, false))).not.toContain("defaultApp");
    expect(idsOf(build(en, true))).toContain("defaultApp");
  });

  it("finds every registered setting by its own label in both languages", () => {
    for (const dict of [en, fr]) {
      const entries = build(dict, true);
      for (const setting of visibleSettings({ windows: true })) {
        const found = scopedGroups(entries, setting.label(dict)).flatMap((g) => g.items.map((i) => i.id));
        expect(found, `${dict.settings.nav}: ${setting.id}`).toContain(setting.id);
      }
    }
  });
});

describe("scoped matching", () => {
  it("finds Theme from the English synonym 'dark' and names it", () => {
    const [group] = scopedGroups(build(en, true), "dark");
    expect(group.section).toBe("appearance");
    expect(group.items.map((i) => [i.id, i.sublabel])).toEqual([["theme", "dark mode"]]);
  });

  it("finds Theme from the French synonym 'sombre', accents folded", () => {
    const entries = build(fr, true);
    expect(scopedGroups(entries, "sombre")[0].items[0]).toMatchObject({
      id: "theme",
      sublabel: "mode sombre",
    });
    expect(scopedGroups(entries, "couleur")[0].items.map((i) => i.id)).toContain("theme");
  });

  it("shows no sublabel when the label itself matched", () => {
    expect(scopedGroups(build(en, true), "theme")[0].items[0].sublabel).toBeUndefined();
  });

  it("groups hits by section in page order and finds a hub row by its plugin name", () => {
    const groups = scopedGroups(build(en, true), "tandem");
    expect(groups.map((g) => g.section)).toEqual(["plugins"]);
    expect(groups[0].items[0]).toMatchObject({ variant: "hub", pluginId: "tandem" });
  });

  it("misses cleanly on text no setting carries", () => {
    expect(scopedGroups(build(en, true), "wallpaper")).toEqual([]);
  });

  it("lists the eight sections, with no sublabel, before anything is typed", () => {
    const sections = sectionEntries(build(en, true));
    expect(sections.map((s) => s.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(sections.every((s) => s.sublabel === undefined)).toBe(true);
  });

  it("removes the scope on Backspace only from an empty field", () => {
    expect(dropsScope("settings", "")).toBe(true);
    expect(dropsScope("settings", "d")).toBe(false);
    expect(dropsScope(null, "")).toBe(false);
    expect(dropsScope("settings", "", true)).toBe(false);
  });
});

describe("global matching", () => {
  it("puts Settings last, capped, and finds Theme through 'dark'", () => {
    const entries = build(en, true);
    const found = searchFinder([entries], "dark", NO_PLAYS);
    expect(found.groups.map((g) => g.key)).toEqual(["settings"]);
    expect(found.groups[0].hits[0].entry.id).toBe("theme");
  });

  it("lists every setting only when the query names the group word", () => {
    const group = "settings";
    expect(namesGroup("settings", group)).toBe(true);
    expect(namesGroup("sett", group)).toBe(true);
    for (const noise of ["set", "ing", "tin", "par", ""]) expect(namesGroup(noise, group)).toBe(false);
    expect(namesGroup("param", "parametres")).toBe(true);
    expect(namesGroup("ram", "parametres")).toBe(false);
    const rows = build(en, true);
    const named = searchFinder([withGroupWord(rows, group)], "settings", NO_PLAYS);
    expect(named.groups[0].hits).toHaveLength(GROUP_CAP.settings);
    expect(settingsShowAll(withGroupWord(rows, group), "settings", GROUP_CAP.settings)).toMatchObject({
      type: "showAll",
      target: "settings",
      count: rows.filter((e) => e.variant !== "section").length,
    });
  });

  it("does not list every setting for a short substring of the group word", () => {
    const rows = build(en, true);
    const found = searchFinder([rows], "set", NO_PLAYS).groups.flatMap((g) => g.hits.map((h) => h.entry.id));
    expect(found).not.toContain("closeBehavior");
    expect(found.length).toBeLessThan(rows.length);
  });

  it("does not match the other language's synonym", () => {
    expect(scopedGroups(build(en, true), "sombre")).toEqual([]);
    expect(scopedGroups(build(fr, true), "dark")).toEqual([]);
  });

  it("leaves a hidden setting out of a global search", () => {
    const found = searchFinder([build(en, false)], "default", NO_PLAYS).groups.flatMap((g) =>
      g.hits.map((h) => h.entry.id),
    );
    expect(found).not.toContain("defaultApp");
  });

  it("keeps a library group ahead of the Settings group", () => {
    const track: FinderEntry = { kind: "track", id: 1, label: "Theme song", fields: ["theme song"], trackIds: [1] };
    const keys = searchFinder([[track], build(en, true)], "theme", NO_PLAYS).groups.map((g) => g.key);
    expect(keys).toEqual(["tracks", "settings"]);
  });
});

describe("recents", () => {
  it("drops a stored setting that is hidden or gone, and keeps the rest", () => {
    const live = build(en, false);
    const byKey = new Map(live.map((e) => [entryKey(e.kind, e.id), e] as const));
    const lookup = (key: string) => byKey.get(key);
    const refs = parseRecents(
      JSON.stringify([
        { kind: "setting", id: "defaultApp" },
        { kind: "setting", id: "theme" },
        { kind: "setting", id: "hub-removed" },
      ]),
    );
    expect(resolveRecents(refs, lookup).map((e) => e.id)).toEqual(["theme"]);
    const theme = byKey.get(entryKey("setting", "theme"))!;
    expect(pushRecent(refs, theme, lookup)).toEqual([{ kind: "setting", id: "theme" }]);
  });

  it("drops a malformed stored setting ref", () => {
    const raw = JSON.stringify([
      { kind: "setting", id: { nested: true } },
      { kind: "setting" },
      { kind: "setting", id: "theme" },
    ]);
    expect(parseRecents(raw)).toEqual([{ kind: "setting", id: "theme" }]);
  });
});

describe("scoped view", () => {
  it("lists the sections when blank, and offers the scope drop on a miss", () => {
    const rows = build(en, true);
    expect(scopedView(rows, "").sections[0].items).toHaveLength(SETTINGS_SECTIONS.length);
    const miss = scopedView(rows, "wallpaper");
    expect(miss).toMatchObject({ sections: [], noMatch: true, extra: [{ type: "everything" }] });
    expect(scopedView(rows, "dark").extra).toEqual([]);
  });
});

describe("openSetting", () => {
  it("lands a setting on its target and a hub row through the plugin hub", () => {
    const calls: string[] = [];
    const go = {
      openSettings: ({ target }: { target: string }) => calls.push("settings:" + target),
      openPluginHub: (id: string) => calls.push("hub:" + id),
    };
    const rows = build(en, true);
    openSetting(rows.find((e) => e.id === "theme")!, go);
    openSetting(rows.find((e) => e.variant === "hub")!, go);
    openSetting(rows.find((e) => e.variant === "section")!, go);
    expect(calls).toEqual(["settings:theme", "hub:tandem", "settings:folders"]);
  });
});
