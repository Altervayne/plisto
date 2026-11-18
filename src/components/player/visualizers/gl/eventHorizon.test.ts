// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import {
  CALM_I,
  CALM_PACE,
  CLUMP_SLOTS,
  MID_PACE,
  PACE_LIVELY,
  R_IN,
  R_OUT,
  TILT_BASE,
  TILT_BASS,
  WAVE_BASE,
  WAVE_MID,
  createEventHorizonState,
  stepEventHorizon,
  type EventHorizonState,
} from "./eventHorizon";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({ rms: 0.3, level: 0.3, swell: 0.1, bassMotion: 0, midMotion: 0, highMotion: 0, beat: 0, drive: LIVELY, ...over }) as VisualSignal;

/** A song at frame i: a quiet stretch, then a loud drop with every motion envelope and beat at the cap. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < 600) return sig({ rms: 0.15, level: 0.15, drive });
  const m = i % BEAT_EVERY < 4 ? LIVELY : 0.4;
  return sig({ rms: 0.8, level: 0.9, swell: 0.5, bassMotion: m, midMotion: m, highMotion: m, beat: i % BEAT_EVERY === 0 ? 1.5 : 0, drive });
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: EventHorizonState) {
  return [
    st.cam, st.spin, st.sky, st.tilt, st.prec, st.heat, st.dens, st.wave, st.wavePh, st.hot, ...st.hotA, st.shine,
    ...st.clump,
  ];
}

/** The shortest way round between two angles. */
function turn(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(d, Math.PI * 2 - d);
}

/** The total clump strength across the slots: slots reorder as clumps land and leave, the sum does not. */
function clumpSum(st: EventHorizonState): number {
  let sum = 0;
  for (let k = 2; k < st.clump.length; k += 4) sum += st.clump[k];
  return sum;
}

/** The largest frame-to-frame change of each uniform over the quiet stretch and the drop at `drive`. */
function worstSteps(drive: number) {
  const st = createEventHorizonState();
  const rng = createRng(2);
  stepEventHorizon(st, drop(0, drive), DT, true, rng);
  const keys = ["cam", "spin", "sky", "tilt", "prec", "heat", "dens", "wave", "wavePh", "hot", "shine"] as const;
  const most = { hotA: 0, clump: 0 } as Record<(typeof keys)[number] | "hotA" | "clump", number>;
  const prev = {} as Record<(typeof keys)[number], number>;
  for (const k of keys) {
    most[k] = 0;
    prev[k] = st[k];
  }
  const prevHotA = [...st.hotA];
  let prevClump = clumpSum(st);
  for (let i = 1; i < 1800; i++) {
    stepEventHorizon(st, drop(i, drive), DT, true, rng);
    for (const k of keys) {
      most[k] = Math.max(most[k], Math.abs(st[k] - prev[k]));
      prev[k] = st[k];
    }
    for (let h = 0; h < 3; h++) {
      most.hotA = Math.max(most.hotA, turn(st.hotA[h], prevHotA[h]));
      prevHotA[h] = st.hotA[h];
    }
    const sum = clumpSum(st);
    most.clump = Math.max(most.clump, Math.abs(sum - prevClump));
    prevClump = sum;
  }
  return most;
}

