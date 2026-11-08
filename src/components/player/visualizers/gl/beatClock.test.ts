// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createBeatClock, stepBeatClock, type BeatClock } from "./beatClock";

const DT = 1 / 60;

/** Runs `secs` of frames, firing a beat whenever `beatAt` says the frame time is on one. */
function run(st: BeatClock, secs: number, beatAt: (t: number) => boolean, drive = 1): void {
  const frames = Math.round(secs / DT);
  let t = 0;
  for (let i = 0; i < frames; i++) {
    t += DT;
    stepBeatClock(st, DT, beatAt(t) ? 1 : 0, drive);
  }
}

/** A beat on every frame whose time crosses a multiple of `gap`. */
function every(gap: number): (t: number) => boolean {
  return (t) => Math.floor(t / gap) !== Math.floor((t - DT) / gap);
}

describe("beatClock", () => {
  it("converges to 0.5 s on steady 120 BPM", () => {
    const st = createBeatClock();
    st.period = 0.8;
    run(st, 20, every(0.5));
    expect(st.period).toBeCloseTo(0.5, 1);
  });

  it("converges to 0.6 s on steady 100 BPM", () => {
    const st = createBeatClock();
    run(st, 20, every(0.6));
    expect(st.period).toBeCloseTo(0.6, 1);
  });

  it("keeps 0.6 s when every other beat is missing", () => {
    const st = createBeatClock();
    st.period = 0.6;
    run(st, 30, every(1.2));
    expect(st.period).toBeCloseTo(0.6, 1);
  });

  it("never drops the period below 0.3 s on rapid off-beats", () => {
    const st = createBeatClock();
    run(st, 20, every(0.3));
    expect(st.period).toBeGreaterThanOrEqual(0.3);
  });

  it("lets the lock fall to near 0 after 3 s without beats", () => {
    const st = createBeatClock();
    run(st, 10, every(0.5));
    expect(st.lock).toBeGreaterThan(0.9);
    run(st, 9, () => false);
    expect(st.lock).toBeLessThan(0.05);
  });

  it("never locks while drive is 0", () => {
    const st = createBeatClock();
    run(st, 10, every(0.5), 0);
    expect(st.lock).toBe(0);
  });
});
