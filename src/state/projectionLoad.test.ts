// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createProjectionLoader, STALL_MS } from "./projectionLoad";
import { reportBootRead } from "../lib/bootReadLog";

// -- Type Imports --
import type { LoadFlags } from "./projectionLoad";

let applied: string[];
let flags: LoadFlags;

const loaderFor = (read: () => Promise<string>) =>
  createProjectionLoader({
    name: "tracks",
    read,
    apply: (v) => applied.push(v),
    onFlags: (f) => (flags = f),
  });

vi.mock("../lib/bootReadLog", () => ({ reportBootRead: vi.fn() }));
const logged = vi.mocked(reportBootRead);

beforeEach(() => {
  vi.useFakeTimers();
  logged.mockClear();
  applied = [];
  flags = { ready: false, stalled: false };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the first read", () => {
  it("lands after twenty rejections and reads ready only then", async () => {
    const read = vi.fn();
    for (let i = 0; i < 20; i++) read.mockRejectedValueOnce(new Error("early"));
    read.mockResolvedValue("rows");
    const loader = loaderFor(read);
    const first = loader.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flags.ready).toBe(false);
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    expect(applied).toEqual(["rows"]);
    expect(flags).toEqual({ ready: true, stalled: false });
  });

  it("recovers from a read that never settles", async () => {
    const read = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue("rows");
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(applied).toEqual(["rows"]);
    expect(loader.isReady()).toBe(true);
  });

  it("is stalled at the threshold and clears on landing", async () => {
    let answer: (v: string) => void = () => {};
    const loader = loaderFor(() => new Promise<string>((r) => (answer = r)));
    void loader.start();
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(flags.stalled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(flags).toEqual({ ready: false, stalled: true });
    answer("rows");
    await vi.advanceTimersByTimeAsync(0);
    expect(flags).toEqual({ ready: true, stalled: false });
  });

  it("applies the late answer of a timed-out attempt when nothing newer landed", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockReturnValue(new Promise(() => {}));
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    answer("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual(["late"]);
    expect(loader.isReady()).toBe(true);
  });

  it("drops a late answer once a newer read applied", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockResolvedValue("fresh");
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(applied).toEqual(["fresh"]);
    answer("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual(["fresh"]);
  });

  it("drops the late answer of an abandoned attempt once a newer read applied", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue("fresh");
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10_000 + 60_000);
    expect(applied).toEqual(["fresh"]);
    answer("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual(["fresh"]);
  });

  it("wakes on window focus and then lets go of the listener", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const removed = vi.spyOn(win, "removeEventListener");
    const read = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("rows");
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(loader.isReady()).toBe(true);
    expect(removed).toHaveBeenCalledWith("focus", expect.any(Function));
    vi.unstubAllGlobals();
  });

  it("wakes on an explicit wake", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("rows");
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10);
    loader.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("holds the in-flight cap at two", async () => {
    let open = 0;
    let peak = 0;
    const loader = loaderFor(() => {
      open++;
      peak = Math.max(peak, open);
      return new Promise<string>(() => {});
    });
    void loader.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 5; i++) loader.wake();
    expect(peak).toBe(2);
    loader.reset();
  });

  it("leaves no timer running once ready", async () => {
    const loader = loaderFor(async () => "rows");
    await loader.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts once for any number of callers", async () => {
    const read = vi.fn().mockResolvedValue("rows");
    const loader = loaderFor(read);
    await Promise.all([loader.start(), loader.start()]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing apply as a failed read", async () => {
    const apply = vi.fn().mockImplementationOnce(() => {
      throw new Error("bad shape");
    });
    const loader = createProjectionLoader({
      name: "roots",
      read: async () => "rows",
      apply,
      onFlags: (f) => (flags = f),
    });
    void loader.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(flags.ready).toBe(true);
  });
});

