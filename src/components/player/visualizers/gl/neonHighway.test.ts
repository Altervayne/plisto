// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { createCyberBeat, cyberBandMean, cyberBands, cyberBeat, cyberGain } from "./cyber";
import { HIGHWAY, createNeonHighwayState, packGates, stepNeonHighway, type NeonHighwayState } from "./neonHighway";

// -- Type Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// The rate cap on beats, in seconds.
const BEAT_GAP = 1 / 3;
// The glitch rate cap, in seconds, written out so a changed constant is caught.
const GLITCH_CAP = 24;

/** A frame of a loud passage at the caps: every envelope at 1.6, full bands, a beat at the rate cap. */
function capped(i: number, level = 0.6): VisualSignal {
  const on = i % 20 === 0;
  const bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
  const held = i % 20 < 6;
  return {
    ...restSignal(),
    bands,
    level,
    loudness: level,
    bassMotion: on ? 1.6 : 0,
    bassHit: on ? 1.6 : 0,
    midMotion: 1.6,
    highMotion: i % 30 < 15 ? 1.6 : 0,
    beat: on ? 1.5 : 0,
    beatWeight: held ? 1.6 : 0,
    drive: LIVELY,
  };
}

/** A quiet bar for `secs`, then a loud one: the loudness crossing into the top of its range. */
function dropRun(seed: number, secs: number): NeonHighwayState[] {
  const st = createNeonHighwayState();
  const rng = createRng(seed);
  const trace: NeonHighwayState[] = [];
  for (let i = 0; i * DT < secs; i++) {
    const t = i * DT;
    const level = t % 30 < 20 ? 0.1 : 0.9;
    stepNeonHighway(st, { ...restSignal(), level, loudness: level, drive: LIVELY }, DT, LIVELY, rng);
    trace.push({ ...st, gates: [...st.gates] });
  }
  return trace;
}

describe("cyber kit", () => {
  it("gives no motion gain while paused", () => {
    const sig = { ...restSignal(), drive: LIVELY };
    expect(cyberGain(sig, true)).toBe(LIVELY);
    expect(cyberGain(sig, false)).toBe(0);
  });

  it("keeps the eased bands in 0..1 and at zero with no gain", () => {
    const eased = new Float32Array(24);
    const sig = { ...restSignal(), bands: new Float32Array(24).fill(1) };
    for (let i = 0; i < 120; i++) cyberBands(eased, sig, LIVELY, DT);
    for (const b of eased) expect(b).toBeLessThanOrEqual(1);
    expect(cyberBandMean(eased, 0, 24)).toBeGreaterThan(0.99);
    for (let i = 0; i < 600; i++) cyberBands(eased, sig, 0, DT);
    expect(Math.max(...eased)).toBeLessThan(1e-3);
  });

  it("holds the beat envelope under 1.3 at the cap and at zero with no gain", () => {
    const st = createCyberBeat();
    const rng = createRng(3);
    let max = 0;
    for (let i = 0; i < 600; i++) max = Math.max(max, cyberBeat(st, { ...restSignal(), beat: i % 20 === 0 ? 3 : 0 }, LIVELY, DT, rng));
    expect(max).toBeLessThanOrEqual(1.3);
    expect(max).toBeGreaterThan(0.5);
    const calm = createCyberBeat();
    for (let i = 0; i < 600; i++) expect(cyberBeat(calm, { ...restSignal(), beat: 3 }, 0, DT, rng)).toBe(0);
  });
});

