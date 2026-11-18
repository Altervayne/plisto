// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createSolarFlareState, stepSolarFlare, type SolarFlareState } from "./solarFlare";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;
// The heat at the song's own mean.
const HEAT_REST = 0.45;
// The quiet stretch before the drop, in frames.
const QUIET = 900;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({ rms: 0.3, level: 0.5, swell: 0.1, bassMotion: 0, midMotion: 0, highMotion: 0, beat: 0, drive: LIVELY, ...over }) as VisualSignal;

/** A song at frame i: a quiet stretch, then a loud drop with every motion envelope and beat at the cap. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < QUIET) return sig({ drive });
  const m = i % BEAT_EVERY < 4 ? LIVELY : 0.4;
  return sig({ level: 1, swell: 0.5, bassMotion: m, midMotion: m, highMotion: m, beat: i % BEAT_EVERY === 0 ? 1.5 : 0, drive });
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: SolarFlareState) {
  return [
    st.heat, st.shine, st.churn, st.heave, st.flow, st.rainClk, st.stream, st.high, st.highClk,
    ...st.regA, ...st.regB, ...st.ropeA, ...st.ropeB, ...st.jet, ...st.quakeU, ...st.kink,
  ];
}

describe("stepSolarFlare", () => {
  it.each([
    ["Player", false],
    ["ambient", true],
  ])("reaches meaningful values and stays in range under Lively at the cap (%s)", (_name, ambient) => {
    const st = createSolarFlareState();
    const peak = { shine: 0, heat: 0, size: 0, rain: 0, rope: 0, quake: 0, jet: 0, kink: 0 };
    const low = { heat: 1, size: 9, rain: 1 };
    let maxJets = 0;
    let maxKinks = 0;
    for (let i = 0; i < 1800; i++) {
      stepSolarFlare(st, drop(i), DT, true, ambient);
      peak.shine = Math.max(peak.shine, st.shine);
      peak.heat = Math.max(peak.heat, st.heat);
      low.heat = Math.min(low.heat, st.heat);
      for (const g of st.regs) {
        peak.size = Math.max(peak.size, g.size);
        low.size = Math.min(low.size, g.size);
        peak.rain = Math.max(peak.rain, g.rain);
        low.rain = Math.min(low.rain, g.rain);
      }
      peak.rope = Math.max(peak.rope, st.ropeA[3]);
      peak.quake = Math.max(peak.quake, st.quakeU[3]);
      for (let k = 3; k < st.jet.length; k += 4) peak.jet = Math.max(peak.jet, st.jet[k]);
      for (let k = 1; k < st.kink.length; k += 2) peak.kink = Math.max(peak.kink, Math.abs(st.kink[k]));
      maxJets = Math.max(maxJets, st.jets.length);
      maxKinks = Math.max(maxKinks, st.kinks.length);
    }
    // The level reaches its cap and the drop heats the disc to white-gold without passing its ceiling.
    expect(peak.shine).toBeGreaterThan(0.9);
    expect(peak.heat).toBeGreaterThan(0.9);
    // The quiet stretch sits at the song's own mean, so the disc rests there and never cools below it.
    expect(low.heat).toBeGreaterThan(HEAT_REST - 0.01);
    expect(low.size).toBeGreaterThan(0.2);
    expect(peak.size).toBeLessThan(1.6);
    // The rain never dries below a hot passage's share, and a snap makes the arcade rain hard.
    expect(low.rain).toBeGreaterThan(0.2);
    expect(peak.rain).toBeGreaterThan(0.5);
    // The drop snaps an arcade: a rope leaves it and a blast wave runs over the surface.
    expect(peak.rope).toBeGreaterThan(0.3);
    expect(peak.rope).toBeLessThanOrEqual(1);
    expect(peak.quake).toBeGreaterThan(0.3);
    expect(peak.quake).toBeLessThanOrEqual(1);
    expect(peak.jet).toBeGreaterThan(0.9);
    expect(peak.jet).toBeLessThanOrEqual(1);
    expect(peak.kink).toBeGreaterThan(0.05);
    expect(peak.kink).toBeLessThanOrEqual(0.07 * 1.5);
    expect(maxJets).toBeLessThanOrEqual(4);
    expect(maxKinks).toBeLessThanOrEqual(3);
  });

  it.each([
    ["Player", false],
    ["ambient", true],
  ])("moves in small steps under Lively beats at the cap (%s)", (_name, ambient) => {
    const st = createSolarFlareState();
    const most = { heat: 0, shine: 0, size: 0, rain: 0, churn: 0, flow: 0 };
    let erupted = 0;
    for (let i = 0; i < 2400; i++) {
      const before = { heat: st.heat, shine: st.shine, size: st.regs.map((g) => g.size), rain: st.regs.map((g) => g.rain), churn: st.churn, flow: st.flow };
      const had = st.rope;
      stepSolarFlare(st, drop(i), DT, true, ambient);
      if (st.rope && st.rope !== had) erupted++;
      most.heat = Math.max(most.heat, Math.abs(st.heat - before.heat));
      most.shine = Math.max(most.shine, Math.abs(st.shine - before.shine));
      st.regs.forEach((g, k) => {
        most.size = Math.max(most.size, Math.abs(g.size - before.size[k]));
        most.rain = Math.max(most.rain, Math.abs(g.rain - before.rain[k]));
      });
      most.churn = Math.max(most.churn, st.churn - before.churn);
      most.flow = Math.max(most.flow, st.flow - before.flow);
    }
    expect(most.heat).toBeLessThan(0.01);
    expect(most.shine).toBeLessThan(0.02);
    // The arcade drops as it snaps, over half a second, never in one frame.
    expect(most.size).toBeLessThan(0.03);
    expect(most.rain).toBeLessThan(0.02);
    expect(most.churn).toBeLessThan(0.04);
    expect(most.flow).toBeLessThan(0.04);
    // No more than one eruption per nine seconds: the forty seconds hold four at most.
    expect(erupted).toBeGreaterThanOrEqual(2);
    expect(erupted).toBeLessThanOrEqual(4);
  });

  it("starts at the passage's heat when opened mid-song", () => {
    const loud = createSolarFlareState();
    const quiet = createSolarFlareState();
    stepSolarFlare(loud, drop(QUIET + 1), DT, true, false);
    stepSolarFlare(quiet, sig({ level: 0.2, swell: 0.05 }), DT, true, false);
    expect(loud.heat).toBeGreaterThan(0.95);
    expect(quiet.heat).toBeLessThan(HEAT_REST);
  });

  it("heats less at Balanced than at Lively on the same passage", () => {
    const balanced = createSolarFlareState();
    const lively = createSolarFlareState();
    let peakBalanced = 0;
    let peakLively = 0;
    for (let i = 0; i < 1800; i++) {
      stepSolarFlare(balanced, drop(i, 1), DT, true, false);
      stepSolarFlare(lively, drop(i), DT, true, false);
      peakBalanced = Math.max(peakBalanced, balanced.heat);
      peakLively = Math.max(peakLively, lively.heat);
    }
    expect(peakBalanced).toBeGreaterThan(HEAT_REST + 0.2);
    expect(peakBalanced).toBeLessThan(peakLively - 0.05);
  });

  it("finds the same heat after a long pause in a steady passage", () => {
    const st = createSolarFlareState();
    const steady = sig({ level: 0.8, swell: 0.3 });
    for (let i = 0; i < 300 * 60; i++) stepSolarFlare(st, steady, DT, true, false);
    const before = st.heat;
    // Paused, the follower lets the level and the swell fall to the resting arch.
    for (let i = 0; i < 60 * 60; i++) stepSolarFlare(st, sig({ level: 0.1, swell: 0.05 }), DT, false, false);
    for (let i = 0; i < 5 * 60; i++) stepSolarFlare(st, steady, DT, true, false);
    expect(Math.abs(st.heat - before)).toBeLessThan(0.03);
  });

  it("gives no beat or motion reaction under Calm or while paused", () => {
    const quiet = createSolarFlareState();
    const calm = createSolarFlareState();
    const paused = createSolarFlareState();
    for (let i = 0; i < 2400; i++) {
      const s = drop(i);
      stepSolarFlare(quiet, sig({ level: s.level, swell: s.swell, drive: 0 }), DT, true, false);
      stepSolarFlare(calm, drop(i, 0), DT, true, false);
      stepSolarFlare(paused, s, DT, false, false);
    }
    for (const st of [calm, paused]) {
      expect(st.jets).toHaveLength(0);
      expect(st.kinks).toHaveLength(0);
      expect(st.rope).toBeNull();
      expect(st.quake).toBeNull();
      expect(st.heat).toBe(HEAT_REST);
      expect(uniforms(st)).toEqual(uniforms(quiet));
    }
  });

  it("settles back to rest after the drop", () => {
    const st = createSolarFlareState();
    for (let i = 0; i < 2400; i++) stepSolarFlare(st, drop(i), DT, true, false);
    for (let i = 0; i < 600 * 60; i++) stepSolarFlare(st, sig({}), DT, true, false);
    expect(st.rope).toBeNull();
    expect(st.quake).toBeNull();
    expect(st.jets).toHaveLength(0);
    expect(st.kinks).toHaveLength(0);
    expect(st.heat).toBeCloseTo(HEAT_REST, 2);
    expect(st.stress).toBeCloseTo(0.7, 2);
    expect(st.bass).toBeLessThan(0.001);
    expect(st.mid).toBeLessThan(0.001);
    expect(st.high).toBeLessThan(0.001);
    for (const g of st.regs) {
      expect(g.fill).toBeCloseTo(1, 3);
      expect(g.wet).toBeLessThan(0.001);
      expect(g.rain).toBeCloseTo(0.22, 2);
    }
    expect(Math.max(...st.jet, ...st.kink, ...st.quakeU)).toBe(0);
  });

  it("replays the same frames for the same music", () => {
    const run = (ambient: boolean) => {
      const st = createSolarFlareState();
      for (let i = 0; i < 1800; i++) stepSolarFlare(st, drop(i), DT, true, ambient);
      return uniforms(st);
    };
    expect(run(false)).toEqual(run(false));
    expect(run(true)).not.toEqual(run(false));
  });
});
