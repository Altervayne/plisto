// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { DEFAULT_TIMEOUT_MS, deadlineMs, runBounded } from "./deadline";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deadlineMs", () => {
  it("defaults to 60 s and clamps a requested value", () => {
    expect(deadlineMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineMs(NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineMs(5)).toBe(1_000);
    expect(deadlineMs(10_000)).toBe(10_000);
    expect(deadlineMs(10_000_000)).toBe(600_000);
  });
});

describe("runBounded", () => {
  it("returns the result of a probe that finishes in time", async () => {
    const end = await runBounded(async () => 7, 1000, new AbortController().signal);
    expect(end).toEqual({ kind: "done", value: 7 });
  });

  it("times out a probe that never settles, and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const pending = runBounded(
      (signal) => {
        seen = signal;
        return new Promise<number>(() => {});
      },
      1000,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ kind: "timeout" });
    expect(seen?.aborted).toBe(true);
  });

  it("drops a result that arrives after the deadline", async () => {
    let finish: (v: string) => void = () => {};
    const pending = runBounded(() => new Promise<string>((r) => (finish = r)), 1000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    finish("pass");
    expect(await pending).toEqual({ kind: "timeout" });
  });

  it("ends at once as stopped when stop aborts, and drops a later result", async () => {
    const stop = new AbortController();
    let finish: (v: string) => void = () => {};
    const pending = runBounded(() => new Promise<string>((r) => (finish = r)), 60_000, stop.signal);
    stop.abort();
    expect(await pending).toEqual({ kind: "stopped" });
    finish("pass");
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("is stopped without starting work waiting when stop is already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await runBounded(() => new Promise<number>(() => {}), 1000, stop.signal)).toEqual({ kind: "stopped" });
  });

  it("rejects when the probe throws before the end, and swallows a throw after it", async () => {
    await expect(
      runBounded(() => Promise.reject(new Error("boom")), 1000, new AbortController().signal),
    ).rejects.toThrow("boom");
    let fail: (e: Error) => void = () => {};
    const pending = runBounded(() => new Promise<number>((_, r) => (fail = r)), 1000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    fail(new Error("late"));
    expect(await pending).toEqual({ kind: "timeout" });
  });
});
