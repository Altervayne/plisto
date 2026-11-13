// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { parseNotes } from "./parseNotes";

describe("parseNotes", () => {
  it("reads a heading over its bullets, across the blank line between them", () => {
    expect(parseNotes("What's New\n\n- First\n- Second")).toEqual([
      { kind: "heading", text: "What's New" },
      { kind: "list", items: ["First", "Second"] },
    ]);
  });

  it("starts a new heading and list for each section", () => {
    const blocks = parseNotes("New\n\n- A\n\nFixed\n\n- B\n- C");
    expect(blocks).toEqual([
      { kind: "heading", text: "New" },
      { kind: "list", items: ["A"] },
      { kind: "heading", text: "Fixed" },
      { kind: "list", items: ["B", "C"] },
    ]);
  });

  it("reads a non-bullet line with no bullets after it as a paragraph", () => {
    expect(parseNotes("Just a sentence.")).toEqual([{ kind: "paragraph", text: "Just a sentence." }]);
    expect(parseNotes("- A\n\nTrailing words")).toEqual([
      { kind: "list", items: ["A"] },
      { kind: "paragraph", text: "Trailing words" },
    ]);
  });

  it("reads a line before another plain line as a paragraph", () => {
    expect(parseNotes("One\nTwo\n- A")).toEqual([
      { kind: "paragraph", text: "One" },
      { kind: "heading", text: "Two" },
      { kind: "list", items: ["A"] },
    ]);
  });

  it("keeps bullets that open the notes without a heading", () => {
    expect(parseNotes("- A\n- B")).toEqual([{ kind: "list", items: ["A", "B"] }]);
  });

  it("splits a list at a blank line", () => {
    expect(parseNotes("- A\n\n- B")).toEqual([
      { kind: "list", items: ["A"] },
      { kind: "list", items: ["B"] },
    ]);
  });

  it("handles CRLF breaks and stray spaces", () => {
    expect(parseNotes("  Head  \r\n\r\n  - Item  \r\n")).toEqual([
      { kind: "heading", text: "Head" },
      { kind: "list", items: ["Item"] },
    ]);
  });

  it("returns nothing for empty or blank notes", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("  \n\n \r\n")).toEqual([]);
  });

  it("leaves markup as literal text", () => {
    expect(parseNotes("<b>Hi</b>\n\n- **bold** <i>x</i>")).toEqual([
      { kind: "heading", text: "<b>Hi</b>" },
      { kind: "list", items: ["**bold** <i>x</i>"] },
    ]);
  });
});
