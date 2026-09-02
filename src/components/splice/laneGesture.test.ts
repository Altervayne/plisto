// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  handleUpSelects,
  laneDownScrubs,
  laneMoveScrubs,
  laneUpDropsMarker,
  liveIdOrNull,
} from "./laneGesture";

describe("laneDownScrubs", () => {
  it("seeks on a Move press and on the cropper's tool-less lane, holds off on a Splice press", () => {
    expect(laneDownScrubs("move")).toBe(true);
    expect(laneDownScrubs(undefined)).toBe(true);
    expect(laneDownScrubs("splice")).toBe(false);
  });
});

describe("laneMoveScrubs", () => {
  it("scrubs on any Move move", () => {
    expect(laneMoveScrubs("move", false)).toBe(true);
    expect(laneMoveScrubs("move", true)).toBe(true);
  });

  it("never scrubs a Splice move - the cut tool leaves the playhead alone, drag or not", () => {
    expect(laneMoveScrubs("splice", false)).toBe(false);
    expect(laneMoveScrubs("splice", true)).toBe(false);
  });

  it("scrubs the tool-less cropper lane", () => {
    expect(laneMoveScrubs(undefined, false)).toBe(true);
  });
});

describe("laneUpDropsMarker", () => {
  it("drops a cut only on a Splice click, never on a drag or a Move release", () => {
    expect(laneUpDropsMarker("splice", false)).toBe(true);
    expect(laneUpDropsMarker("splice", true)).toBe(false);
    expect(laneUpDropsMarker("move", false)).toBe(false);
    expect(laneUpDropsMarker(undefined, false)).toBe(false);
  });
});

describe("handleUpSelects", () => {
  it("selects on a click, not after a drag has moved the marker", () => {
    expect(handleUpSelects(false)).toBe(true);
    expect(handleUpSelects(true)).toBe(false);
  });
});

describe("liveIdOrNull", () => {
  it("keeps an id still in the live set", () => {
    expect(liveIdOrNull("b", ["a", "b", "c"])).toBe("b");
  });

  it("clears an id no longer present", () => {
    expect(liveIdOrNull("x", ["a", "b"])).toBeNull();
  });

  it("passes a null selection through", () => {
    expect(liveIdOrNull(null, ["a"])).toBeNull();
  });
});
