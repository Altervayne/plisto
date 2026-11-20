// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { en } from "./en";
import { fr } from "./fr";

/** Every leaf string under `node`, keyed by its dotted path. */
function leaves(node: unknown, path = ""): Record<string, string> {
  if (typeof node === "string") return { [path]: node };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    Object.assign(out, leaves(value, path ? `${path}.${key}` : key));
  }
  return out;
}

const tokens = (text: string): string[] => (text.match(/\{\{?\w+\}?\}/g) ?? []).sort();

describe("file write strings", () => {
  const english = leaves(en.fileWrites);
  const french = leaves(fr.fileWrites);

  it("fill the same slots in both languages, leaf by leaf", () => {
    for (const [path, text] of Object.entries(english)) {
      expect(tokens(french[path] ?? ""), path).toEqual(tokens(text));
    }
  });

  it("are not placeholders and carry no non-ASCII character in English", () => {
    for (const [path, text] of Object.entries(english)) {
      expect(text.length, path).toBeGreaterThan(0);
      expect(/^[\x20-\x7e]*$/.test(text), path).toBe(true);
    }
    for (const [path, text] of Object.entries(french)) expect(text, path).not.toContain("TO COMPLETE");
  });
});
