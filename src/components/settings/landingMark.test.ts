// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  MARK_FADE_MS,
  MARK_HOLD_MS,
  MARK_REDUCED_HOLD_MS,
  createLandingMark,
} from "./landingMark";
import type { MarkPhase } from "./landingMark";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const phases: Array<MarkPhase | null> = [];
  return { phases, mark: createLandingMark((phase) => phases.push(phase)) };
}

describe("createLandingMark", () => {
  it("holds, fades once, then clears", () => {
    const { phases, mark } = setup();
    mark.show(false);
    expect(phases).toEqual(["hold"]);
    vi.advanceTimersByTime(MARK_HOLD_MS - 1);
    expect(phases).toEqual(["hold"]);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["hold", "fade"]);
    vi.advanceTimersByTime(MARK_FADE_MS);
    expect(phases).toEqual(["hold", "fade", null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds static under reduced motion and removes with no fade", () => {
    const { phases, mark } = setup();
    mark.show(true);
    vi.advanceTimersByTime(MARK_REDUCED_HOLD_MS - 1);
    expect(phases).toEqual(["hold"]);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["hold", null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dismiss clears the mark and cancels the pending timer", () => {
    const { phases, mark } = setup();
    mark.show(false);
    mark.dismiss();
    expect(phases).toEqual(["hold", null]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MARK_HOLD_MS + MARK_FADE_MS);
    expect(phases).toEqual(["hold", null]);
  });

  it("a second show restarts the hold", () => {
    const { phases, mark } = setup();
    mark.show(false);
    vi.advanceTimersByTime(MARK_HOLD_MS - 100);
    mark.show(false);
    vi.advanceTimersByTime(MARK_HOLD_MS - 1);
    expect(phases).toEqual(["hold", "hold"]);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["hold", "hold", "fade"]);
  });
});
