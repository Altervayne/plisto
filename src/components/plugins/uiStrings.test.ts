// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

const KEYS = [
  "openSettings",
  "promptFrom",
  "promptNote",
  "promptCancel",
  "itemWaiting",
  "progressLabel",
  "progressBusy",
] as const;

const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("plugin ui strings", () => {
  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("has every key in %s", (_name, dict) => {
    const ui = dict.plugins.ui as Record<string, string>;
    for (const key of KEYS) {
      expect(ui[key], key).toBeTruthy();
    }
    expect(Object.keys(ui).sort()).toEqual([...KEYS].sort());
  });

  it("fills the same slots in both locales", () => {
    const enUi = en.plugins.ui as Record<string, string>;
    const frUi = fr.plugins.ui as Record<string, string>;
    for (const key of KEYS) {
      expect(slots(frUi[key]), key).toEqual(slots(enUi[key]));
    }
  });
});
