// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  NAV_SECTIONS,
  activeNavItemId,
  firstVisibleDestination,
  isDestinationVisible,
  isPluginVisible,
  isSectionVisible,
  isZoneEmpty,
  pluginIdOf,
  pluginMode,
  pluginZoneModel,
  zoneHasPlugin,
} from "./navVisibility";
import { manifest, row } from "../../state/plugins/fixtures";

// -- Type Imports --
import type { Mode } from "./navVisibility";
import type { AppMode } from "../../state/player/store";
import type { PluginMode, PluginRow, PluginSidebarItem, PluginSidebarLayout } from "../../types";

const ALL: readonly Mode[] = [
  ...NAV_SECTIONS.files,
  ...NAV_SECTIONS.library,
  ...NAV_SECTIONS.utilities,
  "settings",
];

function visible(appMode: Parameters<typeof isDestinationVisible>[0]): Mode[] {
  return ALL.filter((dest) => isDestinationVisible(appMode, dest));
}

describe("isDestinationVisible", () => {
  it("shows every destination in both mode", () => {
    expect(visible("both")).toEqual(ALL);
  });

  it("hides the files and utility surfaces in player mode", () => {
    for (const dest of ["files", "unsorted", "covers", "editor", "export"] as Mode[]) {
      expect(isDestinationVisible("player", dest)).toBe(false);
    }
    for (const dest of ["collection", "playlists", "player"] as Mode[]) {
      expect(isDestinationVisible("player", dest)).toBe(true);
    }
  });

  it("hides the player and its history in organizer mode, keeping the collection", () => {
    for (const dest of ["player", "history"] as Mode[]) {
      expect(isDestinationVisible("organizer", dest)).toBe(false);
    }
    for (const dest of [
      "files",
      "unsorted",
      "covers",
      "collection",
      "playlists",
      "editor",
      "export",
    ] as Mode[]) {
      expect(isDestinationVisible("organizer", dest)).toBe(true);
    }
  });

  it("keeps settings visible in every mode", () => {
    expect(isDestinationVisible("both", "settings")).toBe(true);
    expect(isDestinationVisible("player", "settings")).toBe(true);
    expect(isDestinationVisible("organizer", "settings")).toBe(true);
  });
});

describe("isSectionVisible", () => {
  it("shows all sections in both mode", () => {
    expect(isSectionVisible("both", NAV_SECTIONS.files)).toBe(true);
    expect(isSectionVisible("both", NAV_SECTIONS.library)).toBe(true);
    expect(isSectionVisible("both", NAV_SECTIONS.utilities)).toBe(true);
  });

  it("drops the files and utilities sections in player mode, keeping library", () => {
    expect(isSectionVisible("player", NAV_SECTIONS.files)).toBe(false);
    expect(isSectionVisible("player", NAV_SECTIONS.utilities)).toBe(false);
    expect(isSectionVisible("player", NAV_SECTIONS.library)).toBe(true);
  });

  it("keeps every section in organizer mode, since each has a surviving item", () => {
    expect(isSectionVisible("organizer", NAV_SECTIONS.files)).toBe(true);
    expect(isSectionVisible("organizer", NAV_SECTIONS.library)).toBe(true);
    expect(isSectionVisible("organizer", NAV_SECTIONS.utilities)).toBe(true);
  });
});

describe("firstVisibleDestination", () => {
  it("lands on files in both mode", () => {
    expect(firstVisibleDestination("both")).toBe("files");
  });

  it("lands on the collection in player mode", () => {
    expect(firstVisibleDestination("player")).toBe("collection");
  });

  it("lands on files in organizer mode", () => {
    expect(firstVisibleDestination("organizer")).toBe("files");
  });
});

// -- Plugin zone --

const item = (
  id: string,
  type: PluginSidebarItem["type"] = "nav",
  route: string | null = null,
): PluginSidebarItem => ({ id, type, label: id, route, icon: null });

/** A ready, enabled plugin; `layout` is the layout its manifest declares. */
function plugin(
  id: string,
  over: {
    layout?: PluginSidebarLayout;
    items?: PluginSidebarItem[];
    row?: Partial<PluginRow>;
    modes?: PluginMode[];
  } = {},
): PluginRow {
  return row({
    id,
    manifest: manifest({
      name: id.toUpperCase(),
      modes: over.modes ?? ["player", "organizer"],
      sidebar: { layout: over.layout ?? "compact", items: over.items ?? [item("home")] },
    }),
    ...over.row,
  });
}

describe("isPluginVisible", () => {
  const cases: [AppMode, PluginMode[], boolean][] = [
    ["both", ["player"], true],
    ["both", ["organizer"], true],
    ["both", ["player", "organizer"], true],
    ["player", ["player"], true],
    ["player", ["organizer"], false],
    ["player", ["player", "organizer"], true],
    ["organizer", ["player"], false],
    ["organizer", ["organizer"], true],
    ["organizer", ["player", "organizer"], true],
  ];
  it.each(cases)("%s with modes %j is %s", (appMode, modes, expected) => {
    expect(isPluginVisible(appMode, modes)).toBe(expected);
  });
});

