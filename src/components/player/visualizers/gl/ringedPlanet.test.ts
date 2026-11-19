// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { createRingedPlanetState, stepRingedPlanet, type RingedPlanetState } from "./ringedPlanet";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;
// The oval size range: relative energy at -1 and +1, with the bass at its cap, at Lively.
const OVAL_SIZE_MIN = 1 - 0.2 * LIVELY;
const OVAL_SIZE_MAX = 1 + 0.2 * LIVELY + 0.18 * LIVELY;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({
    rms: 0.3, level: 0.5, loudness: 0.3, bassMotion: 0, midMotion: 0, highMotion: 0, beat: 0, beatWeight: 0,
    bassHit: 0, midHit: 0, highHit: 0, surge: 0, cut: 0, drive: LIVELY, ...over,
  }) as VisualSignal;

/** A song at frame i: a quiet stretch, then a loud drop with every motion envelope, beat and hit at the cap. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < 600) return sig({ rms: 0.15, drive });
  const k = i % BEAT_EVERY;
  const m = k < 4 ? LIVELY : 0.4;
  return sig({
    rms: 0.8,
    level: 1,
    loudness: 0.85,
    bassMotion: m,
    midMotion: m,
    highMotion: m,
    beat: k === 0 ? 1.5 : 0,
    beatWeight: k < 6 ? 1 : 0,
    highHit: k < 3 ? 1 : 0,
    surge: i === 900 ? 1 : 0,
    cut: i === 1300 ? 1 : 0,
    drive,
  });
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: RingedPlanetState) {
  const h = st.head;
  return [
    st.orb, st.spin, st.jetPh, st.pat, st.dw, st.bend, st.bendPh, st.warp, st.warpPh, st.comp, st.spoke, st.high,
    st.ovWind, st.shear, st.fineT, st.fineA, h.lon, h.str, h.boil, st.beatEnv, st.surgeEnv, st.spark, st.sparkPh,
    ...st.crest, ...st.oval, ...st.wake, ...st.puff,
  ];
}

/** One kick of the given weight on a rested planet, then the crests' heights each frame for a second. */
function kick(weight: number, frames = 60): { peak: number; heights: number[]; st: RingedPlanetState } {
  const st = createRingedPlanetState();
  const rng = createRng(1);
  for (let i = 0; i < 120; i++) stepRingedPlanet(st, sig({}), DT, true, rng);
  const heights: number[] = [];
  for (let i = 0; i < frames; i++) {
    const held = i < 6;
    stepRingedPlanet(st, sig({ beat: i === 0 ? 1 : 0, beatWeight: held ? weight : 0 }), DT, true, rng);
    let sum = 0;
    for (let k = 1; k < st.crest.length; k += 2) sum += st.crest[k];
    heights.push(sum);
  }
  return { peak: Math.max(...heights), heights, st };
}

/** Steps the drop until an outbreak is burning with some strength; false when none starts. */
function burn(st: RingedPlanetState, rng: () => number): boolean {
  for (let i = 0; i < 1800; i++) {
    stepRingedPlanet(st, drop(i), DT, true, rng);
    if (st.head.on && st.head.str > 0.4) return true;
  }
  return false;
}