describe("stepNeonHighway", () => {
  it("keeps every envelope in range under the caps at Lively", () => {
    const st = createNeonHighwayState();
    const rng = createRng(1);
    // Extremes are tracked per frame and asserted once, so the sweep stays cheap.
    let low = Infinity;
    let high = -Infinity;
    let bandMax = 0;
    let pulse = 0;
    let nudge = 0;
    let speedMin = Infinity;
    let kick = 0;
    let shown = 0;
    let glitch = 0;
    let gates = 0;
    for (let i = 0; i < 60 * 60; i++) {
      stepNeonHighway(st, capped(i, i % 1200 < 600 ? 0.1 : 0.9), DT, LIVELY, rng);
      low = Math.min(low, st.gap, st.mid, st.high, st.bc.lock, st.hit, st.drop, st.sink, st.kick);
      high = Math.max(high, st.gap, st.mid, st.high, st.bc.lock, st.hit, st.drop, st.sink);
      for (const b of st.bands) bandMax = Math.max(bandMax, b);
      pulse = Math.max(pulse, st.shownPulse);
      nudge = Math.max(nudge, Math.abs(st.nudge));
      speedMin = Math.min(speedMin, st.speed);
      kick = Math.max(kick, st.kick);
      shown = Math.max(shown, st.shownSpeed);
      glitch = Math.max(glitch, st.glitchAmt);
      gates = Math.max(gates, st.gates.length);
    }
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
    expect(bandMax).toBeLessThanOrEqual(1);
    expect(pulse).toBeLessThanOrEqual(1.3);
    expect(nudge).toBeLessThanOrEqual(HIGHWAY.MAX_NUDGE);
    expect(speedMin).toBeGreaterThanOrEqual(HIGHWAY.MIN_SPEED);
    expect(kick).toBeLessThanOrEqual(HIGHWAY.KICK_MAX);
    expect(shown).toBeLessThan(3.6);
    expect(glitch).toBeLessThanOrEqual(22 * 1.3);
    expect(gates).toBeLessThanOrEqual(3);
  });

  it("moves everything in small steps with Lively beats at the cap", () => {
    const st = createNeonHighwayState();
    const rng = createRng(2);
    const worst = { speed: 0, travel: 0, gap: 0, mid: 0, high: 0, pulse: 0, glitch: 0, gate: 0 };
    let prev = { speed: st.shownSpeed, travel: st.travel, gap: 0, mid: 0, high: 0, pulse: 0, glitch: 0 };
    let nextBeat = 0;
    let prevKick = 0;
    let kickStep = 0;
    const rises: number[] = [];
    const packed = new Float32Array(12);
    for (let i = 0; i < 60 * 60; i++) {
      const t = i * DT;
      const beat = t >= nextBeat ? 1.5 : 0;
      if (beat) nextBeat += BEAT_GAP;
      const level = t % 30 < 15 ? 0.1 : 0.9;
      const sig = { ...restSignal(), level, loudness: level, beat, beatWeight: beat ? 1 : 0, bassMotion: beat ? 1.6 : 0 };
      stepNeonHighway(st, { ...sig, midMotion: i % 40 < 20 ? 1.6 : 0, highMotion: 1.6, drive: LIVELY }, DT, LIVELY, rng);
      const now = { speed: st.shownSpeed, travel: st.travel, gap: st.gap, mid: st.mid, high: st.high, pulse: st.shownPulse, glitch: st.glitchAmt };
      for (const key of Object.keys(now) as (keyof typeof now)[]) worst[key] = Math.max(worst[key], Math.abs(now[key] - prev[key]));
      packGates(st, packed);
      for (let g = 0; g < 3; g++) if (packed[g * 4 + 1] > 0) worst.gate = Math.max(worst.gate, packed[g * 4]);
      kickStep = Math.max(kickStep, Math.abs(st.kick - prevKick));
      if (prevKick < 0.3 && st.kick >= 0.3) rises.push(t);
      prevKick = st.kick;
      prev = now;
    }
    // The beat light (uBeat) is the kick envelope: its step is bounded by its rise, and at most 3 full rises land in a second.
    expect(kickStep).toBeLessThanOrEqual(HIGHWAY.KICK_MAX * (1 - Math.exp(-DT / HIGHWAY.KICK_UP)) + 1e-9);
    expect(rises.length).toBeGreaterThan(60);
    for (let i = 3; i < rises.length; i++) expect(rises[i] - rises[i - 3]).toBeGreaterThanOrEqual(1 - 2 * DT);
    // The fastest eased envelope (0.12 s up over the full range) moves at most 1 - exp(-dt / 0.12) a frame.
    const envelope = 1 - Math.exp(-DT / 0.12) + 1e-9;
    expect(worst.gap).toBeLessThanOrEqual(envelope);
    expect(worst.mid).toBeLessThanOrEqual(envelope);
    expect(worst.high).toBeLessThanOrEqual(envelope);
    expect(worst.speed).toBeLessThan(0.05);
    // Top speed (2.8 sprung, plus the surge and the nudge) covers under 0.6 world units a frame.
    expect(worst.travel).toBeLessThan(0.6);
    expect(worst.glitch).toBeLessThan(5);
    // A ripple starts at most at 1.3 and only once the last one is 0.6 s old.
    expect(worst.pulse).toBeLessThanOrEqual(1.3);
    // Gates are sent far down the road, never at the viewer.
    expect(worst.gate).toBeGreaterThan(7);
  });

  it("gives no beat reaction under Calm or while paused", () => {
    const paused = { ...restSignal(), drive: LIVELY };
    for (const drive of [0, cyberGain(paused, false)]) {
      const st = createNeonHighwayState();
      const rng = createRng(4);
      for (let i = 0; i < 60 * 40; i++) {
        stepNeonHighway(st, capped(i, i < 1200 ? 0.1 : 0.9), DT, drive, rng);
        expect(st.gates.length).toBe(0);
        expect(st.shownPulse).toBe(0);
        expect(st.glitchAmt).toBe(0);
        expect(st.nudge).toBe(0);
        expect(st.surge).toBe(0);
        expect(st.kick + st.hit + st.drop + st.sink).toBe(0);
        expect(st.gap + st.mid + st.high).toBe(0);
        expect(Math.max(...st.bands)).toBe(0);
        expect(st.bc.lock).toBe(0);
      }
      expect(st.speed).toBeCloseTo(HIGHWAY.CALM_SPEED, 2);
    }
  });

  it("settles back to rest once the beats stop", () => {
    const st = createNeonHighwayState();
    const rng = createRng(5);
    for (let i = 0; i < 60 * 20; i++) stepNeonHighway(st, capped(i), DT, LIVELY, rng);
    expect(st.gates.length + st.shownPulse).toBeGreaterThan(0);
    const quiet = { ...restSignal(), bands: new Float32Array(24), level: 0.6, loudness: 0.5, drive: LIVELY };
    for (let i = 0; i < 60 * 30; i++) stepNeonHighway(st, quiet, DT, LIVELY, rng);
    expect(st.gates.length).toBe(0);
    expect(st.shownPulse).toBe(0);
    expect(st.glitchAmt).toBe(0);
    expect(st.kick + st.hit + st.drop + st.sink).toBeLessThan(1e-3);
    expect(st.gap + st.mid + st.high).toBeLessThan(1e-3);
    expect(Math.max(...st.bands)).toBeLessThan(1e-3);
    expect(st.bc.lock).toBeLessThan(1e-3);
    expect(Math.abs(st.nudge)).toBeLessThan(1e-3);
    expect(st.speed).toBeCloseTo(1, 1);
  });

  /** The beat envelope's peak over kicks at 128 BPM, and its height just before the next kick. */
  function kickPeak(weight: number, loudness: number): { peak: number; before: number } {
    const st = createNeonHighwayState();
    const rng = createRng(11);
    const period = Math.round(60 / 128 / DT);
    let peak = 0;
    let before = 0;
    for (let i = 0; i < period * 12; i++) {
      const held = i % period < 6;
      if (i >= period * 8 && i % period === period - 1) before = Math.max(before, st.kick);
      const sig = { ...restSignal(), loudness, level: loudness, beat: i % period === 0 ? 1.6 : 0, beatWeight: held ? weight : 0, drive: LIVELY };
      stepNeonHighway(st, sig, DT, LIVELY, rng);
      if (i >= period * 8) peak = Math.max(peak, st.kick);
    }
    return { peak, before };
  }

  it("throws the beat envelope up by the beat's weight and settles before the next kick at 128 BPM", () => {
    const loud = kickPeak(1, 0.9);
    const kickless = kickPeak(0.25, 0.9);
    const quiet = kickPeak(0.02, 0.2);
    expect(loud.peak).toBeGreaterThan(0.8);
    expect(loud.before).toBeLessThan(0.1 * loud.peak);
    expect(kickless.peak).toBeGreaterThan(0.15);
    expect(kickless.peak).toBeLessThan(0.35 * loud.peak);
    expect(quiet.peak).toBeLessThan(0.05);
  });

  it("sends no gate and no ripple for a beat that carries no weight", () => {
    const st = createNeonHighwayState();
    const rng = createRng(12);
    for (let i = 0; i < 60 * 10; i++) {
      const sig = { ...restSignal(), loudness: 0.1, level: 0.1, beat: i % 20 === 0 ? 1.6 : 0, beatWeight: 0, drive: LIVELY };
      stepNeonHighway(st, sig, DT, LIVELY, rng);
      expect(st.gates.length).toBe(0);
      expect(st.shownPulse).toBe(0);
    }
  });

  it("holds the gates only by the lively gap, not a long one", () => {
    const st = createNeonHighwayState();
    const rng = createRng(13);
    const starts: number[] = [];
    let seen = st.lastGate;
    for (let i = 0; i < 60 * 20; i++) {
      stepNeonHighway(st, capped(i), DT, LIVELY, rng);
      if (st.lastGate !== seen) starts.push((seen = st.lastGate));
    }
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(HIGHWAY.GATE_GAP_LIVELY - 1e-6);
    expect(starts.length).toBeGreaterThan(20 / 1.9);
  });

  it("cruises slowly in a near-silent passage and launches in a loud one", () => {
    const settle = (loudness: number): number => {
      const st = createNeonHighwayState();
      const rng = createRng(14);
      for (let i = 0; i < 60 * 30; i++) stepNeonHighway(st, { ...restSignal(), loudness, level: 0.9, drive: LIVELY }, DT, LIVELY, rng);
      return st.speed;
    };
    expect(settle(0.08)).toBeLessThan(0.45);
    expect(settle(0.5)).toBeCloseTo(1, 1);
    expect(settle(0.9)).toBeGreaterThan(2.4);
  });

  it("answers a surge with a speed burst and a thrown skyline, and a cut with a sunk one", () => {
    const run = (event: Partial<VisualSignal>) => {
      const st = createNeonHighwayState();
      const rng = createRng(15);
      const base = { ...restSignal(), loudness: 0.6, level: 0.6, drive: LIVELY };
      for (let i = 0; i < 60 * 5; i++) stepNeonHighway(st, base, DT, LIVELY, rng);
      const calm = st.shownSpeed;
      stepNeonHighway(st, { ...base, ...event }, DT, LIVELY, rng);
      const peak = { drop: 0, sink: 0, speed: 0 };
      for (let i = 0; i < 60 * 4; i++) {
        stepNeonHighway(st, base, DT, LIVELY, rng);
        peak.drop = Math.max(peak.drop, st.drop);
        peak.sink = Math.max(peak.sink, st.sink);
        peak.speed = Math.max(peak.speed, st.shownSpeed);
      }
      return { calm, peak, end: st.sink };
    };
    const surge = run({ surge: 1 });
    expect(surge.peak.drop).toBeGreaterThan(0.7);
    expect(surge.peak.speed).toBeGreaterThan(surge.calm + 0.5);
    expect(surge.peak.sink).toBe(0);
    const cut = run({ cut: 1 });
    expect(cut.peak.sink).toBeGreaterThan(0.7);
    expect(cut.peak.drop).toBe(0);
    expect(cut.end).toBeLessThan(0.5 * cut.peak.sink);
  });

  it("lets a surge release a cut so the drop reads at full size", () => {
    /** The shown surge throw, the first kick's throw and the lowest glow factor after a surge, with an optional cut `gap` seconds before it. */
    const drop = (gap: number | null) => {
      const st = createNeonHighwayState();
      const rng = createRng(16);
      const base = { ...restSignal(), loudness: 0.6, level: 0.6, drive: LIVELY };
      for (let i = 0; i < 60 * 5; i++) stepNeonHighway(st, base, DT, LIVELY, rng);
      const surgeAt = gap === null ? 60 : Math.round(gap / DT) + 1;
      const out = { throwLift: 0, kickLift: 0, glow: 1 };
      for (let i = 0; i < 60 * 3; i++) {
        const sig = { ...base, cut: gap !== null && i === 0 ? 1 : 0, surge: i === surgeAt ? 1 : 0 };
        // A full kick lands 0.1 s after the surge.
        const kickAt = i - surgeAt - 6;
        if (kickAt >= 0 && kickAt < 6) Object.assign(sig, { beat: kickAt === 0 ? 1.6 : 0, beatWeight: 1 });
        stepNeonHighway(st, sig, DT, LIVELY, rng);
        if (i < surgeAt) continue;
        const open = 1 - 0.85 * st.sink;
        out.throwLift = Math.max(out.throwLift, st.drop * open);
        out.kickLift = Math.max(out.kickLift, st.kick * open);
        out.glow = Math.min(out.glow, 1 - 0.4 * st.sink);
      }
      return out;
    };
    const clean = drop(null);
    for (const gap of [0.3, 0.6, 1]) {
      const after = drop(gap);
      expect(after.throwLift).toBeGreaterThan(0.9 * clean.throwLift);
      expect(after.kickLift).toBeGreaterThan(0.9 * clean.kickLift);
      expect(after.glow).toBeGreaterThan(0.9);
    }
  });

  it("keeps a cut with no surge sunk for its full length", () => {
    const st = createNeonHighwayState();
    const rng = createRng(17);
    const base = { ...restSignal(), loudness: 0.6, level: 0.6, drive: LIVELY };
    for (let i = 0; i < 60 * 3; i++) stepNeonHighway(st, base, DT, LIVELY, rng);
    stepNeonHighway(st, { ...base, cut: 1 }, DT, LIVELY, rng);
    for (let i = 0; i < 60; i++) stepNeonHighway(st, base, DT, LIVELY, rng);
    expect(st.sink).toBeGreaterThan(0.5);
  });

  it("launches the glitch at most once per 24 seconds, the first at once", () => {
    // The intensity re-crosses the top of its range every 6 s, so only the cap holds the launches apart.
    const st = createNeonHighwayState();
    const rng = createRng(6);
    const starts: number[] = [];
    let last = st.lastGlitch;
    let crossings = 0;
    let wasHigh = false;
    for (let i = 0; i * DT < 150; i++) {
      const level = (i * DT) % 6 < 3 ? 0.1 : 0.9;
      stepNeonHighway(st, { ...restSignal(), level, loudness: level, drive: LIVELY }, DT, LIVELY, rng);
      if (st.wasHigh && !wasHigh) crossings++;
      wasHigh = st.wasHigh;
      if (st.lastGlitch !== last) starts.push((last = st.lastGlitch));
    }
    expect(crossings).toBeGreaterThan(starts.length * 3);
    expect(starts.length).toBeGreaterThan(3);
    expect(starts[0]).toBeLessThan(GLITCH_CAP);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(GLITCH_CAP);
  });

  it("finishes a running glitch on its own curve when paused or switched to Calm", () => {
    /** The glitch amount per frame from its launch, with the gain dropping to `after` 0.15 s in. */
    const curve = (after: number, sigDrive: number): number[] => {
      const st = createNeonHighwayState();
      const rng = createRng(9);
      const amts: number[] = [];
      let since = -1;
      for (let i = 0; i * DT < 40 && amts.length < 70; i++) {
        const level = i * DT < 20 ? 0.1 : 0.9;
        const late = since >= 0 && since * DT >= 0.15;
        stepNeonHighway(st, { ...restSignal(), level, loudness: level, drive: late ? sigDrive : LIVELY }, DT, late ? after : LIVELY, rng);
        if (since < 0 && st.glitchAmt > 0) since = 0;
        if (since >= 0) {
          amts.push(st.glitchAmt);
          since++;
        }
      }
      return amts;
    };
    const playing = curve(LIVELY, LIVELY);
    const paused = curve(cyberGain({ ...restSignal(), drive: LIVELY }, false), LIVELY);
    const calm = curve(0, 0);
    const largest = (a: number[]) => Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i])));
    expect(Math.max(...playing)).toBeGreaterThan(10);
    expect(playing[playing.length - 1]).toBe(0);
    for (const run of [paused, calm]) {
      expect(run.length).toBe(playing.length);
      run.forEach((v, i) => expect(v).toBeCloseTo(playing[i], 9));
      expect(largest(run)).toBeLessThanOrEqual(largest(playing) + 1e-9);
    }
  });

  it("replays the same glitch from the same seed", () => {
    const a = dropRun(7, 40);
    const b = dropRun(7, 40);
    const c = dropRun(8, 40);
    expect(a.map((st) => [st.glitchSeed, st.glitchAmt])).toEqual(b.map((st) => [st.glitchSeed, st.glitchAmt]));
    expect(a[a.length - 1].glitchSeed).not.toBe(1);
    expect(c[c.length - 1].glitchSeed).not.toBe(a[a.length - 1].glitchSeed);
  });
});