describe("a reload", () => {
  it("keeps the loaded rows and reports false when it keeps failing", async () => {
    const read = vi.fn().mockResolvedValueOnce("rows").mockRejectedValue(new Error("down"));
    const loader = loaderFor(read);
    await loader.start();
    const out = loader.reload();
    await vi.runAllTimersAsync();
    expect(await out).toBe(false);
    expect(applied).toEqual(["rows"]);
    expect(flags.ready).toBe(true);
  });

  it("returns false at once while the first read runs, then follows up once after it lands", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockResolvedValue("follow");
    const loader = loaderFor(read);
    void loader.start();
    expect(await loader.reload()).toBe(false);
    expect(await loader.load()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    answer("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(["first", "follow"]);
  });

  it("issues exactly the first read and one follow-up on a cold launch", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockResolvedValue("follow");
    const loader = loaderFor(read);
    void loader.start();
    void loader.load();
    void loader.load();
    answer("first");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("starts the first read when a reload is the first caller", async () => {
    const read = vi.fn().mockResolvedValue("rows");
    const loader = loaderFor(read);
    expect(await loader.reload()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.isReady()).toBe(true);
  });

  it("does not follow up when no reload was requested", async () => {
    const read = vi.fn().mockResolvedValue("rows");
    const loader = loaderFor(read);
    await loader.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("the boot log", () => {
  it("logs nothing for a first read that lands on attempt one", async () => {
    const loader = loaderFor(async () => "rows");
    await loader.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logged).not.toHaveBeenCalled();
  });

  it("logs each failure, then recovered exactly once with the landing attempt", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("early"))
      .mockRejectedValueOnce("boom")
      .mockResolvedValue("rows");
    const loader = loaderFor(read);
    await settle(loader.start());
    expect(logged.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["tracks", "failed", 1],
      ["tracks", "failed", 2],
      ["tracks", "recovered", 3],
    ]);
    expect(String(logged.mock.calls[0][4])).toContain("early");
    expect(logged.mock.calls[2][3]).toBe(750);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logged).toHaveBeenCalledTimes(3);
  });

  it("logs a timeout, then the late answer that recovers", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockReturnValue(new Promise(() => {}));
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    answer("rows");
    await vi.advanceTimersByTimeAsync(0);
    expect(logged.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ["timeout", 1, 10_000],
      ["late", 1, 10_000],
      ["recovered", 1, 10_000],
    ]);
  });

  it("logs nothing for reloads after ready", async () => {
    const read = vi.fn().mockResolvedValueOnce("rows").mockRejectedValue(new Error("down"));
    const loader = loaderFor(read);
    await loader.start();
    const out = loader.reload();
    await vi.runAllTimersAsync();
    await out;
    expect(logged).not.toHaveBeenCalled();
  });
});

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("after ready", () => {
  it("drops a leftover attempt and leaves no timers", async () => {
    let answer: (v: string) => void = () => {};
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (answer = r)))
      .mockResolvedValue("fresh");
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(applied).toEqual(["fresh"]);
    expect(vi.getTimerCount()).toBe(0);
    answer("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual(["fresh"]);
  });

  it("lands a read that settles after 45 seconds", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => setTimeout(() => r("slow"), 45_000)))
      .mockReturnValue(new Promise(() => {}));
    const loader = loaderFor(read);
    void loader.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(applied).toEqual(["slow"]);
    expect(loader.isReady()).toBe(true);
  });

  it("ignores every answer after a reset, and settles a waiting start", async () => {
    let answer: (v: string) => void = () => {};
    const loader = loaderFor(() => new Promise<string>((r) => (answer = r)));
    const waiting = loader.start();
    loader.reset();
    await waiting;
    answer("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a reload answer issued before a reset", async () => {
    const read = vi.fn().mockResolvedValueOnce("rows");
    const loader = loaderFor(read);
    await loader.start();
    let answer: (v: string) => void = () => {};
    read.mockReturnValueOnce(new Promise<string>((r) => (answer = r)));
    const pending = loader.reload(false);
    loader.reset();
    answer("late");
    expect(await pending).toBe(false);
    expect(applied).toEqual(["rows"]);
  });
});
