import { describe, expect, it } from "vitest";
import { createLakeState, easeHigh, stepLake } from "./lake";
import type { VisualSignal } from "../../../../state/player/visualSignal";

const sig = (over: Partial<VisualSignal>): VisualSignal => ({ level: 0.5, midMotion: 0, highMotion: 0, beat: 0, drive: 1.6, ...over }) as VisualSignal;

describe("easeHigh", () => {
  it("rises faster than it falls", () => {
    const up = easeHigh(0, 1, 0.1);
    const down = 1 - easeHigh(1, 0, 0.1);
    expect(up).toBeGreaterThan(down * 2);
  });

  it("stays inside 0..1", () => {
    expect(easeHigh(0.5, 3, 1)).toBeLessThanOrEqual(1);
    expect(easeHigh(0.5, -2, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe("stepLake", () => {
  it("moves the clouds in small steps under beats at the cap and Lively gain", () => {
    const st = createLakeState();
    const dt = 1 / 60;
    let prev = st.cloud * 0.105 + st.nudge * 1.5;
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      const beat = i % 18 === 0 ? 1.5 : 0;
      stepLake(st, sig({ beat, midMotion: i % 18 < 3 ? 1.6 : 0 }), dt);
      const off = st.cloud * 0.105 + st.nudge * 1.5;
      worst = Math.max(worst, Math.abs(off - prev));
      prev = off;
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("settles the nudge back toward rest", () => {
    const st = createLakeState();
    stepLake(st, sig({ beat: 1 }), 1 / 60);
    for (let i = 0; i < 600; i++) stepLake(st, sig({}), 1 / 60);
    expect(st.nudge).toBeLessThan(0.001);
  });
});
