// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { COMMIT_MS, createDebouncedWrite } from "./debouncedWrite";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debounced write", () => {
  it("commits only the last value of a burst, after the pause", () => {
    const commit = vi.fn();
    const write = createDebouncedWrite<number>(commit);
    for (const v of [1, 2, 3]) {
      write.push(v);
      vi.advanceTimersByTime(COMMIT_MS - 50);
    }
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(3);
  });

  it("flushes a held value at once, once", () => {
    const commit = vi.fn();
    const write = createDebouncedWrite<number>(commit);
    write.push(7);
    write.flush();
    write.flush();
    vi.advanceTimersByTime(COMMIT_MS * 2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(7);
  });

  it("drops a held value on cancel", () => {
    const commit = vi.fn();
    const write = createDebouncedWrite<number>(commit);
    write.push(7);
    write.cancel();
    write.flush();
    vi.advanceTimersByTime(COMMIT_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });
});
