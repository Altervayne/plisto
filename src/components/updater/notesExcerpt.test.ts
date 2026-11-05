// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { notesExcerpt } from "./notesExcerpt";

describe("notesExcerpt", () => {
  it("drops blank lines and keeps the breaks", () => {
    expect(notesExcerpt("What's fixed\r\n\r\n- One\r\n- Two\r\n")).toBe("What's fixed\n- One\n- Two");
  });

  it("stops adding lines past the budget but always keeps the first", () => {
    const long = "x".repeat(300);
    expect(notesExcerpt(`${long}\nmore`)).toBe(long);
    expect(notesExcerpt(`short\n${long}`)).toBe("short");
  });

  it("reads empty notes as empty", () => {
    expect(notesExcerpt("  \n ")).toBe("");
  });
});
