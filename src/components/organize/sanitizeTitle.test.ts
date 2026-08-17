// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { sanitizeTitle } from "./sanitizeTitle";

describe("sanitizeTitle", () => {
  it("strips a trailing bitrate parenthetical", () => {
    expect(sanitizeTitle("Song (128kbit_AAC)")).toBe("Song");
    expect(sanitizeTitle("Song (152kbit_Opus)")).toBe("Song");
  });

  it("keeps the last group when peeling it would empty the title", () => {
    expect(sanitizeTitle("[guitar⁄study music] (128kbit_AAC)")).toBe("[guitar⁄study music]");
  });

  it("leaves a clean title alone", () => {
    expect(sanitizeTitle("Song")).toBe("Song");
  });

  it("never empties a title that is only a group", () => {
    expect(sanitizeTitle("(only)")).toBe("(only)");
  });

  it("peels repeated trailing groups", () => {
    expect(sanitizeTitle("Song (Live) (128kbit_AAC)")).toBe("Song");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeTitle("  Song (128kbit_AAC)  ")).toBe("Song");
  });
});
