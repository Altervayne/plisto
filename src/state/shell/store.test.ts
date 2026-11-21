// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { usePluginsStore } from "../plugins/store";
import { manifest, row } from "../plugins/fixtures";
import { openPluginHub, openSettings, settingsSection, takeSettingsTarget } from "./store";
import { hubSettingId } from "../../components/settings/settingsRegistry";
import { sectionForTarget } from "../../components/settings/settingsTarget";

beforeEach(() => {
  takeSettingsTarget();
});

// Runs first, before any test moves the section: a fresh start shows the first section.
describe("settings section on a fresh start", () => {
  it("is Folders", () => {
    expect(settingsSection()).toBe("folders");
  });
});

describe("settings target", () => {
  it("holds a target until it is taken, then clears it", () => {
    openSettings({ target: "theme" });
    expect(takeSettingsTarget()).toBe("theme");
    expect(takeSettingsTarget()).toBeNull();
  });

  it("a plain open leaves no target and drops a waiting one", () => {
    openSettings({ target: "theme" });
    openSettings();
    expect(takeSettingsTarget()).toBeNull();
  });

  it("a second open with a new target replaces the first", () => {
    openSettings({ target: "theme" });
    openSettings({ target: "language" });
    expect(takeSettingsTarget()).toBe("language");
  });

  it("re-pins: asking again for the same target after it was taken lands again", () => {
    openSettings({ target: "theme" });
    expect(takeSettingsTarget()).toBe("theme");
    openSettings({ target: "theme" });
    expect(takeSettingsTarget()).toBe("theme");
  });

  it("accepts a section id", () => {
    openSettings({ target: "sound" });
    expect(takeSettingsTarget()).toBe("sound");
  });

  it("opening a plugin hub row targets its hub setting", () => {
    openPluginHub("tandem");
    expect(takeSettingsTarget()).toBe("hub-tandem");
  });
});

describe("opening a plugin hub by listing", () => {
  const vis = row({ id: "glow", manifest: manifest({ entry: null, listing: "catalog" }) });
  const page = row({ id: "lyrics" });

  it("sends a catalog-listed plugin to its Visualizers family", () => {
    usePluginsStore.setState({ rows: [vis, page] });
    openPluginHub("glow");
    expect(settingsSection()).toBe("visualizers");
    expect(takeSettingsTarget()).toBe("family-glow");
  });

  it("sends a Plugins-listed or unknown plugin to its hub row", () => {
    usePluginsStore.setState({ rows: [vis, page] });
    openPluginHub("lyrics");
    expect(settingsSection()).toBe("plugins");
    expect(takeSettingsTarget()).toBe("hub-lyrics");
    openPluginHub("ghost");
    expect(takeSettingsTarget()).toBe("hub-ghost");
    usePluginsStore.setState({ rows: [] });
  });
});

describe("settings section", () => {
  it("a target selects its section: a row, a section and a hub row", () => {
    openSettings({ target: "theme" });
    expect(settingsSection()).toBe("appearance");
    openSettings({ target: "updates" });
    expect(settingsSection()).toBe("updates");
    openSettings({ target: hubSettingId("tandem") });
    expect(settingsSection()).toBe("plugins");
  });

  it("a plain open keeps the section last shown", () => {
    openSettings({ target: "sound" });
    openSettings();
    expect(settingsSection()).toBe("sound");
  });

  it("opening a plugin hub shows Plugins", () => {
    openSettings({ target: "theme" });
    openPluginHub("tandem");
    expect(settingsSection()).toBe("plugins");
  });

  it("maps targets to sections", () => {
    expect(sectionForTarget("defaultApp")).toBe("system");
    expect(sectionForTarget("hub-x")).toBe("plugins");
    expect(sectionForTarget("genres")).toBe("genres");
  });
});

describe("settings section for an unknown target", () => {
  it("leaves the shown section alone", () => {
    openSettings({ target: "theme" });
    // A stale id that is neither a row, a section nor a hub row.
    openSettings({ target: "removedSetting" as never });
    expect(settingsSection()).toBe("appearance");
    expect(sectionForTarget("removedSetting")).toBeNull();
  });
});
