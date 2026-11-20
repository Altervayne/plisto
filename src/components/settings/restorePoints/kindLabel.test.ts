// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { kindLabel } from "./kindLabel";

// -- i18n Imports --
import { createT } from "../../../i18n";

describe("kindLabel for the file write actions", () => {
  it("names the tag write, its undo and the in-place trim", () => {
    const t = createT("en");
    expect(kindLabel(t, { reason: "action", action: "stamp" })).toBe("Before action: Write tags to files");
    expect(kindLabel(t, { reason: "action", action: "stamp_undo" })).toBe("Before action: Undo a tag write");
    expect(kindLabel(t, { reason: "action", action: "trim_replace" })).toBe("Before action: Replace the original");
  });

  it("has a French label for each", () => {
    const t = createT("fr");
    for (const action of ["stamp", "stamp_undo", "trim_replace"] as const) {
      const label = kindLabel(t, { reason: "action", action });
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("TO COMPLETE");
    }
  });

  it("still words an unknown action as a change", () => {
    expect(kindLabel(createT("en"), { reason: "action", action: null })).toBe("Before a change");
  });
});
