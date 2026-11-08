// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createLatteState, latteRingBeat, stepLatte } from "./latte";

// -- Type Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;

function sig(over: Partial<VisualSignal>): VisualSignal {
  return { ...restSignal(), ...over };
}

describe("latte", () => {
  it("starts a ring only on a beat with the bass envelope up", () => {
    expect(latteRingBeat(sig({ beat: 1, bassMotion: 0.2 }))).toBe(0);
    expect(latteRingBeat(sig({ beat: 0, bassMotion: 1 }))).toBe(0);
    expect(latteRingBeat(sig({ beat: 1, bassMotion: 1 }))).toBeCloseTo(1.1);
    expect(latteRingBeat(sig({ beat: 3, bassMotion: 1 }))).toBe(1.5);
  });

  it("glides the angle after a beat instead of stepping", () => {
    const st = createLatteState();
    const rest = stepLatte(createLatteState(), sig({}), DT).rot;
    const hit = stepLatte(st, sig({ beat: 1 }), DT).rot;
    expect(Math.abs(hit - rest)).toBeLessThan(0.002);
    for (let i = 0; i < 120; i++) stepLatte(st, sig({}), DT);
    expect(st.nudge).toBeGreaterThan(0.01);
    for (let i = 0; i < 1200; i++) stepLatte(st, sig({}), DT);
    expect(st.nudge).toBeLessThan(0.001);
  });

  it("eases the mid envelope before it drives the turn speed", () => {
    const st = createLatteState();
    stepLatte(st, sig({ midMotion: 1 }), DT);
    expect(st.mid).toBeLessThan(0.05);
    for (let i = 0; i < 600; i++) stepLatte(st, sig({ midMotion: 1 }), DT);
    expect(st.mid).toBeGreaterThan(0.95);
  });

  it("keeps the swirl within 0..1", () => {
    const st = createLatteState();
    for (let i = 0; i < 6000; i++) {
      const { twist } = stepLatte(st, sig({ level: 0.5, midMotion: 0.5 }), DT);
      expect(twist).toBeGreaterThanOrEqual(0);
      expect(twist).toBeLessThanOrEqual(1);
    }
  });
});
