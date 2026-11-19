// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { cyberGain } from "./cyber";
import { SERVER_COLS, SERVER_WAVES, createServerRoomState, stepServerRoom, type ServerRoomState } from "./serverRoom";

// -- Type Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
const SLOTS = SERVER_COLS.SLOTS;

/** A frame of a loud passage at the caps: every envelope at 1.6, bands alternating, a beat at the rate cap (3 per s). */
function capped(i: number, level = 0.6): VisualSignal {
  const on = i % 20 === 0;
  const bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
  return { ...restSignal(), bands, level, bassMotion: on ? 1.6 : 0, midMotion: 1.6, highMotion: i % 30 < 15 ? 1.6 : 0, beat: on ? 1.5 : 0, beatWeight: on ? 1.2 : 0, drive: LIVELY };
}

/** The largest level (even slots of the packed pairs) and peak (odd) across every rack column. */
function columnMax(st: ServerRoomState): { level: number; peak: number } {
  let level = 0;
  let peak = 0;
  for (let o = 0; o < st.cols.length; o += 2) {
    level = Math.max(level, st.cols[o]);
    peak = Math.max(peak, st.cols[o + 1]);
  }
  return { level, peak };
}

/** The strongest wave in the three slots. */
function waveMax(st: ServerRoomState): number {
  return Math.max(st.packed[1], st.packed[3], st.packed[5]);
}

/** One beat every 2 s, so the monitor's slice seed is redrawn at each. */
function sparseBeats(seed: number): number[] {
  const st = createServerRoomState();
  const rng = createRng(seed);
  const seeds: number[] = [];
  for (let i = 0; i < 60 * 20; i++) {
    const sig = { ...restSignal(), level: 0.5, beat: i % 120 === 0 ? 1 : 0, drive: LIVELY };
    stepServerRoom(st, sig, DT, LIVELY, rng);
    seeds.push(st.beat.seed);
  }
  return seeds;
}

