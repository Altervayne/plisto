// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createLock } from "./operationLock";

describe("operation lock", () => {
  it("refuses a second operation while one runs, and the refused job never starts", async () => {
    const lock = createLock();
    let finish!: () => void;
    const first = lock.run(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(lock.busy).toBe(true);
    const second = vi.fn(async () => "ran");
    expect(await lock.run(second)).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    finish();
    await first;
    expect(lock.busy).toBe(false);
    expect(await lock.run(second)).toBe("ran");
  });

  it("releases after a failing job and tells subscribers each change", async () => {
    const lock = createLock();
    const seen: boolean[] = [];
    lock.subscribe(() => seen.push(lock.busy));
    await expect(lock.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(seen).toEqual([true, false]);
  });
});
