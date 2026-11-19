// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  CALM_PACE,
  CREST_LIFE,
  LURCH_PACE,
  OMEGA,
  PACE_BODY_LIVELY,
  PACE_MAX,
  PACE_QUIET,
  PUSH_PACE,
  CREST_SUM_MAX,
  SURGE_MAX,
  WAVE_BASS,
  WAVE_K,
  WAVE_LOUD,
  WAVE_QUIET,
  WELL_BASE,
  WELL_BASS,
  createGravitationalWavesState,
  paceKnee,
  stepGravitationalWaves,
  type GravitationalWavesState,
} from "./gravitationalWaves";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;
// A beat's weight is held for about 0.1 s.
const HELD = 6;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({
    rms: 0.3,
    level: 0.5,
    loudness: 0.5,
    bassMotion: 0,
    midMotion: 0,
    highMotion: 0,
    beat: 0,
    beatWeight: 0,
    surge: 0,
    cut: 0,
    drive: LIVELY,
    ...over,
  }) as VisualSignal;

/** A song at frame i: a quiet stretch, then a loud drop with every motion envelope and beat at the cap. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < 600) return sig({ rms: 0.15, loudness: 0.1, drive });
  const m = i % BEAT_EVERY < 4 ? LIVELY : 0.4;
  const held = i % BEAT_EVERY < HELD;
  return sig({
    rms: 0.8,
    level: 1,
    loudness: 0.9,
    bassMotion: m,
    midMotion: m,
    highMotion: m,
    beat: i % BEAT_EVERY === 0 ? 1.5 : 0,
    beatWeight: held ? 1.2 : 0,
    drive,
  });
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: GravitationalWavesState) {
  return [st.phi, st.radius, st.waveA, st.well, st.spin, st.turb, st.high, ...st.crest, ...st.knot];
}

/** Holds a signal for seconds and returns the state and the pace of the last frame in rad/s. */
function hold(over: Partial<VisualSignal>, seconds = 20): { st: GravitationalWavesState; omega: number } {
  const st = createGravitationalWavesState();
  let omega = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const phi = st.phi;
    stepGravitationalWaves(st, sig({ rms: 0.3, ...over }), DT, true);
    omega = (st.phi - phi) / DT;
  }
  return { st, omega };
}

