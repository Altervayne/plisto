// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createFlyState, createSwellState, stepFlies, stepSwell, swellLevel } from "./fireflies";

// -- Type Imports --
import { restSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
// The rate cap on beats, in seconds.
const BEAT_GAP = 0.3;

/** Feeds a beat every `gap` seconds for `seconds`, returning the times a swell started. */
function swellStarts(gap: number, seconds: number): number[] {
  const st = createSwellState();
  const starts: number[] = [];
  let sinceBeat = gap;
  for (let i = 0; i * DT < seconds; i++) {
    sinceBeat += DT;
    let beat = 0;
    if (sinceBeat >= gap) {
      beat = 1;
      sinceBeat = 0;
    }
    if (stepSwell(st, beat, 1, DT)) starts.push(i * DT);
  }
  return starts;
}

describe("fireflies swell", () => {
  it("starts at most one swell per 2.3 s under beats at the rate cap", () => {
    const starts = swellStarts(BEAT_GAP, 60);
    expect(starts.length).toBeGreaterThan(10);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(2.3);
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(60 / 2.3));
  });

  it("rises over at least 0.5 s and is eased", () => {
    const st = createSwellState();
    stepSwell(st, 1, 1, DT);
    let steps = 1;
    while (st.rising) {
      stepSwell(st, 0, 1, DT);
      steps++;
    }
    expect(steps * DT).toBeGreaterThanOrEqual(0.5 - 1e-6);
    const half = createSwellState();
    stepSwell(half, 1, 1, 0.25);
    expect(swellLevel(half)).toBeCloseTo(0.5 * half.amp, 5);
  });

  it("ignores beats during the rise and the decay above 0.3", () => {
    const st = createSwellState();
    expect(stepSwell(st, 1, 1, DT)).toBe(true);
    expect(stepSwell(st, 1, 1, DT)).toBe(false);
    for (let i = 0; i < 40; i++) stepSwell(st, 0, 1, DT);
    expect(st.sync).toBeGreaterThan(0.3);
    expect(stepSwell(st, 1, 1, DT)).toBe(false);
  });

  it("never swells without a beat", () => {
    const st = createSwellState();
    for (let i = 0; i < 600; i++) stepSwell(st, 0, 1.5, DT);
    expect(swellLevel(st)).toBe(0);
  });
});

describe("fireflies continuity", () => {
  it("moves every position and brightness input by small steps under beats at Lively gain", () => {
    const st = createFlyState();
    let prev = { lift: 0, wander: 0, seed: 0, swell: 0 };
    let gap = 0.3;
    const worst = { lift: 0, wander: 0, seed: 0, swell: 0 };
    for (let i = 0; i < 60 * 60; i++) {
      gap += DT;
      const beat = gap >= 0.3 ? 1.5 : 0;
      if (beat) gap = 0;
      const mid = i % 120 < 60 ? 1 : 0;
      stepFlies(st, { ...restSignal(), beat, drive: 1.6, midMotion: mid, level: mid }, DT);
      const now = { lift: st.lift, wander: st.wander, seed: st.seed, swell: swellLevel(st.swell) };
      for (const key of Object.keys(now) as (keyof typeof now)[]) {
        worst[key] = Math.max(worst[key], Math.abs(now[key] - prev[key]));
      }
      prev = now;
    }
    // A 0.35 s eased rise of the full range moves at most 1.5 / 0.35 per second.
    expect(worst.lift).toBeLessThan(0.075);
    expect(worst.wander).toBeLessThan(2.25 * DT + 1e-9);
    expect(worst.seed).toBeLessThan(0.002 + 1e-9);
    expect(worst.swell).toBeLessThan(0.06);
  });
});