describe("stepServerRoom", () => {
  it("keeps every envelope in range under the caps at Lively", () => {
    const st = createServerRoomState();
    const rng = createRng(1);
    // Extremes are gathered over the run and asserted once: an expect per value is too slow for 3600 frames.
    let peakBelowLevel = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let beatHi = 0;
    let waveHi = 0;
    let waveLo = Infinity;
    let zHi = -Infinity;
    for (let i = 0; i < 60 * 60; i++) {
      stepServerRoom(st, capped(i, i % 1200 < 600 ? 0.1 : 0.9), DT, LIVELY, rng);
      for (let o = 0; o < st.cols.length; o += 2) {
        if (st.cols[o + 1] < st.cols[o]) peakBelowLevel++;
        lo = Math.min(lo, st.cols[o], st.cols[o + 1], st.beatEnv, st.glow);
        hi = Math.max(hi, st.cols[o], st.cols[o + 1], st.glow);
      }
      beatHi = Math.max(beatHi, st.beatEnv);
      for (let g = 0; g < 3; g++) {
        waveHi = Math.max(waveHi, st.packed[g * 2 + 1]);
        waveLo = Math.min(waveLo, st.packed[g * 2 + 1]);
        zHi = Math.max(zHi, st.packed[g * 2]);
      }
    }
    expect(peakBelowLevel).toBe(0);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThan(0.9);
    expect(beatHi).toBeLessThanOrEqual(1.3);
    expect(beatHi).toBeGreaterThan(0.5);
    expect(waveLo).toBeGreaterThanOrEqual(0);
    expect(waveHi).toBeLessThanOrEqual(1);
    expect(zHi).toBeLessThanOrEqual(SERVER_WAVES.START_Z);
  });

  it("moves everything in small steps with Lively beats at the cap", () => {
    const st = createServerRoomState();
    const rng = createRng(2);
    const worst = { rise: 0, peakFall: 0, beat: 0, advance: 0 };
    let strongest = 0;
    let prevCols = Float32Array.from(st.cols);
    let prevBeat = 0;
    let prevZ = [0, 0, 0];
    for (let i = 0; i < 60 * 60; i++) {
      stepServerRoom(st, capped(i, i % 1800 < 900 ? 0.1 : 0.9), DT, LIVELY, rng);
      for (let o = 0; o < st.cols.length; o += 2) {
        worst.rise = Math.max(worst.rise, Math.abs(st.cols[o] - prevCols[o]));
        // A peak that is not following its level up only sinks.
        if (st.cols[o + 1] < prevCols[o + 1]) worst.peakFall = Math.max(worst.peakFall, prevCols[o + 1] - st.cols[o + 1]);
      }
      worst.beat = Math.max(worst.beat, Math.abs(st.beatEnv - prevBeat));
      // A wave's depth only ever steps toward the viewer by its speed; a relaunch is a jump up, not counted.
      for (let g = 0; g < 3; g++) if (st.packed[g * 2] < prevZ[g]) worst.advance = Math.max(worst.advance, prevZ[g] - st.packed[g * 2]);
      strongest = Math.max(strongest, waveMax(st));
      prevCols = Float32Array.from(st.cols);
      prevBeat = st.beatEnv;
      prevZ = [st.packed[0], st.packed[2], st.packed[4]];
    }
    // The fastest column rise: the quickest time constant over the full range.
    expect(worst.rise).toBeLessThanOrEqual(1 - Math.exp(-DT / SERVER_COLS.RISE) + 1e-9);
    expect(worst.rise).toBeGreaterThan(0.1);
    expect(worst.peakFall).toBeLessThanOrEqual(SERVER_COLS.SINK * DT + 1e-9);
    // The beat envelope rises over 70 ms toward at most 1.3.
    expect(worst.beat).toBeLessThanOrEqual(1.3 * (1 - Math.exp(-DT / 0.07)) + 1e-9);
    // Depths are read back from a Float32Array, hence the tolerance.
    expect(worst.advance).toBeLessThanOrEqual(SERVER_WAVES.SPEED * DT + 1e-4);
    expect(strongest).toBeGreaterThan(0.5);
  });

  it("spreads the bands over the racks by depth, the same on both sides", () => {
    const st = createServerRoomState();
    const rng = createRng(3);
    expect(st.cols.length).toBe(96);
    expect(st.packed.length).toBe(6);
    // A ramp, so every slot's expected level differs: rack slot j at depth (j + 0.5) x RACK_D reads band 23 x its share of the span.
    const bands = Float32Array.from({ length: 24 }, (_, i) => 0.1 + (0.8 * i) / 23);
    for (let i = 0; i < 60 * 5; i++) stepServerRoom(st, { ...restSignal(), bands, level: 0.5, drive: 1 }, DT, 1, rng);
    let prev = -1;
    for (let j = 0; j < SLOTS; j++) {
      const bp = Math.min(1, Math.max(0, ((j + 0.5) * SERVER_COLS.RACK_D - SERVER_COLS.NEAR_Z) / SERVER_COLS.SPAN_Z)) * 23;
      const raw = 0.1 + (0.8 * bp) / 23;
      const want = Math.min(1, Math.pow(raw, SERVER_COLS.CURVE));
      expect(st.cols[j * 4], `left ${j}`).toBeCloseTo(want, 2);
      expect(st.cols[j * 4 + 2], `right ${j}`).toBeCloseTo(want, 2);
      expect(st.cols[j * 4]).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = st.cols[j * 4];
    }
    // The nearest rack sits at the bass end and the farthest at the highs, so the ends differ.
    expect(st.cols[(SLOTS - 1) * 4] - st.cols[0]).toBeGreaterThan(0.3);
  });

  it("gives no beat reaction under Calm or while paused", () => {
    // Calm: the drive is 0 while playing. Paused: a Lively signal with playback stopped.
    const cases: [string, (i: number) => VisualSignal, boolean][] = [
      ["calm", (i) => ({ ...capped(i, i < 1200 ? 0.1 : 0.9), drive: 0 }), true],
      ["paused", (i) => capped(i, i < 1200 ? 0.1 : 0.9), false],
    ];
    for (const [name, signal, playing] of cases) {
      const st = createServerRoomState();
      const rng = createRng(4);
      for (let i = 0; i < 60 * 40; i++) {
        const sig = signal(i);
        stepServerRoom(st, sig, DT, cyberGain(sig, playing), rng);
        // No wave was ever launched: the step's own state, not the masked output.
        for (const f of st.fronts) {
          expect(f.a, name).toBe(0);
          expect(f.z, name).toBeLessThan(SERVER_WAVES.START_Z);
        }
        expect(st.rr, name).toBe(0);
        expect(waveMax(st), name).toBe(0);
        expect(st.beatEnv, name).toBe(0);
        expect(columnMax(st).level, name).toBe(0);
        expect(columnMax(st).peak, name).toBe(0);
        expect(st.beat.seed, name).toBe(1);
        // The glow still follows the level: it is the one brightness input.
        expect(st.glow, name).toBeCloseTo(Math.min(1, sig.level * 1.5), 6);
      }
    }
  });

  /** Beats alone every `period` frames: the slot each takes and the strength its previous wave still had. */
  function beatLaunches(period: number): { slot: number; was: number }[] {
    const st = createServerRoomState();
    const rng = createRng(9);
    const out: { slot: number; was: number }[] = [];
    for (let i = 0; i < 60 * 20; i++) {
      const slot = st.rr % 3;
      const was = st.fronts[slot].a;
      const before = st.rr;
      stepServerRoom(st, { ...restSignal(), level: 0.5, beat: i % period === 0 ? 1.5 : 0, beatWeight: i % period === 0 ? 1.2 : 0, drive: LIVELY }, DT, LIVELY, rng);
      if (st.rr !== before) out.push({ slot, was });
    }
    return out;
  }

  it("sends beat waves through the three slots in order", () => {
    const launches = beatLaunches(30);
    expect(launches.length).toBeGreaterThan(30);
    launches.forEach((l, n) => expect(l.slot).toBe(n % 3));
  });

  it("reuses a slot only after its wave has left at 2 beats per second, but while it is on screen at 3", () => {
    const slow = beatLaunches(30);
    for (const l of slow) expect(l.was).toBeLessThan(SERVER_WAVES.FREE_A);
    const fast = beatLaunches(20);
    expect(fast.some((l) => l.was > 0.5)).toBe(true);
  });

  it("fades a wave in flight when the drive stops, and does not bring it back on resume", () => {
    const st = createServerRoomState();
    const rng = createRng(10);
    let i = 0;
    // Run until a wave is mid-aisle at near full strength.
    const inFlight = () => st.fronts.findIndex((f) => f.z > 6 && f.z < 11 && f.a > 0.8);
    while (inFlight() < 0 && i < 600) stepServerRoom(st, capped(i++), DT, LIVELY, rng);
    const g = inFlight();
    expect(g).toBeGreaterThanOrEqual(0);
    const paused = cyberGain(capped(0), false);
    let prevA = st.fronts[g].a;
    let prevZ = st.packed[g * 2];
    let zeroAt = -1;
    for (let n = 0; n < 60 * 4; n++) {
      stepServerRoom(st, capped(i++), DT, paused, rng);
      const a = st.fronts[g].a;
      if (prevA > 0) {
        expect(a).toBeLessThan(prevA);
        // While the wave is in the aisle, one frame removes at most the ease's share of it.
        if (prevZ >= SERVER_WAVES.FADE_Z + 0.2) expect(prevA - a).toBeLessThanOrEqual(prevA * (1 - Math.exp(-DT / SERVER_WAVES.FADE_TAU)) + 1e-5);
      }
      expect(st.fronts[g].z).toBeLessThan(prevZ + 1e-9);
      if (st.packed[g * 2 + 1] === 0 && zeroAt < 0) zeroAt = n;
      prevA = a;
      prevZ = st.packed[g * 2];
    }
    expect(zeroAt).toBeGreaterThan(5);
    expect(zeroAt).toBeLessThan(60 * 4);
    expect(st.fronts.every((f) => f.a === 0)).toBe(true);

    // A resume shortly after the pause leaves a fading wave fading.
    const again = createServerRoomState();
    const rng2 = createRng(10);
    let j = 0;
    const live = () => again.fronts.findIndex((f) => f.z > 6 && f.z < 11 && f.a > 0.8);
    while (live() < 0 && j < 600) stepServerRoom(again, capped(j++), DT, LIVELY, rng2);
    const h = live();
    for (let n = 0; n < 18; n++) stepServerRoom(again, capped(j++), DT, paused, rng2);
    let before = again.fronts.map((f) => ({ a: f.a, z: f.z }));
    const sent = new Set<number>();
    for (let n = 0; n < 60; n++) {
      stepServerRoom(again, capped(j++), DT, LIVELY, rng2);
      again.fronts.forEach((f, k) => {
        // A beat may send a new wave into a slot (its depth jumps back); a wave that was fading keeps fading.
        if (f.z > before[k].z) sent.add(k);
        if (!sent.has(k) && before[k].a > 0.01) expect(f.a).toBeLessThan(before[k].a);
      });
      before = again.fronts.map((f) => ({ a: f.a, z: f.z }));
    }
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it("eases to rest when playback stops, columns and beat envelope falling rather than snapping", () => {
    const st = createServerRoomState();
    const rng = createRng(5);
    for (let i = 0; i < 60 * 10; i++) stepServerRoom(st, capped(i), DT, LIVELY, rng);
    expect(columnMax(st).level).toBeGreaterThan(0.3);
    expect(st.beatEnv).toBeGreaterThan(0.3);
    const paused = cyberGain({ ...restSignal(), drive: LIVELY }, false);
    stepServerRoom(st, capped(600), DT, paused, rng);
    expect(columnMax(st).level).toBeGreaterThan(0.3);
    expect(st.beatEnv).toBeGreaterThan(0.3);
    for (let i = 601; i < 60 * 20; i++) stepServerRoom(st, capped(i), DT, paused, rng);
    expect(columnMax(st).level).toBeLessThan(1e-3);
    expect(columnMax(st).peak).toBeLessThan(1e-3);
    expect(st.beatEnv).toBeLessThan(1e-3);
    expect(waveMax(st)).toBe(0);
  });

  it("settles back to rest once the beats stop", () => {
    const st = createServerRoomState();
    const rng = createRng(6);
    for (let i = 0; i < 60 * 20; i++) stepServerRoom(st, capped(i), DT, LIVELY, rng);
    expect(columnMax(st).peak + st.beatEnv).toBeGreaterThan(0.5);
    const quiet = { ...restSignal(), bands: new Float32Array(24), level: 0.6, drive: LIVELY };
    for (let i = 0; i < 60 * 30; i++) stepServerRoom(st, quiet, DT, LIVELY, rng);
    expect(columnMax(st).level).toBeLessThan(1e-3);
    expect(columnMax(st).peak).toBeLessThan(1e-3);
    expect(st.beatEnv).toBeLessThan(1e-3);
    expect(waveMax(st)).toBeLessThan(1e-3);
  });

  /** The strongest wave a single beat with this weight sends (nothing else in the signal). */
  function beatWaveFor(weight: number, drive = LIVELY): number {
    const st = createServerRoomState();
    const rng = createRng(11);
    let top = 0;
    for (let i = 0; i < 30; i++) {
      const sig = { ...restSignal(), beat: i === 0 ? 1.5 : 0, beatWeight: i < 6 ? weight : 0, drive };
      stepServerRoom(st, sig, DT, drive, rng);
      top = Math.max(top, waveMax(st));
    }
    return top;
  }

  it("sizes a beat's wave by its weight, and sends none at Calm", () => {
    const kick = beatWaveFor(1);
    const kickless = beatWaveFor(0.25);
    const quiet = beatWaveFor(0);
    expect(kick).toBeGreaterThan(0.95);
    expect(kickless).toBeLessThan(kick - 0.4);
    expect(quiet).toBeLessThan(kickless);
    expect(quiet).toBeGreaterThan(0);
    expect(beatWaveFor(1, 0)).toBe(0);
  });

  it("takes the weight as it rises after the beat, not the provisional value", () => {
    const st = createServerRoomState();
    const rng = createRng(12);
    stepServerRoom(st, { ...restSignal(), beat: 1, beatWeight: 0.1, drive: LIVELY }, DT, LIVELY, rng);
    const first = waveMax(st);
    for (let i = 0; i < 4; i++) stepServerRoom(st, { ...restSignal(), beatWeight: 0.9, drive: LIVELY }, DT, LIVELY, rng);
    expect(waveMax(st)).toBeGreaterThan(first + 0.4);
  });

  /** The lamp and ambient levels over a run: `at` frames mapped to an overriding signal. */
  function lightRun(frames: number, events: Record<number, Partial<VisualSignal>>, base: Partial<VisualSignal> = {}, drive = LIVELY) {
    const st = createServerRoomState();
    const rng = createRng(13);
    const lamp: number[] = [];
    const amb: number[] = [];
    for (let i = 0; i < frames; i++) {
      stepServerRoom(st, { ...restSignal(), drive, ...base, ...events[i] }, DT, drive, rng);
      lamp.push(st.lamp);
      amb.push(st.amb);
    }
    return { st, lamp, amb };
  }

  it("reads 1 for the tubes and the room at the rest loudness", () => {
    const { st } = lightRun(60 * 5, {});
    expect(st.lamp).toBeCloseTo(1, 6);
    expect(st.amb).toBeCloseTo(1, 6);
  });

  it("lights the room by loudness: dim when near silent, fully lit when loud", () => {
    const quiet = lightRun(60 * 6, {}, { loudness: 0.02 }).st;
    const loud = lightRun(60 * 6, {}, { loudness: 0.9 }).st;
    expect(quiet.lamp).toBeLessThan(0.6);
    expect(quiet.amb).toBeLessThan(0.8);
    expect(loud.lamp).toBeGreaterThan(1.1);
    expect(loud.amb).toBeGreaterThan(1.0);
    // Loudness is live at Calm.
    const calm = lightRun(60 * 6, {}, { loudness: 0.02 }, 0).st;
    expect(calm.lamp).toBeCloseTo(quiet.lamp, 6);
  });

  it("makes the tubes stutter in at most three dips a second and sink toward dark after a cut", () => {
    const { lamp, st } = lightRun(60 * 4, { 30: { cut: 1 } });
    const from = 30;
    // Dips: local minima that are deeper than 25% under the lamp's recent level, counted per second window.
    const dips: number[] = [];
    for (let i = from + 1; i < lamp.length - 1; i++) {
      if (lamp[i] < lamp[i - 1] && lamp[i] <= lamp[i + 1] && i > from + 2) {
        const around = Math.max(lamp[i - 6] ?? 1, lamp[i + 6] ?? 1);
        if (lamp[i] < around * 0.75) dips.push(i);
      }
    }
    expect(dips.length).toBeGreaterThanOrEqual(2);
    for (const d of dips) expect(dips.filter((e) => e >= d && e < d + 60).length).toBeLessThanOrEqual(3);
    // About a second after the cut the tubes are nearly dark, and the room has dimmed with them.
    expect(lamp[from + 75]).toBeLessThan(0.2);
    expect(st.amb).toBeLessThan(1);
    // Recovery is slow: 2.5 s after the sink it is not back yet, and it climbs on.
    const run = lightRun(60 * 14, { 30: { cut: 1 } });
    expect(run.lamp[30 + 60 * 3]).toBeLessThan(0.5);
    expect(run.lamp[run.lamp.length - 1]).toBeGreaterThan(0.9);
    expect(Math.min(...run.amb)).toBeLessThan(0.65);
  });

  /**
   * Times of the lamp's up-swings: a rise of at least 10% of the larger value (the value it rose to) from the lowest point
   * since the last fall of at least 10%. A flash is one fall and one rise, so counting rises counts flashes.
   */
  function upSwings(lamp: number[]): number[] {
    const out: number[] = [];
    let trough = lamp[0];
    let peak = lamp[0];
    let rising = false;
    lamp.forEach((v, i) => {
      if (!rising) {
        trough = Math.min(trough, v);
        if (v - trough >= 0.1 * v) {
          out.push(i);
          rising = true;
          peak = v;
        }
      } else {
        peak = Math.max(peak, v);
        if (peak - v >= 0.1 * peak) {
          rising = false;
          trough = v;
        }
      }
    });
    return out;
  }

  it("never changes the tubes more than three times in one second across cut then surge gaps, beats at three a second", () => {
    let worst = 0;
    for (const loudness of [0.05, 0.9]) {
      for (let gap = 0.3; gap <= 1.5001; gap += 0.05) {
        const cutAt = 60;
        const surgeAt = cutAt + Math.round(gap * 60);
        const frames = surgeAt + 60 * 4;
        const events: Record<number, Partial<VisualSignal>> = { [cutAt]: { cut: 0.7 }, [surgeAt]: { surge: 1 } };
        for (let i = 0; i < frames; i += 20) events[i] = { ...events[i], beat: 1.5, beatWeight: 1 };
        for (let i = 0; i < frames; i++) if (i % 20 < 6) events[i] = { ...events[i], beatWeight: 1 };
        const swings = upSwings(lightRun(frames, events, { loudness }).lamp);
        for (const t of swings) worst = Math.max(worst, swings.filter((u) => u >= t && u < t + 60).length);
      }
    }
    expect(worst).toBeLessThanOrEqual(3);
    expect(worst).toBeGreaterThanOrEqual(2);
  });

  it("slams the lights above rest on a surge, also right after a cut", () => {
    const solo = lightRun(60 * 3, { 30: { surge: 1 } });
    expect(Math.max(...solo.lamp)).toBeGreaterThan(1.3);
    expect(Math.max(...solo.amb)).toBeGreaterThan(1.05);
    expect(solo.lamp[solo.lamp.length - 1]).toBeCloseTo(1, 1);
    // The silence before a drop: a cut, then a surge half a second later.
    const drop = lightRun(60 * 3, { 30: { cut: 1 }, 60: { surge: 1 } });
    expect(drop.lamp[59]).toBeLessThan(0.7);
    expect(Math.max(...drop.lamp.slice(60))).toBeGreaterThan(1.3);
  });

  it("sends one full wave down the aisle on a surge", () => {
    const { st } = lightRun(1, { 0: { surge: 1 } });
    expect(waveMax(st)).toBeGreaterThan(0.99);
    expect(st.rr).toBe(1);
  });

  it("pulses the tubes faintly with the beat weight", () => {
    const base = lightRun(60, {}).st.lamp;
    const hit = lightRun(8, { 0: { beat: 1, beatWeight: 1 }, 1: { beatWeight: 1 }, 2: { beatWeight: 1 } }).lamp;
    const peak = Math.max(...hit);
    expect(peak).toBeGreaterThan(base * 1.02);
    expect(peak).toBeLessThan(base * 1.2);
  });

  it("leaves the tubes and the room at rest for cuts, surges and beats at Calm and while paused", () => {
    const events = { 30: { cut: 1, beat: 1, beatWeight: 1 }, 90: { surge: 1 } };
    const calm = lightRun(60 * 4, events, {}, 0);
    expect(Math.max(...calm.lamp)).toBeCloseTo(1, 6);
    expect(Math.min(...calm.lamp)).toBeCloseTo(1, 6);
    expect(Math.min(...calm.amb)).toBeCloseTo(1, 6);
    expect(Math.max(...calm.amb)).toBeCloseTo(1, 6);
  });

  it("restores the lights when the drive stops during a cut", () => {
    const st = createServerRoomState();
    const rng = createRng(14);
    stepServerRoom(st, { ...restSignal(), cut: 1, drive: LIVELY }, DT, LIVELY, rng);
    for (let i = 0; i < 60; i++) stepServerRoom(st, { ...restSignal(), drive: LIVELY }, DT, LIVELY, rng);
    expect(st.lamp).toBeLessThan(0.5);
    for (let i = 0; i < 60 * 4; i++) stepServerRoom(st, { ...restSignal(), drive: LIVELY }, DT, 0, rng);
    expect(st.lamp).toBeGreaterThan(0.97);
    expect(st.amb).toBeGreaterThan(0.97);
  });

  it("replays the same slice seeds from the same rng seed", () => {
    const a = sparseBeats(7);
    const b = sparseBeats(7);
    const c = sparseBeats(8);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(3);
    expect(a[a.length - 1]).not.toBe(1);
    expect(c).not.toEqual(a);
  });
});
