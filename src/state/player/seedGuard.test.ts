// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createSeedGuard } from "./seedGuard";

describe("createSeedGuard", () => {
  it("accepts a seed reply when no event arrived meanwhile", () => {
    const guard = createSeedGuard();
    const fresh = guard.begin();
    expect(fresh()).toBe(true);
  });

  it("rejects a seed reply once an event landed after the request", () => {
    const guard = createSeedGuard();
    const fresh = guard.begin();
    guard.event();
    expect(fresh()).toBe(false);
  });

  it("accepts a later seed after an earlier event", () => {
    const guard = createSeedGuard();
    guard.event();
    const fresh = guard.begin();
    expect(fresh()).toBe(true);
  });
});
