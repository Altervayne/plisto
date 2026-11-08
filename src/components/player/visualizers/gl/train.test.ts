// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createBeatClock, stepBeatClock } from "./beatClock";
import { TRAIN_LOCK, createLockLayer, speedRange, stepLockLayer, type LockLayer } from "./train";

const DT = 1 / 60;
const TRAVEL_PX = 150;

/** Runs `secs` of frames with a beat every `gap` seconds (none when gap is 0), tracking the spacing ratio extremes. */
function run(layer: LockLayer, secs: number, gap: number, drive: number, speedPx: number) {
  const clock = createBeatClock();
  let lo = Infinity;
  let hi = 0;
  let next = gap;
  for (let t = 0; t < secs; t += DT) {
    const beat = gap > 0 && t >= next ? 1 : 0;
    if (beat) next += gap;
    stepBeatClock(clock, DT, beat, drive);
    const [, spacing] = stepLockLayer(layer, DT, speedPx, clock);
    lo = Math.min(lo, spacing / layer.rest);
    hi = Math.max(hi, spacing / layer.rest);
  }
  return { clock, lo, hi };
}

describe("train beat lock", () => {
  it("keeps every layer within 1.6x of rest while locked", () => {
    const layers = [
      [TRAIN_LOCK.POLE_SPACING, TRAIN_LOCK.POLE_RATE],
      [TRAIN_LOCK.LAMP_SPACING, TRAIN_LOCK.LAMP_RATE],
      [TRAIN_LOCK.FENCE_SPACING, TRAIN_LOCK.FENCE_RATE],
    ];
    for (const [rest, rate] of layers) {
      for (const speed of [0.55, 1, 1.7]) {
        const { lo, hi } = run(createLockLayer(rest), 40, 0.5, 1, speed * TRAVEL_PX * rate);
        expect(hi).toBeLessThanOrEqual(1.6);
        expect(lo).toBeGreaterThanOrEqual(1 / 1.6);
      }
    }
  });

  it("locks onto the beat and moves off the resting spacing", () => {
    const layer = createLockLayer(TRAIN_LOCK.LAMP_SPACING);
    const { clock } = run(layer, 30, 0.5, 1, TRAVEL_PX * TRAIN_LOCK.LAMP_RATE);
    expect(clock.lock).toBeGreaterThan(0.9);
    expect(layer.spacing).not.toBeCloseTo(layer.rest, 0);
  });

  it("unlocks with no beats and returns to the resting spacing", () => {
    const layer = createLockLayer(TRAIN_LOCK.LAMP_SPACING);
    const speedPx = TRAVEL_PX * TRAIN_LOCK.LAMP_RATE;
    const clock = createBeatClock();
    for (let t = 0; t < 20; t += DT) {
      stepBeatClock(clock, DT, Math.floor(t / 0.5) !== Math.floor((t - DT) / 0.5) ? 1 : 0, 1);
      stepLockLayer(layer, DT, speedPx, clock);
    }
    for (let t = 0; t < 30; t += DT) {
      stepBeatClock(clock, DT, 0, 1);
      stepLockLayer(layer, DT, speedPx, clock);
    }
    expect(clock.lock).toBeLessThan(0.01);
    expect(layer.spacing / layer.rest).toBeCloseTo(1, 1);
  });

  it("never locks under Calm", () => {
    const layer = createLockLayer(TRAIN_LOCK.LAMP_SPACING);
    const { clock, lo, hi } = run(layer, 30, 0.5, 0, TRAVEL_PX * TRAIN_LOCK.LAMP_RATE);
    expect(clock.lock).toBe(0);
    expect(lo).toBe(1);
    expect(hi).toBe(1);
  });
});

describe("speedRange", () => {
  it("opens the range the reactivity allows", () => {
    expect(speedRange(0)).toEqual([1, 1]);
    expect(speedRange(1)).toEqual([0.75, 1.3]);
    expect(speedRange(1.6)).toEqual([0.55, 1.7]);
  });
});