/** One beat at the given weight on a held loudness: the tallest crest it leaves after its hold. */
function beatCrest(weight: number, loudness = 0.9): number {
  const st = createGravitationalWavesState();
  for (let i = 0; i < 120; i++) stepGravitationalWaves(st, sig({ loudness }), DT, true);
  for (let i = 0; i < HELD + 6; i++) {
    const over = i === 0 ? { beat: 1.5, beatWeight: weight } : { beatWeight: i < HELD ? weight : 0 };
    stepGravitationalWaves(st, sig({ loudness, ...over }), DT, true);
  }
  return st.crests.reduce((m, k) => Math.max(m, k.h), 0);
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
      expect(st.speed).toBeGreaterThanOrEqual(0.05);
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
      expect(st.phi - phi).toBeGreaterThan(0);
      expect(st.phi - phi).toBeLessThan(0.14);
      expect(Math.abs(st.speed - prev.speed)).toBeLessThan(0.04);
      expect(Math.abs(st.waveA - prev.waveA)).toBeLessThan(0.012);
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
      stepGravitationalWaves(quiet, sig({ rms: s.rms, level: s.level, loudness: s.loudness, drive: 0 }), DT, true);
      stepGravitationalWaves(calm, { ...drop(i, 0), surge: i % 300 === 0 ? 1 : 0, cut: i % 300 === 150 ? 1 : 0 }, DT, true);
      stepGravitationalWaves(paused, { ...s, surge: i % 300 === 0 ? 1 : 0 }, DT, false);
    }
    expect(calm.crests).toHaveLength(0);
    expect(paused.crests).toHaveLength(0);
    expect(uniforms(calm)).toEqual(uniforms(quiet));
    expect(uniforms(paused)).toEqual(uniforms(quiet));
    expect(calm.shine).toBe(quiet.shine);
  });

  it("keeps the wave, the wells and the crests inside what the step and shader assume", () => {
    const st = createGravitationalWavesState();
    const reach = 1.1 + ((2 * OMEGA * PACE_MAX) / WAVE_K) * CREST_LIFE;
    let sawPace = 0;
    let sawWave = 0;
    let sawWell = 0;
    for (let i = 0; i < 3600; i++) {
      stepGravitationalWaves(st, drop(i), DT, true);
      expect(st.waveA).toBeGreaterThanOrEqual(WAVE_QUIET);
      expect(st.waveA).toBeLessThanOrEqual(WAVE_LOUD + WAVE_BASS * LIVELY);
      expect(st.well).toBeGreaterThanOrEqual(WELL_BASE);
      expect(st.well).toBeLessThanOrEqual(WELL_BASE + WELL_BASS * LIVELY);
      expect(st.pace).toBeLessThanOrEqual(PACE_MAX);
      sawPace = Math.max(sawPace, st.pace);
      for (const k of st.crests) {
        expect(k.age).toBeLessThan(CREST_LIFE);
        expect(k.r).toBeGreaterThanOrEqual(0.9 * 1.1);
        expect(k.r).toBeLessThanOrEqual(reach);
      }
      sawWave = Math.max(sawWave, st.waveA);
      sawWell = Math.max(sawWell, st.well);
    }
    // The bounds are reached, so they are not vacuous.
    expect(sawWave).toBeGreaterThan(WAVE_LOUD + 0.05);
    expect(sawWell).toBeGreaterThan(WELL_BASE + 0.05);
    expect(sawPace).toBeGreaterThan(0.95 * PACE_MAX);
  });

  it("eases the pace into PACE_MAX, so the wave arms pass a point under three times a second", () => {
    let prev = 0;
    for (let p = 0; p < 20; p += 0.01) {
      const k = paceKnee(p);
      expect(k).toBeGreaterThanOrEqual(prev);
      expect(k).toBeLessThanOrEqual(PACE_MAX);
      expect(k - prev).toBeLessThanOrEqual(0.01 + 1e-9);
      prev = k;
    }
    expect(paceKnee(1)).toBe(1);
    // A Lively drop with surges at their cap on top of full-weight kicks: two arms turning at twice the orbit
    // pass a point twice per turn of the pattern, so the arm rate is 2 * omega / (2 pi) a second.
    const st = createGravitationalWavesState();
    let fastest = 0;
    for (let i = 0; i < 3600; i++) {
      const phi = st.phi;
      stepGravitationalWaves(st, { ...drop(i), surge: i >= 600 && i % 300 === 0 ? 1 : 0 }, DT, true);
      const omega = (st.phi - phi) / DT;
      expect(st.pace).toBeLessThanOrEqual(PACE_MAX);
      expect((2 * omega) / (2 * Math.PI)).toBeLessThan(3);
      fastest = Math.max(fastest, omega);
    }
    expect(fastest).toBeGreaterThan(0.95 * OMEGA * PACE_MAX);
  });

  it("resumes at the pace it paused on, with no swing from the paused loudness", () => {
    const st = createGravitationalWavesState();
    const loud = sig({ loudness: 0.85, drive: 1 });
    for (let i = 0; i < 40 * 60; i++) stepGravitationalWaves(st, loud, DT, true);
    const before = st.pace;
    // Paused, the follower's loudness sinks toward the resting arch.
    for (let i = 0; i < 25 * 60; i++) stepGravitationalWaves(st, sig({ loudness: 0.3, drive: 1 }), DT, false);
    let peak = 0;
    for (let i = 0; i < 10 * 60; i++) {
      stepGravitationalWaves(st, loud, DT, true);
      peak = Math.max(peak, st.pace);
    }
    expect(peak).toBeLessThan(1.02 * before);
    expect(Math.abs(st.pace - before)).toBeLessThan(0.01 * before);
  });

  it("eases the pace across a reactivity switch mid-song instead of stepping it", () => {
    const loud = (drive: number) => sig({ loudness: 0.85, drive });
    const cases: [number, number][] = [
      [0, LIVELY],
      [1, LIVELY],
      [LIVELY, 0],
    ];
    for (const [from, to] of cases) {
      const st = createGravitationalWavesState();
      for (let i = 0; i < 30 * 60; i++) stepGravitationalWaves(st, loud(from), DT, true);
      const steady = createGravitationalWavesState();
      for (let i = 0; i < 30 * 60; i++) stepGravitationalWaves(steady, loud(to), DT, true);
      expect(Math.abs(steady.pace - st.pace)).toBeGreaterThan(0.15);
      let prev = st.pace;
      for (let i = 0; i < 5 * 60; i++) {
        stepGravitationalWaves(st, loud(to), DT, true);
        expect(Math.abs(st.pace - prev)).toBeLessThan(i === 0 ? 0.01 : 0.04);
        prev = st.pace;
      }
      // The switch does reach the new pace.
      expect(Math.abs(st.pace - steady.pace)).toBeLessThan(0.01);
    }
  });

  it("keeps the tallest crest on the loudest wave inside the surface solver's bracket", () => {
    // The shader's lift: env * (wave * min(waveA + CREST_A * crest, WAVE_MAX) + 0.35 * CREST_A * crest), wave in -1..1.
    const CREST_A = 0.08;
    const WAVE_MAX = 0.22;
    // The funnel march starts this far above the rest height; the off-funnel solve starts 0.3 above.
    const BRACKET_UP = 0.25;
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    // The widest envelope over the radii a crest can reach, at the tightest orbit.
    let env = 0;
    for (let r = 0.9; r < 40; r += 0.01) env = Math.max(env, smooth(0.45, 1.53, r) / (1 + 0.15 * r));
    const waveA = WAVE_LOUD + WAVE_BASS * LIVELY;
    const lift = (crest: number) => env * (Math.min(waveA + CREST_A * crest, WAVE_MAX) + 0.35 * CREST_A * crest);
    // A surge at the cap overlapping a full-weight beat crest: the shader caps the sum at CREST_SUM_MAX.
    expect(lift(Math.min(SURGE_MAX + 1.5, CREST_SUM_MAX))).toBeLessThan(BRACKET_UP);
    // The cap leaves a single surge crest its full height.
    expect(CREST_SUM_MAX).toBeGreaterThanOrEqual(SURGE_MAX);
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

  it("settles back to its quiet state within SETTLE seconds once the music falls silent", () => {
    const st = createGravitationalWavesState();
    for (let i = 0; i < 1800; i++) stepGravitationalWaves(st, drop(i), DT, true);
    expect(st.crests.length).toBeGreaterThan(0);
    expect(st.speed).toBeGreaterThan(1.3);
    // Beats and motion stop at near-silence; a crest lives CREST_LIFE.
    const steady = sig({ loudness: 0.05 });
    const SETTLE = 40;
    for (let i = 0; i < SETTLE * 60; i++) stepGravitationalWaves(st, steady, DT, true);
    expect(st.crests).toHaveLength(0);
    expect(st.knot[1]).toBe(0);
    expect(Math.abs(st.speed - PACE_QUIET)).toBeLessThan(1e-3);
    expect(1 - st.radius).toBeLessThan(1e-3);
    expect(st.waveA - WAVE_QUIET).toBeLessThan(1e-3);
    expect(st.well - WELL_BASE).toBeLessThan(1e-3);
    expect(st.turb).toBeLessThan(1e-3);
    expect(st.high).toBeLessThan(1e-3);
  });

  it("turns many times slower in near silence than in a loud passage, and the wave is fainter", () => {
    const silent = hold({ loudness: 0.05 });
    const intro = hold({ loudness: 0.3 });
    const mid = hold({ loudness: 0.6 });
    const loud = hold({ loudness: 0.9 });
    expect(silent.omega).toBeCloseTo(OMEGA * PACE_QUIET, 3);
    expect(silent.omega).toBeLessThan(0.15 * OMEGA);
    expect(intro.omega).toBeGreaterThan(silent.omega);
    expect(intro.omega).toBeLessThan(0.5 * OMEGA);
    expect(mid.omega).toBeGreaterThan(intro.omega);
    // A steady loud passage sits at the body pace: the swing reads the music against its own level.
    expect(loud.omega).toBeCloseTo(OMEGA * PACE_BODY_LIVELY, 2);
    expect(loud.omega / silent.omega).toBeGreaterThan(10);
    expect(silent.st.waveA).toBeCloseTo(WAVE_QUIET, 3);
    expect(loud.st.waveA).toBeGreaterThanOrEqual(WAVE_LOUD * 0.99);
    expect(loud.st.waveA / silent.st.waveA).toBeGreaterThan(5);
  });

  it("speeds up as a loud passage builds and settles once the build holds, without a beat", () => {
    const st = createGravitationalWavesState();
    const run = (loudness: number, seconds: number) => {
      let omega = 0;
      for (let i = 0; i < seconds * 60; i++) {
        const phi = st.phi;
        stepGravitationalWaves(st, sig({ loudness }), DT, true);
        omega = (st.phi - phi) / DT;
      }
      return omega;
    };
    const verse = run(0.8, 40);
    const build = run(0.88, 2);
    expect(build).toBeGreaterThan(1.5 * verse);
    const held = run(0.88, 60);
    expect(held).toBeLessThan(0.75 * build);
    // A calmer stretch at the same loudness band turns slower than the verse did.
    expect(run(0.74, 3)).toBeLessThan(0.75 * verse);
  });

  it("pushes the orbit on a strong kick and eases the push out", () => {
    const st = createGravitationalWavesState();
    const loud = sig({ loudness: 0.85 });
    for (let i = 0; i < 40 * 60; i++) stepGravitationalWaves(st, loud, DT, true);
    const rest = st.pace;
    let peak = rest;
    let prev = rest;
    for (let i = 0; i < 90; i++) {
      const over = i === 0 ? { beat: 1.5, beatWeight: LIVELY } : { beatWeight: i < HELD ? LIVELY : 0 };
      stepGravitationalWaves(st, sig({ loudness: 0.85, ...over }), DT, true);
      // Eased in: the push starts gently and then ramps, never a step.
      expect(Math.abs(st.pace - prev)).toBeLessThan((i === 0 ? 0.08 : 0.15) * rest);
      prev = st.pace;
      if (i < 20) peak = Math.max(peak, st.pace);
    }
    expect(peak).toBeGreaterThan(rest * (1 + 0.5 * PUSH_PACE * LIVELY));
    // The kick also lifts the intensity for a moment, so the pace is back at rest a few seconds later.
    for (let i = 0; i < 6 * 60; i++) stepGravitationalWaves(st, loud, DT, true);
    expect(Math.abs(st.pace - rest)).toBeLessThan(0.05 * rest);
  });

  it("sizes a crest by the beat's weight and launches none for a beat in a quiet passage", () => {
    const full = beatCrest(1.2);
    const kickless = beatCrest(0.4);
    expect(full).toBeGreaterThan(kickless);
    expect(kickless).toBeGreaterThan(0.3);
    expect(full).toBeLessThanOrEqual(1.5);
    expect(beatCrest(0.02, 0.2)).toBe(0);
  });

  it("raises a crest's height when the weight climbs during the hold", () => {
    const st = createGravitationalWavesState();
    stepGravitationalWaves(st, sig({ beat: 1.5, beatWeight: 0.3 }), DT, true);
    stepGravitationalWaves(st, sig({ beatWeight: 0.9 }), DT, true);
    for (let i = 0; i < HELD; i++) stepGravitationalWaves(st, sig({}), DT, true);
    expect(st.crests).toHaveLength(1);
    expect(st.crests[0].h).toBeCloseTo(0.9, 6);
  });

  it("sends one great wave and lurches the pair on a surge", () => {
    const st = createGravitationalWavesState();
    for (let i = 0; i < 600; i++) stepGravitationalWaves(st, sig({ loudness: 0.9 }), DT, true);
    const before = st.speed;
    stepGravitationalWaves(st, sig({ loudness: 0.9, surge: 1 }), DT, true);
    const great = st.crests[st.crests.length - 1];
    expect(great.h).toBeGreaterThan(1.5);
    expect(great.h).toBeLessThanOrEqual(SURGE_MAX);
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      stepGravitationalWaves(st, sig({ loudness: 0.9 }), DT, true);
      peak = Math.max(peak, st.speed);
    }
    expect(peak).toBeGreaterThan(before * (1 + 0.5 * LURCH_PACE));
  });

  it("sinks the turning and the waves within about half a second of a cut", () => {
    const st = createGravitationalWavesState();
    for (let i = 0; i < 600; i++) stepGravitationalWaves(st, sig({ loudness: 0.9 }), DT, true);
    const speed = st.speed;
    const wave = st.waveA;
    for (let i = 0; i < 30; i++) stepGravitationalWaves(st, sig({ loudness: 0.3, cut: i === 0 ? 1 : 0 }), DT, true);
    expect(st.speed).toBeLessThan(0.6 * speed);
    expect(st.waveA).toBeLessThan(0.6 * wave);
    expect(st.speed).toBeGreaterThan(0);
  });
});
