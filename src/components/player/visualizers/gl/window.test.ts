// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { WINDOW_SLOTS, stepBeatWindows, type BeatWindow } from "./window";

const DT = 1 / 60;

describe("window beat windows", () => {
  it("never cuts a burst short and never exceeds four slots", () => {
    const wins: (BeatWindow | undefined)[] = [];
    const packed = new Float32Array(WINDOW_SLOTS * 2);
    const rng = createRng(1);
    const prev: number[] = [];
    for (let i = 0; i < 60 * 40; i++) {
      stepBeatWindows(wins, DT, i % 18 === 0 ? 1 : 0, 1, rng, packed);
      expect(wins.length).toBeLessThanOrEqual(WINDOW_SLOTS);
      wins.forEach((w, k) => {
        if (!w) return;
        // Once past its rise a glow only falls; a restart would show as a jump up.
        if (w.age > 0.8 && prev[k] !== undefined && w.age > DT * 2) expect(w.glow).toBeLessThanOrEqual(prev[k] + 1e-9);
        prev[k] = w.glow;
      });
    }
  });

  it("rises over 0.7 s and is mostly faded after about 6 s", () => {
    const wins: (BeatWindow | undefined)[] = [];
    const packed = new Float32Array(WINDOW_SLOTS * 2);
    stepBeatWindows(wins, DT, 1, 1, createRng(2), packed);
    let peak = 0;
    let at = 0;
    let t = 0;
    while (t < 6.5) {
      stepBeatWindows(wins, DT, 0, 1, createRng(2), packed);
      t += DT;
      if (wins[0]!.glow > peak) {
        peak = wins[0]!.glow;
        at = t;
      }
    }
    expect(at).toBeGreaterThan(0.6);
    expect(at).toBeLessThan(0.8);
    expect(wins[0]!.glow).toBeLessThan(peak * 0.05);
  });

  it("picks the same windows for the same seed", () => {
    const run = () => {
      const wins: (BeatWindow | undefined)[] = [];
      stepBeatWindows(wins, DT, 1, 1, createRng(7), new Float32Array(8));
      return wins[0]!.seed;
    };
    expect(run()).toBe(run());
  });
});
