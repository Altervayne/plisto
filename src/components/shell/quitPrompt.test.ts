// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { joinJobSubjects } from "./quitPrompt";

describe("joinJobSubjects", () => {
  it("capitalizes a single subject", () => {
    expect(joinJobSubjects(["a library scan"], "and")).toBe("A library scan");
  });

  it("joins two subjects with the conjunction", () => {
    expect(joinJobSubjects(["a library scan", "an export"], "and")).toBe(
      "A library scan and an export",
    );
  });

  it("serial-joins three or more with commas before the conjunction", () => {
    expect(joinJobSubjects(["a library scan", "an export", "a splice"], "and")).toBe(
      "A library scan, an export and a splice",
    );
  });

  it("uses the passed conjunction, not a hard-coded and", () => {
    expect(joinJobSubjects(["un scan", "une exportation"], "et")).toBe(
      "Un scan et une exportation",
    );
  });

  it("returns empty for no subjects", () => {
    expect(joinJobSubjects([], "and")).toBe("");
  });
});
