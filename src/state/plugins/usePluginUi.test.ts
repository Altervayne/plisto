// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { EVENT_SIDEBAR, EVENT_UI, createUiSync } from "./usePluginUi";
import { withRetry } from "../../lib/withRetry";

// -- Type Imports --
import type { UiSyncDeps } from "./usePluginUi";
import type { PluginSidebarEvent, PluginSidebarSnapshot, PluginUiEvent } from "../../types";

const toast = (requestId: string, id = "a"): PluginUiEvent => ({
  request_id: requestId,
  id,
  kind: "toast",
  payload: { text: "t", action: null },
});
const close = (requestId: string): PluginUiEvent => ({ request_id: requestId, id: "a", kind: "close", payload: {} });
const item = (id: string, text: string): PluginSidebarEvent => ({
  id,
  kind: "item",
  item_id: "s",
  state: { type: "status", visible: true, tone: "neutral", text },
});
const snapshot = (id: string): PluginSidebarSnapshot => ({ id, chips: [], items: [] });

/** A read the test settles by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let stop: (() => void) | null = null;

function setup(overrides: Partial<UiSyncDeps> = {}) {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  const log: unknown[][] = [];
  const deps: UiSyncDeps = {
    listen: vi.fn(async (name, handler) => {
      handlers.set(name, handler);
      return unlisten;
    }),
    readPending: vi.fn(async () => []),
    readSidebar: vi.fn(async () => []),
    retry: (read) => withRetry(read, 3),
    keyOf: (id) => (id === "a" || id === "b" ? `${id}|1|h` : null),
    pushToast: (event) => log.push(["toast", event.request_id]),
    pushPrompt: (event) => log.push(["prompt", event.request_id]),
    close: (requestId) => log.push(["close", requestId]),
    openPage: (id, route) => log.push(["open", id, route]),
    applySnapshot: (snaps, keys) => log.push(["snapshot", snaps.map((s) => s.id), [...keys.entries()]]),
    applyEvent: (event, key) => log.push(["item", event.id, key, event.kind === "item" ? event.state : null]),
    ...overrides,
  };
  stop = createUiSync(deps);
  const fire = (name: string, payload: unknown) => handlers.get(name)?.({ payload });
  return { deps, log, fire, unlisten };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe("boot read", () => {
  it("listens before it reads", async () => {
    const order: string[] = [];
    setup({
      listen: async (name) => {
        order.push(`listen ${name}`);
        return () => {};
      },
      readPending: async () => {
        order.push("pending");
        return [];
      },
      readSidebar: async () => {
        order.push("sidebar");
        return [];
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([`listen ${EVENT_UI}`, `listen ${EVENT_SIDEBAR}`, "pending", "sidebar"]);
  });

  it("buffers events that arrive during the read and replays them after it", async () => {
    const pending = held<PluginUiEvent[]>();
    const sidebar = held<PluginSidebarSnapshot[]>();
    const { log, fire } = setup({ readPending: () => pending.promise, readSidebar: () => sidebar.promise });
    await vi.advanceTimersByTimeAsync(0);

    fire(EVENT_SIDEBAR, item("a", "newer"));
    fire(EVENT_UI, close("r1"));
    fire(EVENT_UI, toast("r2"));
    expect(log).toEqual([]);

    pending.resolve([toast("r1")]);
    await vi.advanceTimersByTimeAsync(0);
    sidebar.resolve([snapshot("a"), snapshot("x")]);
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual([
      ["toast", "r1"],
      ["snapshot", ["a", "x"], [["a", "a|1|h"]]],
      ["item", "a", "a|1|h", { type: "status", visible: true, tone: "neutral", text: "newer" }],
      ["close", "r1"],
      ["toast", "r2"],
    ]);

    // After the replay, events go straight through.
    fire(EVENT_UI, toast("r3"));
    expect(log[log.length - 1]).toEqual(["toast", "r3"]);
  });

  it("retries a failed read and applies the later answer", async () => {
    const readSidebar = vi
      .fn<() => Promise<PluginSidebarSnapshot[]>>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue([snapshot("a")]);
    const { log } = setup({ readSidebar });
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(readSidebar).toHaveBeenCalledTimes(2);
    expect(log).toEqual([["snapshot", ["a"], [["a", "a|1|h"]]]]);
  });

  it("never treats a read that keeps failing as empty, and still replays what arrived", async () => {
    const readSidebar = vi.fn(() => Promise.reject(new Error("gone")));
    const readPending = vi.fn(() => Promise.reject(new Error("gone")));
    const { log, fire } = setup({ readSidebar, readPending });
    await vi.advanceTimersByTimeAsync(0);
    fire(EVENT_SIDEBAR, item("a", "live"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(readSidebar).toHaveBeenCalledTimes(3);
    expect(readPending).toHaveBeenCalledTimes(3);
    expect(log.some(([kind]) => kind === "snapshot")).toBe(false);
    expect(log).toEqual([["item", "a", "a|1|h", { type: "status", visible: true, tone: "neutral", text: "live" }]]);
  });
});

describe("routing", () => {
  it("sends each kind to its surface and ignores sidebar events of unknown plugins", async () => {
    const { log, fire } = setup();
    await vi.advanceTimersByTimeAsync(0);
    fire(EVENT_UI, toast("r1"));
    fire(EVENT_UI, {
      request_id: "r2",
      id: "a",
      kind: "confirm",
      payload: { title: "T", body: "B", confirm_label: "OK", cancel_label: null },
    });
    fire(EVENT_UI, close("r1"));
    fire(EVENT_UI, { request_id: "r3", id: "b", kind: "open_page", payload: { route: "settings" } });
    fire(EVENT_SIDEBAR, item("stranger", "x"));
    fire(EVENT_SIDEBAR, item("b", "y"));
    expect(log).toEqual([
      ["snapshot", [], []],
      ["toast", "r1"],
      ["prompt", "r2"],
      ["close", "r1"],
      ["open", "b", "settings"],
      ["item", "b", "b|1|h", { type: "status", visible: true, tone: "neutral", text: "y" }],
    ]);
  });

  it("stops listening on teardown and ignores what lands after", async () => {
    const pending = held<PluginUiEvent[]>();
    const { log, unlisten } = setup({ readPending: () => pending.promise });
    await vi.advanceTimersByTimeAsync(0);
    stop?.();
    stop = null;
    expect(unlisten).toHaveBeenCalledTimes(2);
    pending.resolve([toast("late")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([["snapshot", [], []]]);
  });

  it("retries a rejected listen", async () => {
    const listen = vi
      .fn<UiSyncDeps["listen"]>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue(() => {});
    setup({ listen });
    await vi.advanceTimersByTimeAsync(400);
    expect(listen).toHaveBeenCalledTimes(3);
  });

  it("removes a listener that resolves after teardown", async () => {
    const off = vi.fn();
    let resolve: (fn: () => void) => void = () => {};
    setup({ listen: () => new Promise<() => void>((r) => (resolve = r)) });
    stop?.();
    stop = null;
    resolve(off);
    await vi.advanceTimersByTimeAsync(0);
    expect(off).toHaveBeenCalledTimes(1);
  });
});
