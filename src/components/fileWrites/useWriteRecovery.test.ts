// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { takeAndShow, takeWithRetry } from "./useWriteRecovery";

// -- Type Imports --
import type { WriteRecovery } from "../../types";

vi.mock("../../lib/ipc", () => ({ takeFileWriteRecovery: vi.fn() }));

describe("takeAndShow", () => {
  it("applies a report that resolves late, whatever happened meanwhile", async () => {
    let resolve: (r: WriteRecovery) => void = () => {};
    const take = () => new Promise<WriteRecovery>((r) => (resolve = r));
    const show = vi.fn();
    takeAndShow(take, show);
    // The scan status flips here in the hook; nothing cancels the take.
    const report = { restored: 1, finished: 0, heldOffline: 0, needsAttention: [] };
    resolve(report);
    await Promise.resolve();
    await Promise.resolve();
    expect(show).toHaveBeenCalledWith(report);
  });

  it("drops a failed take without throwing", async () => {
    const show = vi.fn();
    takeAndShow(() => Promise.reject(new Error("down")), show);
    await Promise.resolve();
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });
});

describe("takeWithRetry", () => {
  const report: WriteRecovery = { restored: 1, finished: 0, heldOffline: 0, needsAttention: [] };
  afterEach(() => vi.useRealTimers());

  it("shows the report once after a rejection then a success", async () => {
    vi.useFakeTimers();
    const take = vi.fn().mockRejectedValueOnce(new Error("cold")).mockResolvedValue(report);
    const show = vi.fn();
    const done = takeWithRetry(take, show, () => true);
    await vi.runAllTimersAsync();
    await done;
    expect(take).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(report);
  });

  it("stops retrying once the hook has unmounted", async () => {
    vi.useFakeTimers();
    const take = vi.fn().mockRejectedValue(new Error("cold"));
    const show = vi.fn();
    let live = true;
    const done = takeWithRetry(take, show, () => live);
    await vi.advanceTimersByTimeAsync(0);
    expect(take).toHaveBeenCalledTimes(1);
    live = false;
    await vi.runAllTimersAsync();
    await done;
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("takes one attempt at a time", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let peak = 0;
    const take = vi.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      throw new Error("cold");
    });
    const done = takeWithRetry(take, vi.fn(), () => true);
    await vi.runAllTimersAsync();
    await done;
    expect(peak).toBe(1);
  });
});
