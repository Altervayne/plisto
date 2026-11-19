// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { ambientCycleTarget } from "./ambientCycle";

// -- State Imports --
import { catalogOf } from "../../../state/player/visualizerCatalog";

describe("ambientCycleTarget", () => {
  const catalog = catalogOf(undefined, false);

  it("does nothing while the flash notice is unacknowledged", () => {
    expect(ambientCycleTarget(false, catalog, "ridge")).toBeNull();
  });

  it("moves to the next offered kind once acknowledged", () => {
    const next = ambientCycleTarget(true, catalog, "ridge");
    expect(next).not.toBeNull();
    expect(next).not.toBe("ridge");
  });
});
