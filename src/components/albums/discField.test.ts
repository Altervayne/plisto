// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { formatDisc, parseDisc } from "./discField";

describe("parseDisc", () => {
  it("reads a plain disc", () => {
    expect(parseDisc("2")).toBe(2);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDisc("  3 ")).toBe(3);
  });

  it("clears a blank entry to null", () => {
    expect(parseDisc("")).toBeNull();
    expect(parseDisc("   ")).toBeNull();
  });

  it("clears a non-numeric entry to null", () => {
    expect(parseDisc("abc")).toBeNull();
    expect(parseDisc("1x")).toBeNull();
    expect(parseDisc("-1")).toBeNull();
  });

  it("rejects a disc below one", () => {
    expect(parseDisc("0")).toBeNull();
  });
});

describe("formatDisc", () => {
  it("renders a set disc", () => {
    expect(formatDisc(2)).toBe("2");
  });

  it("renders an unset disc as an empty string", () => {
    expect(formatDisc(null)).toBe("");
  });
});
