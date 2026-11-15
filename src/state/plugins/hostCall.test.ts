// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { hostCall } from "./hostCall";

// -- Type Imports --
import type { PluginCallReply } from "../../types";

const limited = (retry?: number): PluginCallReply => ({
  ok: false,
  error: { code: "rate_limited", message: "slow", ...(retry === undefined ? {} : { retry_after_ms: retry }) },
});

describe("hostCall", () => {
  it("returns the result of an accepted call", async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: { a: 1 } }) as PluginCallReply);
    expect(await hostCall({ invoke }, "p", "app.info", () => true)).toEqual({ a: 1 });
    expect(invoke).toHaveBeenCalledWith("p", "app.info", "{}");
  });

  it("returns null on a refusal or a rejection", async () => {
    const refused = vi.fn(async () => ({ ok: false, error: { code: "denied", message: "no" } }) as PluginCallReply);
    expect(await hostCall({ invoke: refused }, "p", "m", () => true)).toBeNull();
    expect(await hostCall({ invoke: () => Promise.reject(new Error("x")) }, "p", "m", () => true)).toBeNull();
  });

  it("retries a rate limit after the clamped hint", async () => {
    const invoke = vi
      .fn<() => Promise<PluginCallReply>>()
      .mockResolvedValueOnce(limited(5))
      .mockResolvedValueOnce(limited(99999))
      .mockResolvedValueOnce({ ok: true, result: 1 });
    const sleep = vi.fn(async () => {});
    expect(await hostCall({ invoke, sleep }, "p", "m", () => true)).toBe(1);
    expect(sleep.mock.calls).toEqual([[50], [2000]]);
  });

  it("gives up after the attempt limit", async () => {
    const invoke = vi.fn(async () => limited());
    const sleep = vi.fn(async () => {});
    expect(await hostCall({ invoke, sleep }, "p", "m", () => true)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("stops retrying once the frame is gone", async () => {
    const invoke = vi.fn(async () => limited());
    expect(await hostCall({ invoke, sleep: async () => {} }, "p", "m", () => false)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
