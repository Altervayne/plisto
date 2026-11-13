// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { plistoSheetOpen } from "./keyScope";

/** A stand-in element with the given attributes. */
const el = (attrs: Record<string, string>) => ({
  getAttribute: (name: string) => attrs[name] ?? null,
  hasAttribute: (name: string) => name in attrs,
});

/** A stand-in document holding the elements; it answers the one selector the check uses. */
const root = (...els: ReturnType<typeof el>[]) => ({
  querySelectorAll: (selector: string) => {
    expect(selector).toBe("[aria-modal]");
    return els.filter((e) => e.hasAttribute("aria-modal"));
  },
});

describe("plistoSheetOpen", () => {
  it("sees a Plisto sheet", () => {
    expect(plistoSheetOpen(root(el({ "aria-modal": "true" })))).toBe(true);
  });

  it("ignores a plugin prompt and a non-modal overlay", () => {
    expect(plistoSheetOpen(root(el({ "aria-modal": "true", "data-plugin-prompt": "" })))).toBe(false);
    expect(plistoSheetOpen(root(el({ "aria-modal": "false" })))).toBe(false);
    expect(plistoSheetOpen(root(el({ role: "dialog" })))).toBe(false);
  });

  it("sees a sheet open under a plugin prompt", () => {
    const prompt = el({ "aria-modal": "true", "data-plugin-prompt": "" });
    expect(plistoSheetOpen(root(prompt, el({ "aria-modal": "true" })))).toBe(true);
  });
});
