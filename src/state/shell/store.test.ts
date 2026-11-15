// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { openPluginHub, openSettings, takeSettingsTarget } from "./store";

beforeEach(() => {
  takeSettingsTarget();
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
