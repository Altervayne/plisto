// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

/** Every leaf of a dictionary subtree as `path -> text`. */
function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
  }
  return [];
}

const NEW_GROUPS = [
  ["plugins.status", en.plugins.status, fr.plugins.status],
  ["plugins.safeOffer", en.plugins.safeOffer, fr.plugins.safeOffer],
] as const;

describe("plugin supervision strings", () => {
  it.each(NEW_GROUPS)("%s has every key in both locales, filled, with the same slots", (_name, enGroup, frGroup) => {
    const enLeaves = new Map(leaves(enGroup));
    const frLeaves = new Map(leaves(frGroup));
    expect([...frLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
    for (const [path, text] of enLeaves) {
      const other = frLeaves.get(path) ?? "";
      expect(text.length, path).toBeGreaterThan(0);
      expect(other.length, path).toBeGreaterThan(0);
      expect(other, path).not.toContain("[TO COMPLETE]");
      expect(slots(other), path).toEqual(slots(text));
    }
  });

  it("covers every failure reason in both the hub and the card", () => {
    for (const dict of [en, fr]) {
      expect(Object.keys(dict.plugins.status.failReason).sort()).toEqual(["changed", "invalid", "launch_denied"]);
      expect(Object.keys(dict.plugins.status.failLine).sort()).toEqual(["changed", "invalid", "launch_denied"]);
    }
  });
});
