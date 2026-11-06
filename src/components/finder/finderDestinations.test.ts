// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { destinationTarget } from "./finderDestinations";

describe("destinationTarget", () => {
  it("lands a segment row on its own segment", () => {
    expect(destinationTarget("albums")).toEqual({ segment: "albums" });
    expect(destinationTarget("singles")).toEqual({ segment: "singles" });
    expect(destinationTarget("tracks")).toEqual({ segment: "tracks" });
  });

  it("leaves the Collection row on the remembered segment", () => {
    expect(destinationTarget("collection")).toBe("collection");
  });

  it("passes every other destination through", () => {
    expect(destinationTarget("home")).toBe("home");
    expect(destinationTarget("unsorted")).toBe("unsorted");
    expect(destinationTarget("settings")).toBe("settings");
  });
});
