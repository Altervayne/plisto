import { describe, expect, it } from "vitest";
import { ambientEscape } from "./ambientEscape";

describe("ambientEscape", () => {
  it("closes the sheet while one is open", () => {
    expect(ambientEscape(true)).toBe("sheet");
  });

  it("exits ambient when no sheet is open", () => {
    expect(ambientEscape(false)).toBe("exit");
  });
});
