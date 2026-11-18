// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { createStationState, stepStation, type StationState } from "./station";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;
// The array joint's top slew rate, rad/s.
const ARR_SLEW = 0.14;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({ rms: 0.3, level: 0.5, bassMotion: 0, midMotion: 0, highMotion: 0, beat: 0, drive: LIVELY, ...over }) as VisualSignal;

/** A song at frame i: a quiet stretch, then a loud drop with every motion envelope and beat at the cap. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < 600) return sig({ rms: 0.15, drive });
  const m = i % BEAT_EVERY < 4 ? LIVELY : 0.4;
  return sig({ rms: 0.8, level: 1, bassMotion: m, midMotion: m, highMotion: m, beat: i % BEAT_EVERY === 0 ? 1.5 : 0, drive });
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: StationState) {
  return [st.phase, st.roll, st.pitch, st.shine, st.sunVis, st.aur, st.aurT, st.high, st.arr, ...st.bolt, ...st.puff];
}

describe("stepStation", () => {
  it("reaches meaningful values and stays in range under Lively at the cap", () => {
    const st = createStationState();
    const rng = createRng(1);
    const lo = { shine: 1, speed: 9, sunVis: 1, roll: 9, pitch: 9 };
    const hi = { shine: 0, speed: 0, sunVis: 0, roll: -9, pitch: -9, aur: 0, high: 0, puff: 0, bolt: 0 };
    let puffs = 0;
    let bolts = 0;
    for (let i = 0; i < 3600; i++) {
      stepStation(st, drop(i), DT, true, rng);
      lo.shine = Math.min(lo.shine, st.shine);
      lo.speed = Math.min(lo.speed, st.speed);
      lo.sunVis = Math.min(lo.sunVis, st.sunVis);
      lo.roll = Math.min(lo.roll, st.roll);
      lo.pitch = Math.min(lo.pitch, st.pitch);
      hi.shine = Math.max(hi.shine, st.shine);
      hi.speed = Math.max(hi.speed, st.speed);
      hi.sunVis = Math.max(hi.sunVis, st.sunVis);
      hi.roll = Math.max(hi.roll, st.roll);
      hi.pitch = Math.max(hi.pitch, st.pitch);
      hi.aur = Math.max(hi.aur, st.aur);
      hi.high = Math.max(hi.high, st.high);
      puffs = Math.max(puffs, st.puffs.length);
      bolts = Math.max(bolts, st.bolts.length);
      for (let k = 2; k < st.puff.length; k += 4) hi.puff = Math.max(hi.puff, st.puff[k]);
      for (let k = 2; k < st.bolt.length; k += 4) hi.bolt = Math.max(hi.bolt, st.bolt[k]);
    }
    expect(lo.shine).toBeGreaterThanOrEqual(0);
    expect(hi.shine).toBeGreaterThan(0.9);
    expect(hi.shine).toBeLessThanOrEqual(1);
    expect(lo.speed).toBeGreaterThanOrEqual(0.3);
    expect(hi.speed).toBeGreaterThan(1.4);
    expect(hi.speed).toBeLessThanOrEqual(2.2);
    expect(lo.sunVis).toBeGreaterThanOrEqual(0);
    expect(hi.sunVis).toBeLessThanOrEqual(1);
    // The roll swings about 15 degrees either side of its rest and no further.
    expect(lo.roll).toBeGreaterThan(-0.3 - 0.4);
    expect(hi.roll).toBeLessThan(-0.3 + 0.4);
    expect(hi.roll - lo.roll).toBeGreaterThan(0.1);
    expect(lo.pitch).toBeGreaterThan(-0.07);
    expect(hi.pitch).toBeGreaterThan(0.03);
    expect(hi.pitch).toBeLessThan(0.07 * LIVELY);
    expect(hi.aur).toBeGreaterThan(0.5);
    expect(hi.aur).toBeLessThanOrEqual(LIVELY);
    expect(hi.high).toBeGreaterThan(0.5);
    expect(hi.high).toBeLessThanOrEqual(LIVELY);
    expect(puffs).toBe(2);
    expect(bolts).toBeLessThanOrEqual(6);
    expect(bolts).toBeGreaterThan(0);
    expect(hi.puff).toBeGreaterThan(0.5);
    expect(hi.puff).toBeLessThanOrEqual(1.2);
    expect(hi.bolt).toBeGreaterThan(0.3);
    expect(hi.bolt).toBeLessThanOrEqual(1.2);
  });

  it("moves in small steps under Lively beats at the cap", () => {
    const st = createStationState();
    const rng = createRng(1);
    let prev = { phase: st.phase, speed: st.speed, roll: st.roll, pitch: st.pitch, sunVis: st.sunVis, shine: st.shine, aur: st.aurT };
    let arr: number | null = null;
    const worst = { phase: 0, speed: 0, roll: 0, pitch: 0, sunVis: 0, shine: 0, aurT: 0, arr: 0 };
    for (let i = 0; i < 3600; i++) {
      stepStation(st, drop(i), DT, true, rng);
      worst.phase = Math.max(worst.phase, st.phase - prev.phase);
      worst.speed = Math.max(worst.speed, Math.abs(st.speed - prev.speed));
      worst.roll = Math.max(worst.roll, Math.abs(st.roll - prev.roll));
      worst.pitch = Math.max(worst.pitch, Math.abs(st.pitch - prev.pitch));
      worst.sunVis = Math.max(worst.sunVis, Math.abs(st.sunVis - prev.sunVis));
      worst.shine = Math.max(worst.shine, Math.abs(st.shine - prev.shine));
      worst.aurT = Math.max(worst.aurT, st.aurT - prev.aur);
      if (arr !== null && st.arr !== null) worst.arr = Math.max(worst.arr, Math.abs(st.arr - arr));
      arr = st.arr;
      prev = { phase: st.phase, speed: st.speed, roll: st.roll, pitch: st.pitch, sunVis: st.sunVis, shine: st.shine, aur: st.aurT };
    }
    expect(worst.phase).toBeLessThan(0.008);
    expect(worst.speed).toBeLessThan(0.03);
    expect(worst.roll).toBeLessThan(0.01);
    expect(worst.pitch).toBeLessThan(0.002);
    expect(worst.sunVis).toBeLessThan(0.01);
    expect(worst.shine).toBeLessThan(0.01);
    expect(worst.aurT).toBeLessThan(0.05);
    // The array joint never turns faster than its slew rate.
    expect(worst.arr).toBeLessThanOrEqual(ARR_SLEW * DT + 1e-9);
  });

  it("fires a puff and kicks the roll on a beat, one way for four beats and then the other", () => {
    const st = createStationState();
    const rng = createRng(1);
    const sides: number[] = [];
    let seen = 0;
    for (let i = 0; i < 600 && sides.length < 8; i++) {
      stepStation(st, sig({ beat: i % 30 === 0 ? 1 : 0 }), DT, true, rng);
      if (st.kicks > seen) {
        seen = st.kicks;
        sides.push(st.puffs[st.puffs.length - 1].side);
      }
    }
    expect(sides).toEqual([-1, -1, -1, 1, 1, 1, 1, -1]);
  });

  it("places the array joint on the sun at the first step", () => {
    const st = createStationState();
    expect(st.arr).toBeNull();
    stepStation(st, sig({}), DT, true, createRng(1));
    expect(st.arr).not.toBeNull();
  });

  it("gives no beat or motion reaction under Calm or while paused", () => {
    const quiet = createStationState();
    const calm = createStationState();
    const paused = createStationState();
    const rngs = [createRng(1), createRng(1), createRng(1)];
    for (let i = 0; i < 3600; i++) {
      const s = drop(i);
      stepStation(quiet, sig({ rms: s.rms, level: s.level, drive: 0 }), DT, true, rngs[0]);
      stepStation(calm, drop(i, 0), DT, true, rngs[1]);
      stepStation(paused, s, DT, false, rngs[2]);
    }
    for (const st of [calm, paused]) {
      expect(st.puffs).toHaveLength(0);
      expect(st.kicks).toBe(0);
      expect(st.roll).toBeLessThan(-0.3 + 0.06);
      expect(st.roll).toBeGreaterThan(-0.3 - 0.06);
      expect(st.pitch).toBe(0);
      expect(st.high).toBe(0);
      expect(uniforms(st)).toEqual(uniforms(quiet));
    }
    expect(calm.shine).toBe(quiet.shine);
  });

  it("settles back to rest after the drop", () => {
    const st = createStationState();
    const rng = createRng(1);
    for (let i = 0; i < 1800; i++) stepStation(st, drop(i), DT, true, rng);
    for (let i = 0; i < 150 * 60; i++) stepStation(st, sig({ rms: 0.8 }), DT, true, rng);
    expect(st.puffs).toHaveLength(0);
    expect(st.rollImp).toBeLessThan(1e-4);
    expect(Math.abs(st.roll + 0.3)).toBeLessThan(0.06);
    expect(Math.abs(st.rollV)).toBeLessThan(0.01);
    expect(Math.abs(st.pitch)).toBeLessThan(0.001);
    expect(st.speed).toBeCloseTo(1, 2);
    expect(st.aur).toBeLessThan(0.001);
    expect(st.high).toBeLessThan(0.001);
    expect(st.shine).toBeCloseTo(0.8, 2);
  });

  it("replays the same strikes for the same seed", () => {
    const run = (seed: number) => {
      const st = createStationState();
      const rng = createRng(seed);
      for (let i = 0; i < 3600; i++) stepStation(st, drop(i), DT, true, rng);
      return [...uniforms(st), st.storm?.u, st.storm?.v];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});
