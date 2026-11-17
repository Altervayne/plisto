// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { awaitPrompt, PROMPT_TIMEOUT_MS } from "./ownerPrompt";

// -- Type Imports --
import type { PromptAnswer } from "./types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("awaitPrompt", () => {
  it("resolves with the choice the owner made", async () => {
    let choose: (a: PromptAnswer) => void = () => {};
    const pending = awaitPrompt(new AbortController().signal, (answer) => (choose = answer));
    choose("continue");
    expect(await pending).toBe("continue");
  });

  it("skips itself when nobody answers in time", async () => {
    const pending = awaitPrompt(new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("skip");
  });

  it("skips at once when the run's signal aborts, and ignores a later answer", async () => {
    const stop = new AbortController();
    let choose: (a: PromptAnswer) => void = () => {};
    const pending = awaitPrompt(stop.signal, (answer) => (choose = answer));
    stop.abort();
    expect(await pending).toBe("skip");
    choose("continue");
  });

  it("skips without asking when the signal is already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    let asked = false;
    expect(await awaitPrompt(stop.signal, () => (asked = true))).toBe("skip");
    expect(asked).toBe(false);
  });

  it("keeps the first answer", async () => {
    let choose: (a: PromptAnswer) => void = () => {};
    const pending = awaitPrompt(new AbortController().signal, (answer) => (choose = answer));
    choose("skip");
    choose("continue");
    expect(await pending).toBe("skip");
  });
});
