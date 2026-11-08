// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createSnowState, stepSnow } from "./snowfall";

// -- Type Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;

function sig(over: Partial<VisualSignal>): VisualSignal {
  return { ...restSignal(), ...over };
}

describe("snowfall", () => {
  it("has no eddies without a bass envelope", () => {
    const st = createSnowState();
    for (let i = 0; i < 300; i++) stepSnow(st, sig({ bassMotion: 0 }), DT);
    expect(st.swirl).toBe(0);
  });

  it("winds the eddies up with the bass and relaxes them over about two seconds", () => {
    const st = createSnowState();
    for (let i = 0; i < 180; i++) stepSnow(st, sig({ bassMotion: 1 }), DT);
    const peak = st.swirl;
    expect(peak).toBeGreaterThan(1.2);
    for (let i = 0; i < 120; i++) stepSnow(st, sig({ bassMotion: 0 }), DT);
    expect(st.swirl).toBeLessThan(peak * 0.45);
    expect(st.swirl).toBeGreaterThan(0);
  });

  it("eases the gust after a beat instead of stepping", () => {
    const st = createSnowState();
    stepSnow(st, sig({ beat: 1 }), DT);
    expect(st.gust).toBeLessThan(0.1 * st.target);
    for (let i = 0; i < 30; i++) stepSnow(st, sig({}), DT);
    expect(st.gust).toBeGreaterThan(1);
    for (let i = 0; i < 600; i++) stepSnow(st, sig({}), DT);
    expect(st.gust).toBeLessThan(0.01);
  });

  it("raises density with the swell", () => {
    const calm = createSnowState();
    const swelling = createSnowState();
    for (let i = 0; i < 600; i++) {
      stepSnow(calm, sig({ swell: 0 }), DT);
      stepSnow(swelling, sig({ swell: 0.8 }), DT);
    }
    expect(swelling.density).toBeGreaterThan(calm.density + 0.3);
  });
});
