// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { startFrameRemount } from "./frameRemount";
import { crashKey } from "./frameModel";
import { useFrameHealthStore } from "./frameHealth";
import { usePluginStatusStore } from "./pluginStatus";
import { usePluginsStore } from "./store";
import { manifest, row, status } from "./fixtures";

// -- Type Imports --
import type { PluginRow } from "../../types";

const ui = (id: string, over: Partial<PluginRow> = {}) =>
  row({ id, granted: [], manifest: manifest({ name: id }), ...over });
const bg = (id: string) => ui(id, { granted: ["background"] });

const generation = (id: string) => useFrameHealthStore.getState().generation[id] ?? 0;

let stop: () => void;

beforeEach(() => {
  usePluginStatusStore.setState({ statuses: {} });
  useFrameHealthStore.setState({ health: {}, crashed: new Set(), generation: {} });
  usePluginsStore.setState({ rows: [] });
  stop = startFrameRemount();
});

afterEach(() => stop());

const crash = (r: PluginRow) => useFrameHealthStore.getState().crash(r.id, crashKey(r), "silent");
const apply = (id: string, host: "starting" | "restarting" | "running" | "stopped", rev: number) =>
  usePluginStatusStore.getState().apply(status({ id, host, rev, ...(host === "restarting" ? { retry_in_ms: 1 } : {}) }));

describe("frame remount on the starting edge", () => {
  it("remounts a crashed background frame when its status reaches starting", () => {
    const a = bg("a");
    usePluginsStore.setState({ rows: [a] });
    crash(a);
    apply("a", "restarting", 1);
    expect(generation("a")).toBe(0);
    apply("a", "starting", 2);
    expect(generation("a")).toBe(1);
    expect(useFrameHealthStore.getState().crashed.size).toBe(0);
  });

  it("does not remount again while the status stays starting", () => {
    const a = bg("a");
    usePluginsStore.setState({ rows: [a] });
    crash(a);
    apply("a", "starting", 1);
    crash(a);
    apply("a", "starting", 2);
    expect(generation("a")).toBe(1);
  });

  it("leaves a crashed page frame for the user's Restart", () => {
    const a = ui("a");
    usePluginsStore.setState({ rows: [a] });
    crash(a);
    apply("a", "starting", 1);
    expect(generation("a")).toBe(0);
    expect(useFrameHealthStore.getState().crashed.size).toBe(1);
  });

  it("leaves a background frame that did not crash, and any other status change", () => {
    const a = bg("a");
    usePluginsStore.setState({ rows: [a] });
    apply("a", "starting", 1);
    crash(a);
    apply("a", "stopped", 2);
    apply("a", "running", 3);
    expect(generation("a")).toBe(0);
  });
});
