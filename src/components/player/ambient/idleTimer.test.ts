// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createIdleTimer, type Timers } from "./idleTimer";

const timers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id),
};

describe("createIdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fades once after the delay with no activity", () => {
    const onChange = vi.fn();
    createIdleTimer(5000, onChange, timers);
    vi.advanceTimersByTime(4999);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("restarts the countdown on a wake", () => {
    const onChange = vi.fn();
    const idle = createIdleTimer(5000, onChange, timers);
    vi.advanceTimersByTime(4000);
    idle.wake();
    vi.advanceTimersByTime(4000);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("un-fades at once on a wake, then fades again after the delay", () => {
    const onChange = vi.fn();
    const idle = createIdleTimer(5000, onChange, timers);
    vi.advanceTimersByTime(5000);
    idle.wake();
    expect(onChange).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(5000);
    expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("reports nothing for a wake while visible", () => {
    const onChange = vi.fn();
    const idle = createIdleTimer(5000, onChange, timers);
    idle.wake();
    idle.wake();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops counting once disposed", () => {
    const onChange = vi.fn();
    const idle = createIdleTimer(5000, onChange, timers);
    idle.dispose();
    vi.advanceTimersByTime(10000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
