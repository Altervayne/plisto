// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Framework Imports --
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PluginSidebarZone } from "./PluginSidebarZone";
import { pluginZoneModel } from "../../shell/navVisibility";
import { manifest, row } from "../../../state/plugins/fixtures";

// -- Type Imports --
import type { PluginItemState, PluginRow } from "../../../types";

const NAV = { id: "go", type: "nav", label: "Go", route: null, icon: null } as const;
const section = (id: string, over: Partial<PluginRow> = {}): PluginRow =>
  row({
    id,
    manifest: manifest({ name: id, sidebar: { layout: "section", items: [NAV] } }),
    ...over,
  });
const compact = (id: string, over: Partial<PluginRow> = {}): PluginRow =>
  row({ id, manifest: manifest({ name: id }), ...over });

// Two drawn plugins and two the zone model leaves out; the live state is set for all four.
const rows = [
  compact("alpha"),
  compact("bravo", { enabled: false }),
  section("charlie"),
  section("delta", { enabled: false }),
];

vi.mock("./usePluginZone", () => ({ usePluginZone: () => pluginZoneModel(rows, "both") }));
vi.mock("../../../state/shell/store", () => ({ usePluginRoute: () => null }));
vi.mock("../../../state/plugins/sidebarState", () => {
  const nav = (id: string): PluginItemState => ({
    type: "nav",
    visible: true,
    label: null,
    chip: { text: `${id}-item`, count: null, tone: "neutral" },
  });
  return {
    usePluginChips: (id: string) => [{ text: `${id}-chip`, count: null, tone: "neutral" }],
    useItemState: (id: string) => nav(id),
    useItemPending: () => false,
    useSidebarState: { getState: () => ({}) },
  };
});

describe("plugin chips in the rail", () => {
  const html = renderToStaticMarkup(createElement(PluginSidebarZone, { mode: "home", onOpenPlugin: () => {} }));

  it("draws the chips of a compact plugin in the zone", () => {
    expect(html).toContain("alpha-chip");
  });

  it("draws the item chip of a section plugin in the zone", () => {
    expect(html).toContain("charlie-item");
  });

  it("draws nothing for plugins the zone model leaves out", () => {
    expect(html).not.toContain("bravo");
    expect(html).not.toContain("delta");
  });

  it("puts no plugin-level chips on a section heading", () => {
    expect(html).not.toContain("charlie-chip");
  });
});