describe("stepEventHorizon", () => {
  it("keeps the envelopes in range and reaches them under Lively at the cap", () => {
    const st = createEventHorizonState();
    const rng = createRng(1);
    const lo = { heat: 1, cam: 1, shine: 1 };
    const hi = { heat: 0, cam: 0, shine: 0, speed: 0, tilt: 0, wave: 0, hot: 0, clump: 0, clumps: 0 };
    let clumpR = [Infinity, -Infinity];
    for (let i = 0; i < 1800; i++) {
      stepEventHorizon(st, drop(i), DT, true, rng);
      lo.heat = Math.min(lo.heat, st.heat, st.dens, st.I);
      lo.cam = Math.min(lo.cam, st.cam, st.weight);
      lo.shine = Math.min(lo.shine, st.shine);
      hi.heat = Math.max(hi.heat, st.heat, st.dens, st.I);
      hi.cam = Math.max(hi.cam, st.cam, st.weight);
      hi.shine = Math.max(hi.shine, st.shine);
      hi.speed = Math.max(hi.speed, st.speed);
      hi.tilt = Math.max(hi.tilt, st.tilt);
      hi.wave = Math.max(hi.wave, st.wave);
      hi.hot = Math.max(hi.hot, st.hot);
      hi.clumps = Math.max(hi.clumps, st.clumps.length);
      for (let k = 0; k < CLUMP_SLOTS; k++) {
        if (st.clump[k * 4 + 2] <= 0) continue;
        hi.clump = Math.max(hi.clump, st.clump[k * 4 + 2]);
        clumpR = [Math.min(clumpR[0], st.clump[k * 4]), Math.max(clumpR[1], st.clump[k * 4])];
      }
    }
    expect(lo.heat).toBeGreaterThanOrEqual(0);
    expect(lo.cam).toBeGreaterThanOrEqual(0);
    expect(lo.shine).toBeGreaterThanOrEqual(0);
    expect(hi.heat).toBeLessThanOrEqual(1);
    expect(hi.cam).toBeLessThanOrEqual(1);
    expect(hi.shine).toBeLessThanOrEqual(1);
    // The pace never passes the top of the Lively range with the mids at the cap.
    expect(hi.speed).toBeLessThanOrEqual(PACE_LIVELY[2] * (1 + MID_PACE * LIVELY));
    expect(hi.tilt).toBeLessThanOrEqual(TILT_BASE + TILT_BASS * LIVELY);
    expect(hi.wave).toBeLessThanOrEqual(WAVE_BASE + WAVE_MID * LIVELY);
    expect(hi.hot).toBeLessThanOrEqual(LIVELY);
    expect(hi.clumps).toBeLessThanOrEqual(CLUMP_SLOTS);
    expect(hi.clump).toBeLessThanOrEqual(1.5);
    // Clumps start in the outer disc and fall no further than the inner edge.
    expect(clumpR[0]).toBeGreaterThanOrEqual(R_IN * 1.05 - 1e-6);
    expect(clumpR[1]).toBeLessThanOrEqual(R_OUT * 0.75);
    // The drop does heat the gas, plunge the camera and whip the gas round.
    expect(hi.heat).toBeGreaterThan(0.8);
    expect(hi.cam).toBeGreaterThan(0.7);
    expect(hi.speed).toBeGreaterThan(1.8);
    expect(hi.clump).toBeGreaterThan(1);
  });

  it("moves in small steps under Lively beats at the cap", () => {
    const m = worstSteps(LIVELY);
    // The light (heat, density and shine) and the camera glide over seconds; the rest eases in under a tenth of a
    // second, and a clump gathers over CLUMP_RISE.
    expect(m.heat).toBeLessThan(0.01);
    expect(m.dens).toBeLessThan(0.01);
    expect(m.shine).toBeLessThan(0.006);
    expect(m.cam).toBeLessThan(0.01);
    expect(m.spin).toBeLessThan(0.07);
    expect(m.sky).toBeLessThan(0.001);
    expect(m.tilt).toBeLessThan(0.01);
    expect(m.prec).toBeLessThan(0.02);
    expect(m.wave).toBeLessThan(0.05);
    expect(m.wavePh).toBeLessThan(0.1);
    expect(m.hot).toBeLessThan(0.1);
    expect(m.hotA).toBeLessThan(0.11);
    expect(m.clump).toBeLessThan(0.1);
  });

  it("moves in smaller steps still under Calm", () => {
    const m = worstSteps(0);
    // Only the steady orbit turns; the shine follows the level as it does under any reactivity.
    expect(m.heat).toBe(0);
    expect(m.dens).toBe(0);
    expect(m.cam).toBe(0);
    expect(m.tilt).toBe(0);
    expect(m.wave).toBe(0);
    expect(m.hot).toBe(0);
    expect(m.clump).toBe(0);
    expect(m.shine).toBeLessThan(0.006);
    expect(m.spin).toBeLessThan(0.01);
    expect(m.sky).toBeLessThan(0.00015);
    expect(m.prec).toBeLessThan(0.0013);
    expect(m.wavePh).toBeLessThan(0.005);
    expect(m.hotA).toBeLessThan(0.021);
  });

  it("gives no beat or motion reaction under Calm or while paused", () => {
    const quiet = createEventHorizonState();
    const calm = createEventHorizonState();
    const paused = createEventHorizonState();
    const rngs = [createRng(3), createRng(3), createRng(3)];
    for (let i = 0; i < 1800; i++) {
      const s = drop(i);
      stepEventHorizon(quiet, sig({ level: s.level, swell: s.swell, drive: 0 }), DT, true, rngs[0]);
      stepEventHorizon(calm, drop(i, 0), DT, true, rngs[1]);
      stepEventHorizon(paused, s, DT, false, rngs[2]);
    }
    expect(calm.clumps).toHaveLength(0);
    expect(paused.clumps).toHaveLength(0);
    expect(uniforms(calm)).toEqual(uniforms(quiet));
    expect(uniforms(paused)).toEqual(uniforms(quiet));
    // A steady mid intensity and the Calm pace.
    expect(quiet.heat).toBeCloseTo(CALM_I, 9);
    expect(quiet.speed).toBeCloseTo(CALM_PACE, 9);
  });

  it("holds the song's mean through a pause, so the intensity resumes where it was", () => {
    const st = createEventHorizonState();
    const rng = createRng(6);
    const steady = sig({ level: 0.5, swell: 0.3 });
    for (let i = 0; i < 60 * 60; i++) stepEventHorizon(st, steady, DT, true, rng);
    const before = st.I;
    // Paused, the follower's level falls to its resting arch.
    for (let i = 0; i < 120 * 60; i++) stepEventHorizon(st, sig({ level: 0.2, swell: 0.1 }), DT, false, rng);
    for (let i = 0; i < 5 * 60; i++) stepEventHorizon(st, steady, DT, true, rng);
    expect(Math.abs(st.I - before)).toBeLessThan(0.005);
  });

  it("keeps tracking the song's mean under Calm", () => {
    const st = createEventHorizonState();
    const rng = createRng(6);
    for (let i = 0; i < 150 * 60; i++) stepEventHorizon(st, sig({ level: 0.5, drive: 0 }), DT, true, rng);
    expect(st.slow).toBeCloseTo(0.5, 3);
  });

  it("starts in the passage's state on its first step", () => {
    const st = createEventHorizonState();
    stepEventHorizon(st, drop(900), DT, true, createRng(4));
    // Every eased value starts at its target: no glide in from the defaults.
    expect(st.heat).toBe(st.I);
    expect(st.dens).toBe(st.I);
    expect(st.shine).toBeCloseTo(1 - Math.exp(-0.9 * 3.2), 9);
    expect(st.I).toBeGreaterThan(0.7);
  });

  it("settles back to rest once the music holds steady", () => {
    const st = createEventHorizonState();
    const rng = createRng(5);
    for (let i = 0; i < 1800; i++) stepEventHorizon(st, drop(i), DT, true, rng);
    expect(st.clumps.length).toBeGreaterThan(0);
    // Beats and motion stop, and the level holds at the song's slow mean.
    const steady = sig({ level: st.slow, swell: 0.3 });
    for (let i = 0; i < 90 * 60; i++) stepEventHorizon(st, steady, DT, true, rng);
    expect(st.clumps).toHaveLength(0);
    expect(st.clump.every((v) => v === 0)).toBe(true);
    expect(st.tilt - TILT_BASE).toBeLessThan(1e-3);
    expect(st.wave - WAVE_BASE).toBeLessThan(1e-3);
    expect(st.hot).toBeLessThan(1e-3);
    expect(Math.abs(st.heat - st.I)).toBeLessThan(1e-3);
    expect(Math.abs(st.vel)).toBeLessThan(1e-3);
  });

  it("replays the same clumps from the same seed", () => {
    const run = (seed: number) => {
      const st = createEventHorizonState();
      const rng = createRng(seed);
      const seen: number[] = [];
      for (let i = 0; i < 1500; i++) {
        stepEventHorizon(st, drop(i), DT, true, rng);
        if (i % 30 === 0) seen.push(...st.clump);
      }
      return seen;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});
