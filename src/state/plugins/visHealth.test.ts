// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { useVisHealthStore } from "./visHealth";

const state = () => useVisHealthStore.getState();

beforeEach(() => {
  useVisHealthStore.setState({ health: {} });
});

describe("mount", () => {
  it("starts each mount at loading, independent of the plugin's other mounts", () => {
    state().mount("k1", "plug-a");
    state().mount("k2", "plug-a");
    state().setPhase("k1", "live");
    expect(state().health).toEqual({
      k1: { pluginId: "plug-a", phase: "live" },
      k2: { pluginId: "plug-a", phase: "loading" },
    });
    state().mount("k1", "plug-a");
    expect(state().health.k1).toEqual({ pluginId: "plug-a", phase: "loading" });
  });
});

describe("setPhase", () => {
  it("keeps the state for an unknown key or an unchanged phase", () => {
    state().mount("k1", "plug-a");
    const before = useVisHealthStore.getState();
    state().setPhase("k1", "loading");
    state().setPhase("missing", "live");
    expect(useVisHealthStore.getState()).toBe(before);
  });
});

describe("crash", () => {
  it("records the reason once and ignores an unknown key", () => {
    state().mount("k1", "plug-a");
    state().crash("k1", "navigated");
    expect(state().health.k1).toEqual({ pluginId: "plug-a", phase: "crashed", reason: "navigated" });
    const before = useVisHealthStore.getState();
    state().crash("k1", "navigated");
    state().crash("missing", "silent");
    expect(useVisHealthStore.getState()).toBe(before);
  });
});

describe("unmount", () => {
  it("forgets the mount, crash included, and keeps the state for an unknown key", () => {
    state().mount("k1", "plug-a");
    state().crash("k1", "silent");
    state().unmount("k1");
    expect(state().health).toEqual({});
    const before = useVisHealthStore.getState();
    state().unmount("k1");
    expect(useVisHealthStore.getState()).toBe(before);
  });
});
