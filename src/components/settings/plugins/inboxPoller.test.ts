import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INBOX_POLL_MS, sameInboxItems, startInboxPoller } from "./inboxPoller";
import type { PluginInboxItem } from "../../../types";

const item = (name: string): PluginInboxItem => ({ name, path: `/in/${name}`, kind: "file" });

function setup(read: () => Promise<PluginInboxItem[]>) {
  let visible = true;
  let wake: () => void = () => {};
  const unsubscribe = vi.fn();
  const onList = vi.fn();
  const onError = vi.fn();
  const stop = startInboxPoller({
    read,
    onList,
    onError,
    env: {
      isVisible: () => visible,
      onWake: (cb) => {
        wake = cb;
        return unsubscribe;
      },
    },
  });
  return {
    stop,
    onList,
    onError,
    unsubscribe,
    wake: () => wake(),
    setVisible: (v: boolean) => {
      visible = v;
    },
  };
}

describe("sameInboxItems", () => {
  it("matches equal lists in order and rejects differences", () => {
    expect(sameInboxItems([item("a"), item("b")], [item("a"), item("b")])).toBe(true);
    expect(sameInboxItems([item("a"), item("b")], [item("b"), item("a")])).toBe(false);
    expect(sameInboxItems([item("a")], [item("a"), item("b")])).toBe(false);
    expect(sameInboxItems([], [])).toBe(true);
    expect(sameInboxItems([item("a")], [{ ...item("a"), kind: "folder" }])).toBe(false);
  });
});

describe("startInboxPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads on start and surfaces a new item on a tick", async () => {
    let list = [item("a")];
    const read = vi.fn(() => Promise.resolve(list));
    const h = setup(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onList).toHaveBeenLastCalledWith([item("a")]);
    list = [item("a"), item("b")];
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    expect(h.onList).toHaveBeenLastCalledWith([item("a"), item("b")]);
    h.stop();
  });

  it("reads on a wake event", async () => {
    const read = vi.fn(() => Promise.resolve([]));
    const h = setup(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    h.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("does not poll while hidden", async () => {
    const read = vi.fn(() => Promise.resolve([]));
    const h = setup(read);
    await vi.advanceTimersByTimeAsync(0);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("never overlaps reads", async () => {
    let resolve: (l: PluginInboxItem[]) => void = () => {};
    const read = vi.fn(() => new Promise<PluginInboxItem[]>((r) => (resolve = r)));
    const h = setup(read);
    h.wake();
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("cleans up on stop and drops a late result", async () => {
    let resolve: (l: PluginInboxItem[]) => void = () => {};
    const read = vi.fn(() => new Promise<PluginInboxItem[]>((r) => (resolve = r)));
    const h = setup(read);
    h.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    resolve([item("a")]);
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
    expect(h.onList).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("logs once per failure streak and re-arms after a success", async () => {
    let fail = true;
    const read = vi.fn(() => (fail ? Promise.reject(new Error("x")) : Promise.resolve([])));
    const h = setup(read);
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
    expect(read.mock.calls.length).toBeGreaterThan(2);
    expect(h.onError).toHaveBeenCalledTimes(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    fail = true;
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 2);
    expect(h.onError).toHaveBeenCalledTimes(2);
    h.stop();
  });
});
