// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createBeatClock, stepBeatClock } from "./beatClock";
import { TRAIN_LOCK, beatNudge, createSpeedState, layerPhase, speedRange, stepTrainSpeed } from "./train";

const DT = 1 / 60;
const TRAVEL_PX = 150;

/** Runs the lamp lock for `secs` with a beat every `gap` seconds (none when 0); returns the extremes it saw. */
function lock(secs: number, gap: number, drive: number, target: number) {
  const clock = createBeatClock();
  const spring = createSpeedState();
  spring.speed = target;
  let travel = 0;
  let nudgeF = 0;
  let reach = 0;
  let next = gap;
  let maxNudge = 0;
  let maxLock = 0;
  for (let t = 0; t < secs; t += DT) {
    const beat = gap > 0 && t >= next ? 1 : 0;
    if (beat) next += gap;
    stepBeatClock(clock, DT, beat, drive);
    const aim = beatNudge(spring.speed, travel, TRAIN_LOCK.LAMP_SPACING, TRAIN_LOCK.LAMP_RATE, clock.period, clock.beatPos);
    reach += (aim.reach - reach) * (1 - Math.exp(-DT / 1));
    nudgeF += (aim.nudge * clock.lock * reach - nudgeF) * (1 - Math.exp(-DT / 0.7));
    travel += DT * spring.speed * (1 + nudgeF) * TRAVEL_PX;
    maxNudge = Math.max(maxNudge, Math.abs(nudgeF));
    maxLock = Math.max(maxLock, clock.lock);
  }
  return { maxNudge, maxLock };
}

describe("rigid world", () => {
  it("derives every layer's phase from the one travel, scaled by its fixed spacing and rate", () => {
    const travel = 12345;
    for (const [rate, spacing] of [
      [TRAIN_LOCK.POLE_RATE, TRAIN_LOCK.POLE_SPACING],
      [TRAIN_LOCK.LAMP_RATE, TRAIN_LOCK.LAMP_SPACING],
      [TRAIN_LOCK.FENCE_RATE, TRAIN_LOCK.FENCE_SPACING],
    ]) {
      expect(layerPhase(travel, rate, spacing)).toBeCloseTo((travel * rate) / spacing, 6);
      expect(layerPhase(2 * travel, rate, spacing)).toBeCloseTo((2 * travel * rate) / spacing, 6);
    }
  });
});

/** Level and bass motion of a synthetic song at time `t`: loud, a breakdown, a build, then the drop. */
function song(t: number): number {
  if (t < 20) return 0.5;
  if (t < 30) return 0.12;
  if (t < 36) return 0.12 + (0.38 * (t - 30)) / 6;
  return 0.5 + 0.1;
}

describe("speed", () => {
  it("never steps: a jump in intensity changes the speed by a small amount per frame", () => {
    const st = createSpeedState();
    let prev = st.speed;
    for (let t = 0; t < 60; t += DT) {
      stepTrainSpeed(st, DT, t < 20 ? 0.1 : 0.8, 1.6);
      expect(Math.abs(st.speed - prev)).toBeLessThan(0.02);
      prev = st.speed;
    }
  });

  it("surges on a drop and coasts on a breakdown at Lively", () => {
    const st = createSpeedState();
    let min = Infinity;
    let max = 0;
    let atBreakdown = 0;
    for (let t = 0; t < 46; t += DT) {
      stepTrainSpeed(st, DT, song(t), 1.6);
      min = Math.min(min, st.speed);
      max = Math.max(max, st.speed);
      if (Math.abs(t - 29.9) < DT / 2) atBreakdown = st.speed;
    }
    expect(atBreakdown).toBeLessThan(0.7);
    expect(min).toBeLessThan(0.6);
    expect(max).toBeGreaterThan(1.8);
  });

  it("holds a steady cruise under Calm", () => {
    const st = createSpeedState();
    for (let t = 0; t < 46; t += DT) {
      stepTrainSpeed(st, DT, song(t), 0);
      expect(st.speed).toBeCloseTo(1, 6);
    }
  });

  it("opens the range the reactivity allows", () => {
    expect(speedRange(0)).toEqual([1, 1]);
    expect(speedRange(1)).toEqual([0.7, 1.5]);
    expect(speedRange(1.6)).toEqual([0.45, 2.2]);
  });
});

describe("beat lock", () => {
  it("keeps the speed within 8% of the target and engages on a steady beat", () => {
    const r = lock(40, 0.5, 1, 1);
    expect(r.maxLock).toBeGreaterThan(0.9);
    expect(r.maxNudge).toBeLessThanOrEqual(0.08);
    expect(r.maxNudge).toBeGreaterThan(0.005);
  });

  it("bounds the raw nudge and gives up when the rhythm is out of reach", () => {
    for (let speed = 0.5; speed < 1.8; speed += 0.07) {
      for (let period = 0.3; period < 1.2; period += 0.05) {
        const { nudge, reach } = beatNudge(speed, 500, TRAIN_LOCK.FENCE_SPACING, TRAIN_LOCK.FENCE_RATE, period, 3.3);
        expect(Math.abs(nudge)).toBeLessThanOrEqual(0.08);
        if (reach === 0) expect(nudge).toBe(0);
      }
    }
  });

  it("does nothing without beats", () => {
    expect(lock(30, 0, 1, 1).maxNudge).toBe(0);
  });

  it("never locks under Calm", () => {
    const r = lock(30, 0.5, 0, 1);
    expect(r.maxLock).toBe(0);
    expect(r.maxNudge).toBe(0);
  });
});
