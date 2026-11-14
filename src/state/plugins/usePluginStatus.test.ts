// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { PLUGINS_STATUS, startPluginStatusSync } from "./usePluginStatus";
import { PLUGINS_RUNTIME } from "./usePluginsSync";
import { usePluginStatusStore } from "./pluginStatus";
import { status } from "./fixtures";

// -- Type Imports --
import type { PluginStatus } from "../../types";

const { pluginStatuses, listen } = vi.hoisted(() => ({ pluginStatuses: vi.fn(), listen: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ pluginStatuses }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const state = () => usePluginStatusStore.getState();

let onStatus: (event: { payload: PluginStatus }) => void;
let onRuntime: (event: { payload: { runtime: string } }) => void;
let stop: (() => void) | null;

beforeEach(() => {
  vi.useFakeTimers();
  pluginStatuses.mockReset();
  listen.mockReset().mockImplementation(async (name: string, cb: unknown) => {
    if (name === PLUGINS_STATUS) onStatus = cb as typeof onStatus;
    else if (name === PLUGINS_RUNTIME) onRuntime = cb as typeof onRuntime;
    return () => {};
  });
  usePluginStatusStore.setState({ statuses: {} });
  stop = null;
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe("plugin status sync", () => {
  it("reads every status at start", async () => {
    pluginStatuses.mockResolvedValue([status({ id: "a", rev: 2 })]);
    stop = startPluginStatusSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().statuses.a.rev).toBe(2);
  });

  it("retries a rejected read and never reads the error as empty", async () => {
    state().apply(status({ id: "a", rev: 1 }));
    pluginStatuses.mockRejectedValueOnce(new Error("not ready")).mockResolvedValue([status({ id: "a", rev: 3 })]);
    stop = startPluginStatusSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().statuses.a.rev).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(state().statuses.a.rev).toBe(3);
  });

  it("keeps what it held when every retry fails", async () => {
    state().apply(status({ id: "a", rev: 1 }));
    pluginStatuses.mockRejectedValue(new Error("down"));
    stop = startPluginStatusSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state().statuses.a.rev).toBe(1);
  });

  it("applies a status event, dropping a stale one", async () => {
    pluginStatuses.mockResolvedValue([]);
    stop = startPluginStatusSync();
    await vi.advanceTimersByTimeAsync(0);
    onStatus({ payload: status({ id: "a", rev: 4, host: "running" }) });
    onStatus({ payload: status({ id: "a", rev: 3, host: "stopped" }) });
    expect(state().statuses.a.host).toBe("running");
  });

  it("reads again on a runtime change and clears once the runtime is not running", async () => {
    pluginStatuses.mockResolvedValue([]);
    stop = startPluginStatusSync();
    await vi.advanceTimersByTimeAsync(0);
    state().apply(status({ id: "a", rev: 1 }));
    pluginStatuses.mockClear().mockResolvedValue([]);
    onRuntime({ payload: { runtime: "safe" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(state().statuses).toEqual({});
    expect(pluginStatuses).toHaveBeenCalledTimes(1);
  });
});
