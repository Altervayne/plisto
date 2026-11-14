// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { en } from "../../../i18n/en";
import { fr } from "../../../i18n/fr";

const KEYS = [
  "title",
  "starting",
  "startingLine",
  "notRespondingTitle",
  "notRespondingLine",
  "wait",
  "disable",
  "crashTitle",
  "crashLine",
  "restart",
  "showDetails",
  "hideDetails",
  "reasonSilent",
  "reasonNavigated",
  "reasonInit",
  "unavailable",
  "statusStarting",
  "statusNotResponding",
  "statusStopped",
  "version",
  "restartingLine",
  "takeoverLine",
  "failedTitle",
] as const;

const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("plugin frame strings", () => {
  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("has every key in %s", (_name, dict) => {
    const frame = dict.plugins.frame as Record<string, string>;
    for (const key of KEYS) {
      expect(frame[key], key).toBeTruthy();
    }
    expect(Object.keys(frame).sort()).toEqual([...KEYS].sort());
  });

  it("fills the same slots in both locales", () => {
    const enFrame = en.plugins.frame as Record<string, string>;
    const frFrame = fr.plugins.frame as Record<string, string>;
    for (const key of KEYS) {
      expect(slots(frFrame[key]), key).toEqual(slots(enFrame[key]));
    }
  });
});
