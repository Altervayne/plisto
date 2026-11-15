// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { PLUGINS_CHANGED, PLUGINS_RUNTIME, startPluginsSync } from "./usePluginsSync";
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
  granted_origins: [],
  installed_at: 1,
  manifest_hash: "h",
  state: "ready",
  source_path: null,
  sidebar_collapsed: false,
  problem: null,
  manifest: null,
});
const BOOT: PluginBootState = { runtime: "running", unclean: false, safe_flag: false };
const state = () => usePluginsStore.getState();

/** The callbacks the sync registered for the change and runtime events. */
let fire: () => void;
let fireRuntime: (event: { payload: PluginBootState }) => void;
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
  listen.mockReset().mockImplementation(async (name: string, cb: unknown) => {
    if (name === PLUGINS_CHANGED) fire = cb as () => void;
    else if (name === PLUGINS_RUNTIME) fireRuntime = cb as typeof fireRuntime;
    else throw new Error(`unexpected event ${name}`);
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
  it("takes the runtime gate from its event", async () => {
    pluginsList.mockResolvedValue([]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    fireRuntime({ payload: { runtime: "safe", unclean: false, safe_flag: false } });
    expect(state().boot?.runtime).toBe("safe");
  });

  it("keeps a runtime event that landed before the boot read", async () => {
    let resolveBoot: (boot: PluginBootState) => void = () => {};
    pluginsBootState.mockReset().mockReturnValue(new Promise((r) => (resolveBoot = r)));
    pluginsList.mockResolvedValue([]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    fireRuntime({ payload: BOOT });
    resolveBoot({ runtime: "held", unclean: true, safe_flag: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(state().boot?.runtime).toBe("running");
  });

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
    expect(unlisten).toHaveBeenCalledTimes(2);
    release([row("late")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows).toEqual([]);
  });

  it("retries a rejected listen", async () => {
    pluginsList.mockResolvedValue([]);
    listen.mockReset().mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(unlisten);
    start();
    await vi.advanceTimersByTimeAsync(400);
    expect(listen).toHaveBeenCalledTimes(3);
  });

  it("removes a listener that resolves after teardown", async () => {
    pluginsList.mockResolvedValue([]);
    let resolve: (fn: () => void) => void = () => {};
    listen.mockReset().mockImplementation(() => new Promise<() => void>((r) => (resolve = r)));
    start();
    stop?.();
    stop = null;
    resolve(unlisten as unknown as () => void);
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalled();
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

describe("a listing that began before a local change", () => {
  /** A listing the test settles by hand. */
  const held = () => {
    let settle!: (rows: PluginRow[]) => void;
    const promise = new Promise<PluginRow[]>((resolve) => (settle = resolve));
    return { promise, settle };
  };

  it("does not undo an upsert: it is discarded and read once more", async () => {
    pluginsList.mockResolvedValueOnce([row("a")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    const slow = held();
    pluginsList.mockReturnValueOnce(slow.promise).mockResolvedValue([row("a", true)]);
    fire();
    await vi.advanceTimersByTimeAsync(0);
    state().upsertRow(row("a", true));
    slow.settle([row("a", false)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pluginsList).toHaveBeenCalledTimes(3);
    expect(state().rows).toEqual([row("a", true)]);
  });

  it("does not bring a removed row back", async () => {
    pluginsList.mockResolvedValueOnce([row("a"), row("b")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    const slow = held();
    pluginsList.mockReturnValueOnce(slow.promise).mockResolvedValue([row("b")]);
    fire();
    await vi.advanceTimersByTimeAsync(0);
    state().removeRow("a");
    slow.settle([row("a"), row("b")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("applies the second read even if the store changed again meanwhile", async () => {
    pluginsList.mockResolvedValueOnce([row("a")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    const first = held();
    const second = held();
    pluginsList.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    fire();
    await vi.advanceTimersByTimeAsync(0);
    state().upsertRow(row("a", true));
    first.settle([row("a")]);
    await vi.advanceTimersByTimeAsync(0);
    state().upsertRow(row("a", false));
    second.settle([row("a", true)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().rows).toEqual([row("a", true)]);
    expect(pluginsList).toHaveBeenCalledTimes(3);
  });

  it("reports whether a reload read the list", async () => {
    const { reloadPlugins } = await import("./usePluginsSync");
    pluginsList.mockResolvedValueOnce([row("a")]);
    start();
    await vi.advanceTimersByTimeAsync(0);
    pluginsList.mockResolvedValue([row("a")]);
    const ok = reloadPlugins();
    await vi.advanceTimersByTimeAsync(0);
    expect(await ok).toBe(true);
    pluginsList.mockRejectedValue(new Error("gone"));
    const bad = reloadPlugins();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await bad).toBe(false);
  });
});
