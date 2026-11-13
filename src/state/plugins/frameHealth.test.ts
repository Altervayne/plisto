// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { useFrameHealthStore } from "./frameHealth";

const state = () => useFrameHealthStore.getState();

beforeEach(() => {
  useFrameHealthStore.setState({ health: {}, crashed: new Set(), generation: {} });
});

describe("setPhase", () => {
  it("writes a change and keeps the state when nothing changed", () => {
    state().setPhase("a", "loading");
    const before = useFrameHealthStore.getState();
    state().setPhase("a", "loading");
    expect(useFrameHealthStore.getState()).toBe(before);
    state().setPhase("a", "live");
    expect(state().health.a).toEqual({ phase: "live" });
  });
});

describe("crash", () => {
  it("records the phase, the reason and the crash key once", () => {
    state().crash("a", "a|1.0.0|h1", "navigated");
    expect(state().health.a).toEqual({ phase: "crashed", reason: "navigated" });
    expect([...state().crashed]).toEqual(["a|1.0.0|h1"]);
    const before = useFrameHealthStore.getState();
    state().crash("a", "a|1.0.0|h1", "navigated");
    expect(useFrameHealthStore.getState()).toBe(before);
  });
});

describe("release", () => {
  it("drops a settled phase, keeps a crash and ignores an unknown id", () => {
    state().setPhase("a", "not_responding");
    state().crash("b", "b|1.0.0|h1", "init");
    state().release("a");
    expect(state().health.a).toBeUndefined();
    const before = useFrameHealthStore.getState();
    state().release("a");
    state().release("b");
    expect(useFrameHealthStore.getState()).toBe(before);
    expect(state().health.b).toEqual({ phase: "crashed", reason: "init" });
  });
});

describe("restart", () => {
  it("clears the crash and bumps the generation", () => {
    state().crash("a", "a|1.0.0|h1", "silent");
    state().crash("ab", "ab|1.0.0|h2", "silent");
    state().restart("a");
    expect([...state().crashed]).toEqual(["ab|1.0.0|h2"]);
    expect(state().generation).toEqual({ a: 1 });
    expect(state().health.a).toEqual({ phase: "loading" });
    state().restart("a");
    expect(state().generation.a).toBe(2);
  });
});

describe("prune", () => {
  it("drops entries, crash keys and generations of ids no longer live", () => {
    state().setPhase("a", "live");
    state().crash("b", "b|1.0.0|h", "silent");
    state().restart("c");
    state().prune(new Set(["a"]));
    expect(state().health).toEqual({ a: { phase: "live" } });
    expect(state().crashed.size).toBe(0);
    expect(state().generation).toEqual({});
  });

  it("keeps the state when every id is live", () => {
    state().setPhase("a", "live");
    state().crash("b", "b|1.0.0|h", "silent");
    const before = useFrameHealthStore.getState();
    state().prune(new Set(["a", "b"]));
    expect(useFrameHealthStore.getState()).toBe(before);
  });
});