describe("plugin destinations", () => {
  it("round-trips an id through its destination", () => {
    expect(pluginMode("tandem")).toBe("plugin:tandem");
    expect(pluginIdOf("plugin:tandem")).toBe("tandem");
    expect(pluginIdOf("settings")).toBeNull();
  });
});

describe("pluginZoneModel", () => {
  it("is empty with no plugins", () => {
    expect(isZoneEmpty(pluginZoneModel([], "both"))).toBe(true);
  });

  it("gives a section-layout plugin its own section and the rest the shared group", () => {
    const rows = [
      plugin("big", { layout: "section", items: [item("a"), item("b", "status")] }),
      plugin("small", { layout: "compact" }),
      plugin("bare", { row: { manifest: manifest({ sidebar: null }) } }),
    ];
    const model = pluginZoneModel(rows, "both");
    expect(model.sections.map((s) => s.plugin.id)).toEqual(["big"]);
    expect(model.sections[0].items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(model.compact.map((p) => p.id)).toEqual(["small", "bare"]);
  });

  it("keeps a plugin without a sidebar block or without items in the shared group", () => {
    const rows = [
      plugin("none", { row: { manifest: manifest({ sidebar: null }) } }),
      plugin("empty", { layout: "section", items: [] }),
    ];
    const model = pluginZoneModel(rows, "both");
    expect(model.sections).toEqual([]);
    expect(model.compact.map((p) => p.id)).toEqual(["none", "empty"]);
  });

  it("carries the stored fold state onto the section", () => {
    const rows = [
      plugin("open", { layout: "section" }),
      plugin("folded", { layout: "section", row: { sidebar_collapsed: true } }),
    ];
    expect(pluginZoneModel(rows, "both").sections.map((s) => s.collapsed)).toEqual([false, true]);
  });

  it("orders each list by install time, then by listing order", () => {
    const rows = [
      plugin("c", { layout: "section", row: { installed_at: 30 } }),
      plugin("a", { layout: "section", row: { installed_at: 10 } }),
      plugin("b", { layout: "section", row: { installed_at: 10 } }),
      plugin("z", { row: { installed_at: 5 } }),
      plugin("y", { row: { installed_at: 4 } }),
    ];
    const model = pluginZoneModel(rows, "both");
    expect(model.sections.map((s) => s.plugin.id)).toEqual(["a", "b", "c"]);
    expect(model.compact.map((p) => p.id)).toEqual(["y", "z"]);
  });

  it("draws only ready, enabled plugins with a readable manifest", () => {
    const rows = [
      plugin("on"),
      plugin("off", { row: { enabled: false } }),
      plugin("consent", { row: { state: "needs_consent" } }),
      plugin("broken", { row: { state: "broken" } }),
      plugin("incompatible", { row: { state: "incompatible" } }),
      plugin("unreadable", { row: { manifest: null } }),
    ];
    expect(pluginZoneModel(rows, "both").compact.map((p) => p.id)).toEqual(["on"]);
  });

  it("follows the app mode through the declared modes", () => {
    const rows = [
      plugin("both", { modes: ["player", "organizer"] }),
      plugin("play", { modes: ["player"] }),
      plugin("org", { layout: "section", modes: ["organizer"] }),
    ];
    const ids = (appMode: AppMode) => {
      const model = pluginZoneModel(rows, appMode);
      return [...model.sections.map((s) => s.plugin.id), ...model.compact.map((p) => p.id)];
    };
    expect(ids("both")).toEqual(["org", "both", "play"]);
    expect(ids("player")).toEqual(["both", "play"]);
    expect(ids("organizer")).toEqual(["org", "both"]);
  });

  it("is an empty zone when the mode hides every plugin", () => {
    const rows = [plugin("play", { modes: ["player"] })];
    expect(isZoneEmpty(pluginZoneModel(rows, "organizer"))).toBe(true);
    expect(isZoneEmpty(pluginZoneModel(rows, "player"))).toBe(false);
  });

  it("finds a plugin in either list", () => {
    const model = pluginZoneModel([plugin("big", { layout: "section" }), plugin("small")], "both");
    expect(zoneHasPlugin(model, "big")).toBe(true);
    expect(zoneHasPlugin(model, "small")).toBe(true);
    expect(zoneHasPlugin(model, "gone")).toBe(false);
  });
});

describe("activeNavItemId", () => {
  const items = [
    item("home", "nav", "/"),
    item("plain", "nav", null),
    item("state", "status"),
    item("again", "nav", "/"),
  ];

  it("lights the first nav item with the route", () => {
    expect(activeNavItemId(items, "/")).toBe("home");
    expect(activeNavItemId(items, null)).toBe("plain");
  });

  it("lights nothing for an unknown route or a non-nav item", () => {
    expect(activeNavItemId(items, "/missing")).toBeNull();
    expect(activeNavItemId([item("state", "status")], null)).toBeNull();
  });
});
