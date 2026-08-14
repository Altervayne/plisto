// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { EXPORT_PRESETS, presetIdFor } from "./templates";

describe("presetIdFor", () => {
  it("names each preset from its own patterns", () => {
    for (const preset of EXPORT_PRESETS) {
      expect(presetIdFor(preset.folder, preset.file)).toBe(preset.id);
    }
  });

  it("reads the empty folder pair as the flat preset", () => {
    expect(presetIdFor("", "{albumartist} - {album} - {track_no} - {title}")).toBe("flat");
  });

  it("falls to null for a pair no preset spells", () => {
    expect(presetIdFor("{genre}/{album}", "{title}")).toBeNull();
    expect(presetIdFor("{albumartist}/{album}", "{title}")).toBeNull();
  });
});
