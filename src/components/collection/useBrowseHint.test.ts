// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { hintShows } from "./useBrowseHint";

describe("hintShows", () => {
  it("shows on Albums on a first run", () => {
    expect(hintShows(true, false, "albums")).toBe(true);
  });

  it("waits for the prefs to load", () => {
    expect(hintShows(false, false, "albums")).toBe(false);
  });

  it("is retired for good", () => {
    expect(hintShows(true, true, "albums")).toBe(false);
  });

  it("shows on every segment but Browse", () => {
    expect(hintShows(true, false, "singles")).toBe(true);
    expect(hintShows(true, false, "tracks")).toBe(true);
    expect(hintShows(true, false, "browse")).toBe(false);
  });
});
