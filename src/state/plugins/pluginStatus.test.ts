// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { startingEdges, usePluginStatusStore } from "./pluginStatus";
import { status } from "./fixtures";

const state = () => usePluginStatusStore.getState();

beforeEach(() => usePluginStatusStore.setState({ statuses: {} }));

describe("plugin status store", () => {
  it("takes a newer status", () => {
    state().apply(status({ rev: 1, host: "starting" }));
    state().apply(status({ rev: 2, host: "running" }));
    expect(state().statuses.lyrics.host).toBe("running");
  });

  it("drops an event whose rev is not newer", () => {
    state().apply(status({ rev: 5, host: "running" }));
    state().apply(status({ rev: 4, host: "starting" }));
    state().apply(status({ rev: 5, host: "stopped" }));
    expect(state().statuses.lyrics.host).toBe("running");
  });

  it("applies a listing by the same rule, per plugin", () => {
    state().apply(status({ id: "a", rev: 3, host: "running" }));
    state().applyAll([status({ id: "a", rev: 2, host: "off" }), status({ id: "b", rev: 1, host: "starting" })]);
    expect(state().statuses.a.host).toBe("running");
    expect(state().statuses.b.host).toBe("starting");
  });

  it("keeps the same map when nothing was newer", () => {
    state().apply(status({ rev: 2 }));
    const before = state().statuses;
    state().apply(status({ rev: 1 }));
    expect(state().statuses).toBe(before);
  });
});

describe("startingEdges", () => {
  const map = (...list: ReturnType<typeof status>[]) => Object.fromEntries(list.map((s) => [s.id, s]));

  it("lists only ids that turned to starting", () => {
    const prev = map(status({ id: "a", host: "restarting", retry_in_ms: 1 }), status({ id: "b", host: "starting" }));
    const next = map(status({ id: "a", host: "starting" }), status({ id: "b", host: "starting" }));
    expect(startingEdges(prev, next)).toEqual(["a"]);
  });

  it("counts a first sighting of starting as an edge", () => {
    expect(startingEdges({}, map(status({ id: "a", host: "starting" })))).toEqual(["a"]);
  });
});
