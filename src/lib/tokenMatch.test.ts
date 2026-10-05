// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { matchesTokens, searchTokens } from "./tokenMatch";

describe("searchTokens", () => {
  it("folds and splits on whitespace", () => {
    expect(searchTokens("  Sigur   R\u00d3S ")).toEqual(["sigur", "ros"]);
    expect(searchTokens("   ")).toEqual([]);
  });
});

describe("matchesTokens", () => {
  it("needs every token in some field, in any order", () => {
    const fields = ["wall", "pink floyd"];
    expect(matchesTokens(fields, ["pink", "wall"])).toBe(true);
    expect(matchesTokens(fields, ["wall", "pink"])).toBe(true);
    expect(matchesTokens(fields, ["wall", "zeppelin"])).toBe(false);
  });

  it("matches anything with no tokens", () => {
    expect(matchesTokens([], [])).toBe(true);
  });
});
