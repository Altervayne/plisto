// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { NEUTRAL_ICON, PLUGIN_NAV_ICONS, navIconFor } from "./pluginNavIcons";

// The manifest's allow-list, spelled out so a drift in either list fails here.
const ALLOWED = [
  "activity",
  "album",
  "archive",
  "audio-lines",
  "audio-waveform",
  "bell",
  "bookmark",
  "chart-bar",
  "circle-help",
  "clock",
  "cloud",
  "cog",
  "compass",
  "database",
  "disc-3",
  "download",
  "drum",
  "file-text",
  "folder",
  "gauge",
  "globe",
  "guitar",
  "headphones",
  "heart",
  "house",
  "info",
  "layout-grid",
  "library",
  "list-music",
  "mic",
  "music",
  "music-2",
  "puzzle",
  "radio",
  "sliders-horizontal",
  "sparkles",
  "star",
  "tag",
  "timer",
  "wand-sparkles",
  "zap",
];

describe("PLUGIN_NAV_ICONS", () => {
  it("covers exactly the allowed names", () => {
    expect(ALLOWED).toHaveLength(41);
    expect(Object.keys(PLUGIN_NAV_ICONS).sort()).toEqual([...ALLOWED].sort());
  });

  it("maps every name to its own component", () => {
    const components = new Set(Object.values(PLUGIN_NAV_ICONS));
    expect(components.size).toBe(ALLOWED.length);
    expect(components.has(NEUTRAL_ICON)).toBe(false);
  });
});

describe("navIconFor", () => {
  it("returns the mapped component for a known name", () => {
    expect(navIconFor("music")).toBe(PLUGIN_NAV_ICONS.music);
  });

  it("falls back to the neutral icon for null, an unknown name, and an object key", () => {
    expect(navIconFor(null)).toBe(NEUTRAL_ICON);
    expect(navIconFor("rocket")).toBe(NEUTRAL_ICON);
    expect(navIconFor("constructor")).toBe(NEUTRAL_ICON);
    expect(navIconFor("")).toBe(NEUTRAL_ICON);
  });
});
