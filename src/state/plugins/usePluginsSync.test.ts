// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { PLUGINS_CHANGED, startPluginsSync } from "./usePluginsSync";
import { enabledOf, usePluginsStore } from "./store";

// -- Type Imports --
import type { PluginBootState, PluginRow } from "../../types";

const { pluginsList, pluginsBootState, listen } = vi.hoisted(() => ({
  pluginsList: vi.fn(),
  pluginsBootState: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ pluginsList, pluginsBootState }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const row = (id: string, enabled = false): PluginRow => ({
  id,
  version: "1.0.0",
  tier: "ui",
  enabled,
  granted: [],
  installed_at: 1,
  manifest_hash: "h",
  state: "ready",
  source_path: null,
  sidebar_layout: null,
  sidebar_collapsed: false,
  problem: null,
});
const BOOT: PluginBootState = { safe_mode: false, unclean: false };
const state = () => usePluginsStore.getState();

/** The callback the sync registered for the change event. */
let fire: () => void;
let unlisten: ReturnType<typeof vi.fn>;
let stop: (() => void) | null;

const start = () => {
  stop = startPluginsSync();
};

beforeEach(() => {
  vi.useFakeTimers();
  pluginsList.mockReset();
  pluginsBootState.mockReset().mockResolvedValue(BOOT);
  unlisten = vi.fn();
  listen.mockReset().mockImplementation(async (name: string, cb: () => void) => {
    expect(name).toBe(PLUGINS_CHANGED);
    fire = cb;
    return unlisten;
  });
  usePluginsStore.setState({ rows: [], boot: null, status: "idle" });
  stop = null;
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe("plugins sync", () => {
  it("loads the rows and the boot state on start", async () => {
    pluginsList.mockResolvedValue([row("a")]);
    start();
    expect(state().status).toBe("loading");
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows).toEqual([row("a")]);
    expect(state().boot).toEqual(BOOT);
    expect(state().status).toBe("ready");
  });

  it("retries a rejected boot read, then succeeds", async () => {
    pluginsList.mockRejectedValueOnce(new Error("not ready")).mockResolvedValue([row("a")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().status).toBe("loading");
    expect(state().rows).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(state().rows).toEqual([row("a")]);
    expect(state().status).toBe("ready");
  });

  it("keeps the earlier rows and fails when a reload keeps rejecting", async () => {
    pluginsList.mockResolvedValueOnce([row("a")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    pluginsList.mockRejectedValue(new Error("gone"));
    fire();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state().status).toBe("failed");
    expect(state().rows).toEqual([row("a")]);
  });

  it("reloads the list on the change event without rereading the boot state", async () => {
    pluginsList.mockResolvedValueOnce([row("a")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    pluginsList.mockResolvedValue([row("a"), row("b")]);
    fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(pluginsBootState).toHaveBeenCalledTimes(1);
  });

  it("lets the latest of two overlapping reloads win", async () => {
    pluginsList.mockResolvedValueOnce([]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    let releaseSlow!: (rows: PluginRow[]) => void;
    pluginsList.mockImplementationOnce(() => new Promise((r) => (releaseSlow = r)));
    pluginsList.mockResolvedValueOnce([row("new")]);
    fire();
    fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows).toEqual([row("new")]);
    releaseSlow([row("stale")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows).toEqual([row("new")]);
  });

  it("drops a response that lands after stop and removes the listener", async () => {
    let release!: (rows: PluginRow[]) => void;
    pluginsList.mockImplementation(() => new Promise((r) => (release = r)));
    start();
    await vi.advanceTimersByTimeAsync(0);
    stop?.();
    stop = null;
    expect(unlisten).toHaveBeenCalledTimes(1);
    release([row("late")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows).toEqual([]);
  });
});

describe("plugins store", () => {
  it("keeps row and array references across an unchanged reload", () => {
    state().applyRows([row("a"), row("b", true)]);
    const before = state().rows;
    state().applyRows([row("a"), row("b", true)]);
    expect(state().rows).toBe(before);
  });

  it("keeps the references of untouched rows when another changes", () => {
    state().applyRows([row("a"), row("b")]);
    const [a] = state().rows;
    state().applyRows([row("a"), row("b", true)]);
    expect(state().rows[0]).toBe(a);
    expect(state().rows[1].enabled).toBe(true);
  });

  it("keeps the boot state reference when it is unchanged", () => {
    state().applyBoot({ ...BOOT });
    const before = state().boot;
    state().applyBoot({ ...BOOT });
    expect(state().boot).toBe(before);
  });
});

describe("enabled rows", () => {
  it("returns the same array until the rows change", () => {
    state().applyRows([row("a"), row("b", true)]);
    const first = enabledOf(state().rows);
    expect(first.map((r) => r.id)).toEqual(["b"]);
    state().setStatus("ready");
    state().applyRows([row("a"), row("b", true)]);
    expect(enabledOf(state().rows)).toBe(first);
    state().applyRows([row("a", true), row("b", true)]);
    expect(enabledOf(state().rows)).not.toBe(first);
  });
});
