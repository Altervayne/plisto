// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createOfferGate } from "./safeOffer";

// -- Type Imports --
import type { PluginBootState } from "../../types";

const RUNNING: PluginBootState = { runtime: "running", unclean: true, safe_flag: false };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the offer's answer gate", () => {
  it("resolves once even when answered twice", async () => {
    const resolve = vi.fn().mockResolvedValue(RUNNING);
    const apply = vi.fn();
    const answer = createOfferGate(resolve, apply);
    answer(true);
    answer(true);
    answer(false);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(true);
    expect(apply).toHaveBeenCalledWith(RUNNING);
  });

  it("ignores the close that follows a confirm", async () => {
    const resolve = vi.fn().mockResolvedValue(RUNNING);
    const answer = createOfferGate(resolve, () => {});
    answer(true);
    answer(false);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it("lets the user answer again when the resolve failed", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(RUNNING);
    const answer = createOfferGate(resolve, () => {});
    answer(false);
    await flush();
    answer(false);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
