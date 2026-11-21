// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { ALL_CAPABILITIES, knownCapabilities, sortCapabilities } from "./capabilities";
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

describe("capability labels", () => {
  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("has a Plisto-owned label for every capability in %s", (_name, dict) => {
    const labels = dict.plugins.capability as Record<string, string>;
    for (const capability of ALL_CAPABILITIES) {
      expect(labels[capability], capability).toBeTruthy();
    }
    expect(Object.keys(labels).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it("spells background as the running-while-open line", () => {
    expect(en.plugins.capability.background).toBe("Runs in the background while Plisto is open");
  });

  it("covers the whole closed set", () => {
    expect(ALL_CAPABILITIES).toHaveLength(17);
  });
});

describe("unknown capability values", () => {
  const mixed = ["network", "future.thing", "storage"] as never[];

  it("are left out of the lists to draw", () => {
    expect(knownCapabilities(mixed)).toEqual(["network", "storage"]);
  });

  it("sort last and are kept", () => {
    expect(sortCapabilities(mixed)).toEqual(["storage", "network", "future.thing"]);
  });
});

describe("sortCapabilities", () => {
  it("orders reads before controls before reach, without touching its input", () => {
    const input = ["network", "ui.toast", "playback.read"] as const;
    const copy = [...input];
    expect(sortCapabilities(copy)).toEqual(["playback.read", "ui.toast", "network"]);
    expect(copy).toEqual([...input]);
  });
});
