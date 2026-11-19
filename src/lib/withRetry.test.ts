// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { withRetry } from "./withRetry";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry with a number of attempts", () => {
  it("resolves at once on success", async () => {
    const fn = vi.fn().mockResolvedValue(7);
    expect(await withRetry(fn)).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on the ramp and resolves", async () => {
    const fn = vi.fn().mockRejectedValueOnce("a").mockRejectedValueOnce("b").mockResolvedValue(1);
    const out = withRetry(fn);
    await vi.advanceTimersByTimeAsync(250);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await out).toBe(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last error after its attempts", async () => {
    const fn = vi.fn().mockRejectedValue("down");
    const out = withRetry(fn, 3).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await out).toBe("down");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("withRetry with options", () => {
  const harness = () => {
    let seq = 0;
    const answers: Array<[unknown, number]> = [];
    return {
      answers,
      options: {
        nextSeq: () => ++seq,
        onAnswer: (value: unknown, n: number) => {
          answers.push([value, n]);
        },
      },
    };
  };

  it("keeps going through twenty rejections and then lands", async () => {
    const h = harness();
    const fn = vi.fn();
    for (let i = 0; i < 20; i++) fn.mockRejectedValueOnce(new Error("early"));
    fn.mockResolvedValue("ok");
    withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(21);
    expect(h.answers).toEqual([["ok", 21]]);
  });

  it("backs off on the ramp, then every five seconds", async () => {
    const h = harness();
    const fn = vi.fn().mockRejectedValue(new Error("down"));
    const run = withRetry(fn, h.options);
    // 250 + 500 + 750 + 9 x 1000 for the first twelve failures.
    await vi.advanceTimersByTimeAsync(250 + 500 + 750 + 9_000);
    expect(fn).toHaveBeenCalledTimes(13);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fn).toHaveBeenCalledTimes(13);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(14);
    run.cancel();
  });

  it("times out a silent attempt, retries, and lets the retry land", async () => {
    const h = harness();
    const fn = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue("ok");
    withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(h.answers).toEqual([["ok", 2]]);
  });

  it("still hands over the late answer of a timed-out attempt", async () => {
    const h = harness();
    let late: (v: string) => void = () => {};
    const fn = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (late = r)))
      .mockReturnValue(new Promise(() => {}));
    withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(10_000);
    late("slow");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.answers).toEqual([["slow", 1]]);
  });

  it("swallows the late rejection of a timed-out attempt", async () => {
    const h = harness();
    let reject: (e: Error) => void = () => {};
    const fn = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((_, r) => (reject = r)))
      .mockResolvedValue("ok");
    // An unhandled rejection would fail the whole run.
    withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(10_000);
    reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.answers).toEqual([["ok", 2]]);
  });

  it("doubles the timeout of the attempt that follows a timeout", async () => {
    const h = harness();
    let rejectFirst: (e: Error) => void = () => {};
    const fn = vi
      .fn()
      .mockReturnValueOnce(new Promise<never>((_, r) => (rejectFirst = r)))
      .mockReturnValue(new Promise(() => {}));
    const run = withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
    // Freeing the first slot issues a third attempt, whose timeout is already 20 s.
    rejectFirst(new Error("x"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(3);
    // Attempt two times out at 30 s with the cap full: nothing more is issued.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fn).toHaveBeenCalledTimes(3);
    run.cancel();
  });

  it("never has more than two attempts in flight", async () => {
    const h = harness();
    let open = 0;
    let peak = 0;
    const fn = vi.fn(() => {
      open++;
      peak = Math.max(peak, open);
      return new Promise<never>((_, reject) => setTimeout(() => (open--, reject(new Error("x"))), 30_000));
    });
    const run = withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(peak).toBe(2);
    run.cancel();
  });

  it("gives a silent attempt's slot back a minute after its timeout, so a third is issued", async () => {
    const h = harness();
    const fn = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(new Promise(() => {}));
    fn.mockResolvedValue("ok");
    withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(h.answers).toEqual([["ok", 3]]);
  });

  it("wake issues nothing at the cap, and one attempt once a slot is given back", async () => {
    const h = harness();
    const fn = vi.fn().mockReturnValue(new Promise(() => {}));
    const run = withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(20_000);
    run.wake();
    expect(fn).toHaveBeenCalledTimes(2);
    // The first attempt is abandoned at 70 s and the loop issues the third on its own.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fn).toHaveBeenCalledTimes(3);
    run.wake();
    expect(fn).toHaveBeenCalledTimes(3);
    run.cancel();
  });

  it("keeps the count right when an abandoned attempt settles late", async () => {
    const h = harness();
    let rejectFirst: (e: Error) => void = () => {};
    const fn = vi.fn(
      () =>
        new Promise<string>((_, reject) => {
          if (fn.mock.calls.length === 1) rejectFirst = reject;
        }),
    );
    const run = withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(10_000 + 60_000);
    // Attempt one is abandoned; attempts two and three are live and fill the cap.
    expect(fn).toHaveBeenCalledTimes(3);
    rejectFirst(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    // Its slot was already given back: settling must not free a second one.
    run.wake();
    run.wake();
    expect(fn).toHaveBeenCalledTimes(3);
    run.cancel();
  });

  it("reports failed, timeout and late attempts with their number and elapsed time", async () => {
    const h = harness();
    const events: Array<[string, number, number, unknown]> = [];
    let late: (v: string) => void = () => {};
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("early"))
      .mockReturnValueOnce(new Promise<string>((r) => (late = r)))
      .mockReturnValue(new Promise(() => {}));
    withRetry(fn, {
      ...h.options,
      onEvent: (e) => events.push([e.kind, e.attempt, e.elapsedMs, e.error]),
    });
    await vi.advanceTimersByTimeAsync(10_250);
    late("slow");
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((e) => e.slice(0, 3))).toEqual([
      ["failed", 1, 0],
      ["timeout", 2, 10_250],
      ["late", 2, 10_250],
    ]);
    expect(String(events[0][3])).toContain("early");
  });

  it("ignores a throwing event callback", async () => {
    const h = harness();
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
    withRetry(fn, {
      ...h.options,
      onEvent: () => {
        throw new Error("sink");
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.answers).toEqual([["ok", 2]]);
  });

  it("leaves no timers after cancel", async () => {
    const h = harness();
    const run = withRetry(() => new Promise<never>(() => {}), h.options);
    await vi.advanceTimersByTimeAsync(10_000);
    run.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wake issues an attempt without waiting out the sleep", async () => {
    const h = harness();
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
    const run = withRetry(fn, h.options);
    await vi.advanceTimersByTimeAsync(10);
    expect(fn).toHaveBeenCalledTimes(1);
    run.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(h.answers).toEqual([["ok", 2]]);
  });

  it("counts a throwing answer as a failed attempt", async () => {
    let seq = 0;
    let calls = 0;
    withRetry(async () => "v", {
      nextSeq: () => ++seq,
      onAnswer: () => {
        if (++calls === 1) throw new Error("bad shape");
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(2);
  });

  it("drops answers after cancel", async () => {
    const h = harness();
    let late: (v: string) => void = () => {};
    const run = withRetry(() => new Promise<string>((r) => (late = r)), h.options);
    run.cancel();
    late("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.answers).toEqual([]);
  });
});
