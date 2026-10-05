// -- Test Imports --
import { afterEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { activeViewKeys, registerViewKeys } from "./viewKeys";

// -- Type Imports --
import type { ViewKeys } from "./viewKeys";

const releases: Array<() => void> = [];

function register(keys: ViewKeys) {
  const source: { current: ViewKeys } = { current: keys };
  const release = registerViewKeys(source);
  releases.push(release);
  return { source, release };
}

afterEach(() => {
  releases.splice(0).forEach((release) => release());
});

describe("view keys registry", () => {
  it("holds nothing until a view registers", () => {
    expect(activeViewKeys()).toBeNull();
  });

  it("serves the registered view's keys and clears them on release", () => {
    const selectAll = () => {};
    const { release } = register({ selectAll });
    expect(activeViewKeys()?.selectAll).toBe(selectAll);
    release();
    expect(activeViewKeys()).toBeNull();
  });

  it("reads the live handlers, not the ones held at registration", () => {
    const first = () => {};
    const second = () => {};
    const { source } = register({ focusSearch: first });
    source.current = { focusSearch: second };
    expect(activeViewKeys()?.focusSearch).toBe(second);
  });

  it("serves the latest view and hands back to the one beneath on release", () => {
    const below = () => {};
    const above = () => {};
    register({ selectAll: below });
    const top = register({ selectAll: above });
    expect(activeViewKeys()?.selectAll).toBe(above);
    top.release();
    expect(activeViewKeys()?.selectAll).toBe(below);
  });

  it("releases the right view out of order, and a second release is a no-op", () => {
    const below = () => {};
    const above = () => {};
    const bottom = register({ selectAll: below });
    register({ selectAll: above });
    bottom.release();
    bottom.release();
    expect(activeViewKeys()?.selectAll).toBe(above);
  });
});
