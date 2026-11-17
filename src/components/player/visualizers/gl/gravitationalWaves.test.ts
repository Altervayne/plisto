// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  CALM_PACE,
  CREST_LIFE,
  MID_PACE,
  OMEGA,
  RANGE_LIVELY,
  WAVE_BASE,
  WAVE_BASS,
  WAVE_K,
  WAVE_REL,
  WELL_BASE,
  WELL_BASS,
  createGravitationalWavesState,
  stepGravitationalWaves,
  type GravitationalWavesState,
} from "./gravitationalWaves";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({ rms: 0.3, level: 0.5, bassMotion: 0, midMotion: 0, highMotion: 0, beat: 0, drive: LIVELY, ...over }) as VisualSignal;

/** A song at frame i: a quiet stretch, then a loud drop with every motion envelope and beat at the cap. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < 600) return sig({ rms: 0.15, drive });
  const m = i % BEAT_EVERY < 4 ? LIVELY : 0.4;
  return sig({ rms: 0.8, level: 1, bassMotion: m, midMotion: m, highMotion: m, beat: i % BEAT_EVERY === 0 ? 1.5 : 0, drive });
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: GravitationalWavesState) {
  return [st.phi, st.radius, st.waveA, st.well, st.spin, st.turb, st.high, ...st.crest, ...st.knot];
}

describe("stepGravitationalWaves", () => {
  it("keeps the envelopes in range under Lively at the cap", () => {
    const st = createGravitationalWavesState();
    for (let i = 0; i < 1800; i++) {
      stepGravitationalWaves(st, drop(i), DT, true);
      expect(st.shine).toBeGreaterThanOrEqual(0);
      expect(st.shine).toBeLessThanOrEqual(1);
      expect(st.turb).toBeLessThanOrEqual(LIVELY);
      expect(st.high).toBeLessThanOrEqual(LIVELY);
      expect(st.radius).toBeGreaterThanOrEqual(0.9);
      expect(st.radius).toBeLessThanOrEqual(1);
      expect(st.speed).toBeGreaterThanOrEqual(0.3);
      expect(st.crests.length).toBeLessThanOrEqual(4);
      for (let k = 1; k < st.crest.length; k += 2) expect(st.crest[k]).toBeLessThanOrEqual(1.5);
      expect(st.knot[1]).toBeLessThanOrEqual(1.2);
    }
  });

  it("moves in small steps under Lively beats at the cap", () => {
    const st = createGravitationalWavesState();
    let prev = { speed: st.speed, waveA: st.waveA, well: st.well, radius: st.radius };
    let maxSpeed = 0;
    for (let i = 0; i < 1800; i++) {
      const phi = st.phi;
      stepGravitationalWaves(st, drop(i), DT, true);
      expect(st.phi - phi).toBeLessThan(0.12);
      expect(Math.abs(st.speed - prev.speed)).toBeLessThan(0.02);
      expect(Math.abs(st.waveA - prev.waveA)).toBeLessThan(0.01);
      expect(Math.abs(st.well - prev.well)).toBeLessThan(0.015);
      expect(Math.abs(st.radius - prev.radius)).toBeLessThan(0.005);
      prev = { speed: st.speed, waveA: st.waveA, well: st.well, radius: st.radius };
      maxSpeed = Math.max(maxSpeed, st.speed);
    }
    // The drop does whip the pair round.
    expect(maxSpeed).toBeGreaterThan(1.8);
  });

  it("gives no beat or motion reaction under Calm or while paused", () => {
    const quiet = createGravitationalWavesState();
    const calm = createGravitationalWavesState();
    const paused = createGravitationalWavesState();
    for (let i = 0; i < 1800; i++) {
      const s = drop(i);
      stepGravitationalWaves(quiet, sig({ rms: s.rms, level: s.level, drive: 0 }), DT, true);
      stepGravitationalWaves(calm, drop(i, 0), DT, true);
      stepGravitationalWaves(paused, s, DT, false);
    }
    expect(calm.crests).toHaveLength(0);
    expect(paused.crests).toHaveLength(0);
    expect(uniforms(calm)).toEqual(uniforms(quiet));
    expect(uniforms(paused)).toEqual(uniforms(quiet));
    expect(calm.shine).toBe(quiet.shine);
  });

  it("keeps the wave, the wells and the crests inside what the step and shader assume", () => {
    const st = createGravitationalWavesState();
    // The pace never passes the top of the Lively range with the mids at the cap.
    const topSpeed = RANGE_LIVELY[1] * (1 + MID_PACE * LIVELY);
    const reach = 1.1 + ((2 * OMEGA * topSpeed) / WAVE_K) * CREST_LIFE;
    let sawWave = 0;
    let sawWell = 0;
    for (let i = 0; i < 3600; i++) {
      stepGravitationalWaves(st, drop(i), DT, true);
      // Relative energy is clamped to 1, the bass envelope to the cap.
      expect(st.waveA).toBeGreaterThanOrEqual(WAVE_BASE);
      expect(st.waveA).toBeLessThanOrEqual(WAVE_BASE + (WAVE_REL + WAVE_BASS) * LIVELY);
      expect(st.well).toBeGreaterThanOrEqual(WELL_BASE);
      expect(st.well).toBeLessThanOrEqual(WELL_BASE + WELL_BASS * LIVELY);
      expect(st.speed).toBeLessThanOrEqual(topSpeed);
      for (const k of st.crests) {
        expect(k.age).toBeLessThan(CREST_LIFE);
        expect(k.r).toBeGreaterThanOrEqual(0.9 * 1.1);
        expect(k.r).toBeLessThanOrEqual(reach);
      }
      sawWave = Math.max(sawWave, st.waveA);
      sawWell = Math.max(sawWell, st.well);
    }
    // The bounds are reached, so they are not vacuous.
    expect(sawWave).toBeGreaterThan(WAVE_BASE + 0.1);
    expect(sawWell).toBeGreaterThan(WELL_BASE + 0.05);
  });

  it("cruises at OMEGA * CALM_PACE under Calm and while paused", () => {
    const calm = createGravitationalWavesState();
    const paused = createGravitationalWavesState();
    const start = calm.phi;
    for (let i = 0; i < 4 * 60; i++) {
      const before = [calm.phi, paused.phi];
      stepGravitationalWaves(calm, drop(i, 0), DT, true);
      stepGravitationalWaves(paused, drop(i), DT, false);
      expect(calm.phi - before[0]).toBeCloseTo(OMEGA * CALM_PACE * DT, 9);
      expect(paused.phi - before[1]).toBeCloseTo(OMEGA * CALM_PACE * DT, 9);
    }
    expect(calm.phi - start).toBeCloseTo(OMEGA * CALM_PACE * 4, 6);
    expect(paused.phi - start).toBeCloseTo(OMEGA * CALM_PACE * 4, 6);
  });

  it("settles back to rest within SETTLE seconds once the music holds steady", () => {
    const st = createGravitationalWavesState();
    for (let i = 0; i < 1800; i++) stepGravitationalWaves(st, drop(i), DT, true);
    expect(st.crests.length).toBeGreaterThan(0);
    expect(st.speed).toBeGreaterThan(1.3);
    // Beats and motion stop, and the energy holds at its slow mean. The quick measure closes the gap in about 8 s,
    // the pace spring (about 0.7 per s, critically damped) takes about 13 s more, and a crest lives CREST_LIFE.
    const steady = sig({ rms: st.slow });
    const SETTLE = 40;
    for (let i = 0; i < SETTLE * 60; i++) stepGravitationalWaves(st, steady, DT, true);
    expect(st.crests).toHaveLength(0);
    expect(st.knot[1]).toBe(0);
    expect(Math.abs(st.speed - 1)).toBeLessThan(1e-3);
    expect(1 - st.radius).toBeLessThan(1e-3);
    expect(st.waveA - WAVE_BASE).toBeLessThan(1e-3);
    expect(st.well - WELL_BASE).toBeLessThan(1e-3);
    expect(st.turb).toBeLessThan(1e-3);
    expect(st.high).toBeLessThan(1e-3);
  });
});
