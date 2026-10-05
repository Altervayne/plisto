// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { fold, searchFold } from "./fold";

describe("fold", () => {
  it("collapses whitespace, trims, composes and lowercases", () => {
    expect(fold("  The   Wall ")).toBe("the wall");
    expect(fold("Cafe\u0301")).toBe(fold("Caf\u00e9"));
  });

  it("keeps accents apart", () => {
    expect(fold("Caf\u00e9")).not.toBe(fold("Cafe"));
  });
});

describe("searchFold", () => {
  it("drops accents, composed or decomposed", () => {
    expect(searchFold("\u00c9lo\u00efse")).toBe("eloise");
    expect(searchFold("E\u0301lo\u0308ise")).toBe("eloise");
    expect(searchFold("\u00e9")).toBe("e");
  });

  it("still folds case and whitespace", () => {
    expect(searchFold("  Sigur   R\u00f3s ")).toBe("sigur ros");
  });

  it("leaves letters that carry no combining mark", () => {
    expect(searchFold("\u00df\u00f8")).toBe("\u00df\u00f8");
  });
});
