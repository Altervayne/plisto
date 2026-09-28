// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { sourceForContainer } from "./playbackSource";

describe("sourceForContainer", () => {
  it("tags a single as the Singles view", () => {
    expect(sourceForContainer({ id: 7, kind: "single", title: "Lone" }, "Untitled")).toEqual({
      kind: "singles",
    });
  });

  it("tags an album with its id and title", () => {
    expect(sourceForContainer({ id: 3, kind: "album", title: "Record" }, "Untitled")).toEqual({
      kind: "album",
      id: 3,
      label: "Record",
    });
  });

  it("labels an untitled album with the fallback", () => {
    expect(sourceForContainer({ id: 3, kind: "album", title: null }, "Untitled")).toEqual({
      kind: "album",
      id: 3,
      label: "Untitled",
    });
  });
});