describe("stepRingedPlanet", () => {
  it("reaches meaningful values and stays in range under Lively at the cap", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    const peak = { shine: 0, high: 0, fineA: 0, ovSize: 0, headStr: 0, wake: 0, crest: 0, puff: 0 };
    for (let i = 0; i < 1800; i++) {
      stepRingedPlanet(st, drop(i), DT, true, rng);
      expect(st.shine).toBeGreaterThanOrEqual(0);
      expect(st.speed).toBeGreaterThanOrEqual(0.3);
      expect(st.ovSize).toBeGreaterThanOrEqual(OVAL_SIZE_MIN);
      expect(st.ovSize).toBeLessThanOrEqual(OVAL_SIZE_MAX);
      expect(st.crests.length).toBeLessThanOrEqual(4);
      expect(st.puffs.length).toBeLessThanOrEqual(4);
      peak.shine = Math.max(peak.shine, st.shine);
      peak.high = Math.max(peak.high, st.high);
      peak.fineA = Math.max(peak.fineA, st.fineA);
      peak.ovSize = Math.max(peak.ovSize, st.ovSize);
      peak.headStr = Math.max(peak.headStr, st.head.str);
      peak.wake = Math.max(peak.wake, ...st.wake);
      for (let k = 1; k < st.crest.length; k += 2) peak.crest = Math.max(peak.crest, st.crest[k]);
      for (let k = 3; k < st.puff.length; k += 4) peak.puff = Math.max(peak.puff, st.puff[k]);
    }
    // The level reaches its cap and the drop drives every channel well up without passing its ceiling.
    expect(peak.shine).toBeGreaterThan(0.9);
    expect(peak.shine).toBeLessThanOrEqual(1);
    expect(peak.high).toBeGreaterThan(0.5);
    expect(peak.high).toBeLessThanOrEqual(LIVELY);
    expect(peak.fineA).toBeGreaterThan(0.5);
    expect(peak.fineA).toBeLessThanOrEqual(LIVELY);
    expect(peak.ovSize).toBeGreaterThan(1.2);
    expect(peak.headStr).toBeGreaterThan(0.6);
    expect(peak.headStr).toBeLessThanOrEqual(1.4);
    expect(peak.wake).toBeGreaterThan(0.5);
    expect(peak.wake).toBeLessThanOrEqual(1.4);
    expect(peak.crest).toBeGreaterThan(0.5);
    expect(peak.crest).toBeLessThanOrEqual(1.1);
    expect(peak.puff).toBeGreaterThan(0.2);
    expect(peak.puff).toBeLessThanOrEqual(0.9);
  });

  it("moves in small steps under Lively beats at the cap", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    let prev = { speed: st.speed, bend: st.bend, warp: st.warp, comp: st.comp, dw: st.dw, size: st.ovSize };
    let maxSpeed = 0;
    for (let i = 0; i < 1800; i++) {
      const orb = st.orb;
      stepRingedPlanet(st, drop(i), DT, true, rng);
      expect(st.orb - orb).toBeLessThan(0.08);
      expect(Math.abs(st.speed - prev.speed)).toBeLessThan(0.03);
      expect(Math.abs(st.bend - prev.bend)).toBeLessThan(0.02);
      expect(Math.abs(st.warp - prev.warp)).toBeLessThan(0.01);
      expect(Math.abs(st.comp - prev.comp)).toBeLessThan(0.005);
      expect(Math.abs(st.dw - prev.dw)).toBeLessThan(0.1);
      expect(Math.abs(st.ovSize - prev.size)).toBeLessThan(0.01);
      prev = { speed: st.speed, bend: st.bend, warp: st.warp, comp: st.comp, dw: st.dw, size: st.ovSize };
      maxSpeed = Math.max(maxSpeed, st.speed);
    }
    // The drop does run the planet faster.
    expect(maxSpeed).toBeGreaterThan(2);
  });

  it("sets off an outbreak at the drop and feeds the wake", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    let fired = false;
    for (let i = 0; i < 1800; i++) {
      stepRingedPlanet(st, drop(i), DT, true, rng);
      fired ||= st.head.on;
    }
    expect(fired).toBe(true);
    expect(Math.max(...st.wake)).toBeGreaterThan(0);
  });

  it("ends an outbreak on a breakdown and keeps the ovals inside their real range", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    expect(burn(st, rng)).toBe(true);
    let minSize = st.ovSize;
    for (let i = 0; i < 600; i++) {
      stepRingedPlanet(st, sig({ rms: 0.02, level: 0.2 }), DT, true, rng);
      minSize = Math.min(minSize, st.ovSize);
      expect(st.ovSize).toBeGreaterThanOrEqual(OVAL_SIZE_MIN);
    }
    expect(st.head.on).toBe(false);
    expect(st.head.str).toBeLessThan(0.1);
    // The breakdown really shrinks the ovals.
    expect(minSize).toBeLessThan(0.85);
  });

  it.each([
    ["paused", (s: VisualSignal) => ({ s, playing: false })],
    ["Calm", (s: VisualSignal) => ({ s: { ...s, drive: 0 }, playing: true })],
  ])("ends a burning outbreak when %s starts and does not start another", (_name, change) => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    expect(burn(st, rng)).toBe(true);
    const wakeAtStop = Math.max(...st.wake);
    expect(st.head.str).toBeGreaterThan(0.3);
    for (let i = 0; i < 600; i++) {
      const { s, playing } = change(drop(1000 + i));
      stepRingedPlanet(st, s, DT, playing, rng);
      expect(st.head.on).toBe(false);
    }
    expect(st.head.str).toBeLessThan(0.1);
    expect(Math.max(...st.wake)).toBeLessThan(wakeAtStop);
  });

  it("gives no beat or motion reaction under Calm or while paused", () => {
    const quiet = createRingedPlanetState();
    const calm = createRingedPlanetState();
    const paused = createRingedPlanetState();
    const rng = createRng(1);
    for (let i = 0; i < 1800; i++) {
      const s = drop(i);
      stepRingedPlanet(quiet, sig({ rms: s.rms, level: s.level, drive: 0 }), DT, true, rng);
      stepRingedPlanet(calm, drop(i, 0), DT, true, rng);
      stepRingedPlanet(paused, s, DT, false, rng);
    }
    for (const st of [calm, paused]) {
      expect(st.crests).toHaveLength(0);
      expect(st.puffs).toHaveLength(0);
      expect(st.head.on).toBe(false);
      expect(st.head.str).toBe(0);
      expect(uniforms(st)).toEqual(uniforms(quiet));
    }
    expect(calm.shine).toBe(quiet.shine);
  });

  it("sizes the kick's crest by the beat's weight", () => {
    const none = kick(0).peak;
    const quiet = kick(0.25).peak;
    const full = kick(1).peak;
    expect(none).toBeLessThan(0.01);
    expect(quiet).toBeGreaterThan(none);
    expect(full).toBeGreaterThan(3 * quiet);
    expect(full).toBeGreaterThan(0.8);
    expect(kick(1.6).peak).toBeLessThanOrEqual(1.1);
  });

  it("raises the crest fast and clears it before the next kick at 128 BPM", () => {
    const { heights, peak } = kick(1);
    const at = (s: number) => heights[Math.round(s / DT)];
    expect(at(0.1)).toBeGreaterThan(0.7 * peak);
    expect(at(60 / 128)).toBeLessThan(0.25 * peak);
    expect(at(0.9)).toBe(0);
  });

  it("flashes the globe with the beat and lets it decay", () => {
    const { st } = kick(1, 6);
    expect(st.beatEnv).toBeGreaterThan(0.9);
    const rng = createRng(1);
    for (let i = 0; i < 120; i++) stepRingedPlanet(st, sig({}), DT, true, rng);
    expect(st.beatEnv).toBeLessThan(0.02);
    expect(kick(0.25, 6).st.beatEnv).toBeLessThan(0.3);
  });

  it("sends one slow great crest and a storm glow on a surge", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    for (let i = 0; i < 120; i++) stepRingedPlanet(st, sig({}), DT, true, rng);
    stepRingedPlanet(st, sig({ surge: 1 }), DT, true, rng);
    expect(st.crests.some((k) => k.slow > 1)).toBe(true);
    expect(st.surgeEnv).toBe(1);
    expect(st.puffs.length).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) stepRingedPlanet(st, sig({}), DT, true, rng);
    expect(st.crests.some((k) => k.slow > 1)).toBe(true);
    expect(Math.max(...[1, 3, 5, 7].map((k) => st.crest[k]))).toBeGreaterThan(0.2);
  });

  it("ignores a cut, alone or before a surge", () => {
    const run = (cut: number, surge: number) => {
      const st = createRingedPlanetState();
      const rng = createRng(1);
      const loud = { level: 1, bassMotion: 1 };
      for (let i = 0; i < 300; i++) stepRingedPlanet(st, sig(loud), DT, true, rng);
      for (let i = 0; i < 90; i++) {
        const over = i === 0 ? { cut } : i === 30 ? { surge } : {};
        stepRingedPlanet(st, sig({ ...loud, ...over }), DT, true, rng);
      }
      return uniforms(st).concat(st.shine);
    };
    expect(run(1, 0)).toEqual(run(0, 0));
    expect(run(1, 1)).toEqual(run(0, 1));
  });

  it("glints the ring's ice on the highs' hits and rests between them", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    stepRingedPlanet(st, sig({ highHit: 1 }), DT, true, rng);
    expect(st.spark).toBe(1);
    const ph = st.sparkPh;
    for (let i = 0; i < 60; i++) stepRingedPlanet(st, sig({}), DT, true, rng);
    expect(st.spark).toBeLessThan(0.01);
    expect(st.sparkPh).toBeGreaterThan(ph);
  });

  it("settles back to rest after the drop", () => {
    const st = createRingedPlanetState();
    const rng = createRng(1);
    for (let i = 0; i < 1800; i++) stepRingedPlanet(st, drop(i), DT, true, rng);
    for (let i = 0; i < 150 * 60; i++) stepRingedPlanet(st, sig({ rms: 0.8 }), DT, true, rng);
    expect(st.crests).toHaveLength(0);
    expect(st.puffs).toHaveLength(0);
    expect(st.head.on).toBe(false);
    expect(st.head.str).toBeLessThan(0.001);
    expect(Math.max(...st.wake)).toBeLessThan(0.01);
    expect(st.speed).toBeCloseTo(1, 2);
    expect(st.bend).toBeCloseTo(0.02, 3);
    expect(st.warp).toBeCloseTo(0.004, 3);
    expect(st.comp).toBeCloseTo(0.002, 3);
    expect(st.dw).toBeCloseTo(0.15, 3);
    expect(st.spoke).toBeCloseTo(0.3, 3);
    expect(st.ovSize).toBeCloseTo(1, 2);
    expect(st.ovWind).toBeCloseTo(0.7, 3);
    expect(st.shear).toBeCloseTo(1, 2);
    expect(st.high).toBeLessThan(0.001);
    expect(st.fineA).toBeLessThan(0.001);
  });

  it("replays the same cells for the same seed", () => {
    const run = (seed: number) => {
      const st = createRingedPlanetState();
      const rng = createRng(seed);
      for (let i = 0; i < 1800; i++) stepRingedPlanet(st, drop(i), DT, true, rng);
      return uniforms(st);
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});
