// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createFinderLifecycle } from "./finderLifecycle";
import { CLOSE_MS, FADE_MS, OPEN_MS } from "./finderMorph";
import type { Scheduler } from "./finderLifecycle";
import type { CloseReason, FinderMotion, MorphFrame } from "./finderMorph";

/** Frames and timers that run only when the test says so. */
function fakeScheduler() {
  let clock = 0;
  let nextId = 1;
  const frames = new Map<number, (now: number) => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler: Scheduler = {
    frame: (callback) => {
      frames.set(nextId, callback);
      return nextId++;
    },
    cancelFrame: (id) => void frames.delete(id),
    timer: (callback, ms) => {
      timers.set(nextId, { at: clock + ms, callback });
      return nextId++;
    },
    cancelTimer: (id) => void timers.delete(id),
    now: () => clock,
  };
  /** Moves the clock by `ms`, running due timers, then one frame at the new time if `withFrame`. */
  const advance = (ms: number, withFrame = true) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.callback();
      }
    }
    if (!withFrame) return;
    const due = [...frames];
    frames.clear();
    for (const [, callback] of due) callback(clock);
  };
  return { scheduler, advance, pendingFrames: () => frames.size, pendingTimers: () => timers.size };
}

function setup(options: { reduced?: boolean; hasOrigin?: boolean; measurable?: boolean; onScreen?: boolean } = {}) {
  const fake = fakeScheduler();
  const log = {
    painted: [] as MorphFrame[],
    cleared: 0,
    measured: 0,
    motion: [] as FinderMotion[],
    closing: 0,
    unmounted: [] as CloseReason[],
  };
  const lifecycle = createFinderLifecycle<object>({
    reduced: options.reduced ?? false,
    hasOrigin: options.hasOrigin ?? true,
    scheduler: fake.scheduler,
    stage: {
      measure: () => {
        log.measured++;
        return options.measurable === false ? null : {};
      },
      paint: (_geo, frame) => void log.painted.push(frame),
      clear: () => void log.cleared++,
      originOnScreen: () => options.onScreen ?? true,
    },
    events: {
      motion: (m) => void log.motion.push(m),
      closing: () => void log.closing++,
      unmount: (reason) => void log.unmounted.push(reason),
    },
  });
  return { lifecycle, log, ...fake };
}

describe("finder lifecycle", () => {
  it("paints the pill frame before the first animation frame and lands at rest", () => {
    const { lifecycle, log, advance } = setup();
    lifecycle.open();
    expect(log.painted[0].k).toBe(0);
    advance(OPEN_MS);
    expect(log.cleared).toBe(1);
  });

  it("falls back to the card's own entrance when nothing can be measured", () => {
    const { lifecycle, log } = setup({ measurable: false });
    lifecycle.open();
    expect(log.motion).toEqual(["card"]);
    expect(log.painted).toHaveLength(0);
  });

  it("unmounts a fly-back from its own last frame, not from a timer", () => {
    const { lifecycle, log, advance, pendingTimers } = setup();
    lifecycle.open();
    advance(OPEN_MS);
    lifecycle.close("dismiss");
    expect(log.motion).toEqual(["morph"]);
    // A timer at CLOSE_MS would fire here, before the frame that paints the end.
    advance(CLOSE_MS, false);
    expect(log.unmounted).toEqual([]);
    advance(0);
    expect(log.painted[log.painted.length - 1].k).toBe(0);
    expect(log.unmounted).toEqual(["dismiss"]);
    expect(pendingTimers()).toBe(0);
  });

  it("still unmounts a fly-back whose frames never come", () => {
    const { lifecycle, log, advance } = setup();
    lifecycle.open();
    advance(OPEN_MS);
    lifecycle.close("dismiss");
    advance(CLOSE_MS * 2, false);
    expect(log.unmounted).toEqual([]);
    advance(CLOSE_MS * 2, false);
    expect(log.unmounted).toEqual(["dismiss"]);
  });

  it("ignores a second close", () => {
    const { lifecycle, log, advance } = setup();
    lifecycle.open();
    advance(OPEN_MS);
    lifecycle.close("dismiss");
    const measured = log.measured;
    lifecycle.close("navigate");
    expect(log.measured).toBe(measured);
    expect(log.closing).toBe(1);
    advance(CLOSE_MS);
    advance(CLOSE_MS * 3);
    expect(log.unmounted).toEqual(["dismiss"]);
  });

  it("fades a pick made during the entrance from the frame on screen", () => {
    const { lifecycle, log, advance } = setup();
    lifecycle.open();
    advance(120);
    lifecycle.close("navigate");
    // Nothing snaps to rest: the drawn frame stays and the overlay fades.
    expect(log.cleared).toBe(0);
    expect(log.motion).toEqual(["fade"]);
    advance(FADE_MS, false);
    expect(log.unmounted).toEqual(["navigate"]);
  });

  it("lets a pick at rest leave with the card's own exit", () => {
    const { lifecycle, log, advance } = setup();
    lifecycle.open();
    advance(OPEN_MS);
    lifecycle.close("play");
    expect(log.motion).toEqual(["card"]);
    advance(CLOSE_MS, false);
    expect(log.unmounted).toEqual(["play"]);
  });

  it("leaves with the card when the pill has gone from the screen", () => {
    const { lifecycle, log, advance } = setup({ onScreen: false });
    lifecycle.open();
    advance(OPEN_MS);
    lifecycle.close("dismiss");
    expect(log.motion).toEqual(["card"]);
  });

  it("fades both ways under reduced motion", () => {
    const { lifecycle, log, advance } = setup({ reduced: true });
    expect(lifecycle.motion).toBe("fade");
    lifecycle.open();
    expect(log.painted).toHaveLength(0);
    lifecycle.close("dismiss");
    expect(log.motion).toEqual(["fade"]);
    advance(FADE_MS, false);
    expect(log.unmounted).toEqual(["dismiss"]);
  });

  it("lands an entrance at once on the first key", () => {
    const { lifecycle, log, advance, pendingFrames } = setup();
    lifecycle.open();
    advance(60);
    lifecycle.land();
    expect(log.cleared).toBe(1);
    expect(pendingFrames()).toBe(0);
  });

  it("stops and clears on an unmount that skipped close, and never reports one", () => {
    const { lifecycle, log, advance, pendingFrames, pendingTimers } = setup();
    lifecycle.open();
    advance(60);
    lifecycle.dispose();
    expect(log.cleared).toBe(1);
    expect(pendingFrames()).toBe(0);
    expect(pendingTimers()).toBe(0);
    expect(log.unmounted).toEqual([]);
  });
});
