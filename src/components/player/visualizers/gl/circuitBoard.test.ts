// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { cyberGain } from "./cyber";
import {
  CIRCUIT,
  burstLight,
  burstShare,
  circuitFit,
  circuitReach,
  circuitUnit,
  createCircuitBoardState,
  layoutCircuitModules,
  stepCircuitBoard,
  type CircuitBoardState,
} from "./circuitBoard";

// -- State Imports --
import { restSignal } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Geometry } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// The rate cap on beats, in seconds.
const BEAT_GAP = 1 / 3;

/** A frame of a loud passage at the caps: every envelope at 1.6 for part of each beat, full bands, a full kick at the rate cap. */
function capped(i: number, level = 0.6): VisualSignal {
  const on = i % 20 < 6;
  const bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
  return {
    ...restSignal(),
    bands,
    level,
    loudness: 0.9,
    bassMotion: i % 20 < 8 ? 1.6 : 0,
    midMotion: i % 50 < 25 ? 1.6 : 0,
    highMotion: i % 30 < 15 ? 1.6 : 0,
    bassHit: i % 20 < 4 ? 1.6 : 0,
    midHit: i % 13 < 3 ? 1.6 : 0,
    highHit: i % 9 < 2 ? 1.6 : 0,
    beat: i % 20 === 0 ? 1.5 : 0,
    beatWeight: on ? 1.6 : 0,
    drive: LIVELY,
  };
}

/** A near-silent 20 s, then a loud passage at the caps: each band crossing well above its own recent mean. */
function drop(i: number, level = 0.9): VisualSignal {
  return i < 60 * 20 ? { ...restSignal(), level: 0.1, loudness: 0.05, drive: LIVELY } : capped(i, level);
}

/** The values a step may move, copied so a test can compare one frame with the next. */
function snapshot(st: CircuitBoardState) {
  return {
    field: st.field,
    low: st.low,
    lanes: st.lanes,
    pk: st.pk,
    traceV: st.traceV,
    segMix: st.segMix,
    bars: Array.from(st.bars),
    val: Array.from(st.val),
    cmd: st.cmd ? [...st.cmd] : [],
  };
}

/** The brightest burst on the board. */
const burstPeak = (st: CircuitBoardState) => Math.max(...[0, 1, 2, 3].map((k) => st.burstPacked[k * 4 + 1]));

describe("stepCircuitBoard", () => {
  it("keeps every envelope in range under the caps at Lively", () => {
    const st = createCircuitBoardState();
    const seen = { field: 0, low: 0, lanes: 0, led: 0, burst: 0, hit: 0 };
    let lo = 0;
    let hi = 0;
    let regsHi = 0;
    let shareHi = 0;
    for (let i = 0; i < 60 * 60; i++) {
      stepCircuitBoard(st, drop(i), DT, LIVELY);
      for (const v of [st.field, st.low, st.lanes, st.traceV, st.segMix, st.dark, ...st.hits, ...st.bars, ...st.val, ...st.bands, ...st.trace]) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      regsHi = Math.max(regsHi, ...st.regs);
      for (let k = 0; k < 4; k++) shareHi = Math.max(shareHi, st.burstZ[k * 4 + 2]);
      seen.field = Math.max(seen.field, st.field);
      seen.low = Math.max(seen.low, st.low);
      seen.lanes = Math.max(seen.lanes, st.lanes);
      seen.led = Math.max(seen.led, st.val[13]);
      seen.burst = Math.max(seen.burst, burstPeak(st));
      seen.hit = Math.max(seen.hit, ...st.hits);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(regsHi).toBeLessThanOrEqual(255);
    // A beat burst tops out at BURST_LIGHT; the trickle at TRICKLE.
    expect(seen.burst).toBeLessThanOrEqual(CIRCUIT.BURST_LIGHT + 1e-6);
    expect(seen.lanes).toBeLessThanOrEqual(CIRCUIT.IDLE_LANES + 1e-6);
    expect(shareHi).toBeLessThanOrEqual(1);
    // The run reaches the top of each range, so the bounds above are tested against real movement.
    expect(seen.field).toBeGreaterThan(0.5);
    expect(seen.low).toBeGreaterThan(0.5);
    expect(seen.led).toBeGreaterThan(0.5);
    expect(seen.burst).toBeGreaterThan(CIRCUIT.BURST_LIGHT * 0.9);
    expect(seen.hit).toBeGreaterThan(0.9);
  });

  it("moves everything in small steps with Lively beats at the cap", () => {
    const st = createCircuitBoardState();
    const worst = { field: 0, low: 0, lanes: 0, led: 0, bar: 0, trace: 0, pk: 0, seg: 0, flips: 0 };
    let nextBeat = 0;
    stepCircuitBoard(st, restSignal(), DT, LIVELY);
    let prev = snapshot(st);
    const flipAt: number[][] = Array.from({ length: 16 }, () => []);
    const flipTimes: number[] = [];
    let scrolls = 0;
    let lastScrollAt = -9;
    let minScrollGap = 9;
    let scroll = st.scroll;
    for (let i = 0; i < 60 * 60; i++) {
      const t = i * DT;
      const beat = t >= 20 && t >= nextBeat ? 1.5 : 0;
      if (beat) nextBeat += BEAT_GAP;
      const level = t < 20 ? 0.1 : 0.9;
      const loud = t >= 20;
      const sig = {
        ...restSignal(),
        level,
        loudness: loud ? 0.9 : 0.05,
        beat,
        beatWeight: beat ? 1.6 : 0,
        bassMotion: beat ? 1.6 : 0,
        midMotion: loud && i % 40 < 20 ? 1.6 : 0,
        highMotion: loud && i % 24 < 12 ? 1.6 : 0,
        drive: LIVELY,
      };
      if (loud) sig.bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
      stepCircuitBoard(st, sig, DT, LIVELY);
      const now = snapshot(st);
      worst.field = Math.max(worst.field, Math.abs(now.field - prev.field));
      worst.low = Math.max(worst.low, Math.abs(now.low - prev.low));
      worst.lanes = Math.max(worst.lanes, Math.abs(now.lanes - prev.lanes));
      worst.pk = Math.max(worst.pk, now.pk - prev.pk);
      worst.trace = Math.max(worst.trace, Math.abs(now.traceV - prev.traceV));
      // The counter restarts its fade as it steps, with the old and new digit swapped in the same frame.
      worst.seg = Math.max(worst.seg, now.segMix - prev.segMix);
      now.val.forEach((v, k) => {
        worst.led = Math.max(worst.led, Math.abs(v - prev.val[k]));
      });
      now.bars.forEach((v, k) => {
        worst.bar = Math.max(worst.bar, Math.abs(v - prev.bars[k]));
      });
      const flipped = now.cmd.filter((v, k) => v !== prev.cmd[k]).length;
      worst.flips = Math.max(worst.flips, flipped);
      if (flipped) flipTimes.push(t);
      now.cmd.forEach((v, k) => {
        if (v !== prev.cmd[k]) flipAt[k].push(t);
      });
      if (st.scroll !== scroll) {
        scrolls += 1;
        minScrollGap = Math.min(minScrollGap, t - lastScrollAt);
        lastScrollAt = t;
        scroll = st.scroll;
      }
      prev = now;
    }
    // The slew caps hold a field LED's, a bar segment's and the lanes' crossing to their stated rates.
    expect(worst.field).toBeLessThanOrEqual(CIRCUIT.SLEW_FIELD * DT + 1e-9);
    expect(worst.low).toBeLessThanOrEqual(CIRCUIT.SLEW_BAR * DT + 1e-9);
    expect(worst.lanes).toBeLessThanOrEqual(CIRCUIT.SLEW_LANES * DT + 1e-9);
    // An LED eases over LED_UP at its fastest: 1 - exp(-dt / tau) of the full swing a frame.
    expect(worst.led).toBeLessThanOrEqual(1 - Math.exp(-DT / CIRCUIT.LED_UP) + 1e-9);
    // The OLED's bars rise over 0.1 s, its trace follows over 0.06 s.
    expect(worst.bar).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.1) + 1e-9);
    expect(worst.trace).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.06) + 1e-9);
    // The counter fades its segments over SEG_FADE.
    expect(worst.seg).toBeLessThanOrEqual(DT / CIRCUIT.SEG_FADE + 1e-9);
    // The trickle crawls: at most 0.18 of a lane a second at full loudness.
    expect(worst.pk).toBeLessThanOrEqual(0.18 * DT + 1e-9);
    // At most one indicator flips per frame, and flips are FLIP_GAP apart.
    expect(worst.flips).toBeLessThanOrEqual(1);
    expect(flipTimes.length).toBeGreaterThan(10);
    for (let i = 1; i < flipTimes.length; i++) expect(flipTimes[i] - flipTimes[i - 1]).toBeGreaterThanOrEqual(CIRCUIT.FLIP_GAP - DT);
    // Each LED holds its state at least FLIP_HOLD.
    for (const times of flipAt) for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(CIRCUIT.FLIP_HOLD - DT);
    // The register rows scroll at most every SCROLL_GAP, though beats come three times a second.
    expect(scrolls).toBeGreaterThan(20);
    expect(minScrollGap).toBeGreaterThanOrEqual(CIRCUIT.SCROLL_GAP - DT);
  });

  /** A loud signal carrying every beat, hit and shift field, for the no-gain runs. */
  const loudAll = (i: number): VisualSignal => ({ ...drop(i), surge: i % 600 === 300 ? 1.6 : 0, cut: i % 600 === 100 ? 1.6 : 0 });

  // Calm is a signal whose own drive is 0 on a playing track; paused is a full Lively signal on a stopped one.
  it.each([
    ["Calm", 0, true],
    ["paused", LIVELY, false],
  ])("gives no beat, hit or shift reaction under %s", (_name, signalDrive, playing) => {
    const st = createCircuitBoardState();
    // The same board fed a silent signal: with no gain, a loud one must leave no trace beyond the level.
    const silent = createCircuitBoardState();
    let burstHi = 0;
    for (let i = 0; i < 60 * 40; i++) {
      const sig = { ...loudAll(i), drive: signalDrive };
      const drive = cyberGain(sig, playing);
      expect(drive).toBe(0);
      stepCircuitBoard(st, sig, DT, drive);
      stepCircuitBoard(silent, { ...restSignal(), level: sig.level, loudness: sig.loudness }, DT, drive);
      expect(st.beatN).toBe(0);
      expect(st.scroll).toBe(0);
      expect(st.segCur).toBe(0);
      expect(st.field + st.low + st.dark).toBe(0);
      expect(Math.max(...st.hits)).toBe(0);
      expect(st.surgeAge).toBe(-1);
      expect(st.lanes).toBe(CIRCUIT.IDLE_LANES);
      expect(Math.max(...st.bands)).toBe(0);
      // Only PWR stays lit; SYNC, CLIP, ACT, TX, RX and the channel row stay dark.
      expect(st.val[0]).toBe(1);
      expect(Math.max(...st.val.slice(1))).toBe(0);
      expect(Array.from(st.burstPacked)).toEqual(Array.from(silent.burstPacked));
      expect(st.pk).toBeCloseTo(silent.pk, 9);
      expect(st.traceV).toBeCloseTo(silent.traceV, 9);
      expect(Array.from(st.bars)).toEqual(Array.from(silent.bars));
      burstHi = Math.max(burstHi, burstPeak(st));
    }
    // The idle burst is there, well under a real beat's.
    expect(burstHi).toBeGreaterThan(0.1);
    expect(burstHi).toBeLessThanOrEqual(0.5);
  });

  it("eases to rest when the track pauses", () => {
    const st = createCircuitBoardState();
    const playing = { ...restSignal(), drive: LIVELY };
    for (let i = 0; i < 60 * 50; i++) stepCircuitBoard(st, drop(i), DT, cyberGain(playing, true));
    const lit = st.val.slice(1, 14).reduce((a, b) => a + b, 0);
    expect(lit).toBeGreaterThan(5);
    expect(st.field + st.low).toBeGreaterThan(0.5);
    // The switch is a drive of 0 on a signal that still carries the full Lively push.
    const paused = cyberGain(playing, false);
    let prev = snapshot(st);
    let worstLed = 0;
    let worstField = 0;
    for (let i = 0; i < 60 * 20; i++) {
      stepCircuitBoard(st, drop(i + 60 * 50), DT, paused);
      const now = snapshot(st);
      now.val.forEach((v, k) => {
        worstLed = Math.max(worstLed, Math.abs(v - prev.val[k]));
      });
      worstField = Math.max(worstField, Math.abs(now.field - prev.field), Math.abs(now.low - prev.low));
      prev = now;
    }
    // No jump on the switch: every LED falls over LED_DOWN at its fastest, the bar graph at its slew.
    expect(worstLed).toBeLessThanOrEqual(1 - Math.exp(-DT / CIRCUIT.LED_UP) + 1e-9);
    expect(worstField).toBeLessThanOrEqual(CIRCUIT.SLEW_BAR * DT + 1e-9);
    expect(st.val[0]).toBeCloseTo(1, 2);
    // Every LED but PWR and CH0 goes dark; CH0 is left out because its hysteresis lets it keep a lit state.
    expect(Math.max(...st.val.slice(1, 6), ...st.val.slice(7))).toBeLessThan(1e-2);
    expect(st.field + st.low).toBe(0);
    expect(Math.max(...st.bands)).toBeLessThan(1e-3);
    expect(Math.max(...st.hits)).toBeLessThan(1e-6);
    expect(st.lanes).toBeCloseTo(CIRCUIT.IDLE_LANES, 6);
  });

  /** Plays 50 s of the drop, then 2 s without beats so every burst has ended. */
  function playedThenQuiet(): CircuitBoardState {
    const st = createCircuitBoardState();
    for (let i = 0; i < 60 * 50; i++) stepCircuitBoard(st, drop(i), DT, LIVELY);
    const still = { ...restSignal(), level: 0.9, drive: LIVELY };
    for (let i = 0; i < 60 * 2; i++) stepCircuitBoard(st, still, DT, LIVELY);
    expect(burstPeak(st)).toBe(0);
    return st;
  }

  it("launches no idle burst for a full interval after the switch to drive 0, then one", () => {
    const st = playedThenQuiet();
    const still = { ...restSignal(), level: 0.9, drive: LIVELY };
    const paused = cyberGain(still, false);
    let first = -1;
    for (let i = 0; i < 60 * 6; i++) {
      stepCircuitBoard(st, still, DT, paused);
      if (first < 0 && burstPeak(st) > 0) first = i * DT;
    }
    expect(first).toBeGreaterThan(5 - 2 * DT);
    expect(first).toBeLessThan(5 + 2 * DT);
  });

  it("launches no burst when pause is toggled five times inside a second", () => {
    const st = playedThenQuiet();
    const still = { ...restSignal(), level: 0.9, drive: LIVELY };
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      stepCircuitBoard(st, still, DT, i % 12 < 6 ? cyberGain(still, false) : cyberGain(still, true));
      peak = Math.max(peak, burstPeak(st));
    }
    expect(peak).toBe(0);
  });

  it("sizes a burst by its beat's weight before the gain: none for a quiet beat, a few lanes for a kickless onset, half to two thirds for a kick", () => {
    expect(burstShare(0, 1)).toBe(0);
    expect(burstShare(0.05, 1)).toBe(0);
    expect(burstLight(0.05)).toBeLessThan(0.1);
    expect(burstShare(0.25, 1)).toBeGreaterThan(0.05);
    expect(burstShare(0.25, 1)).toBeLessThan(0.2);
    // The loud windows' median kicks (0.71 to 0.89 before the gain) take about half to two thirds of the lanes.
    expect(burstShare(0.71, 1)).toBeGreaterThan(0.45);
    expect(burstShare(0.89, 1)).toBeLessThan(0.7);
    expect(burstShare(1, 1)).toBe(1);
    // The same beat reads the same share at Balanced and Lively; Lively only lights it more.
    expect(burstShare(0.8 * LIVELY, LIVELY)).toBeCloseTo(burstShare(0.8, 1), 9);
    expect(burstLight(1.6)).toBe(CIRCUIT.BURST_LIGHT);
    for (let w = 0; w < 1.6; w += 0.05) {
      expect(burstShare(w + 0.05, 1)).toBeGreaterThanOrEqual(burstShare(w, 1));
      expect(burstLight(w + 0.05)).toBeGreaterThanOrEqual(burstLight(w));
    }
  });

  /** One beat of weight `w` on a loud board; the burst's light and final share 0.2 s later. */
  function oneBurst(w: number, drive = LIVELY, st = createCircuitBoardState()): { light: number; share: number } {
    for (let i = 0; i < 30; i++) {
      const sig = { ...restSignal(), loudness: 0.9, drive, beat: i === 10 ? 1.6 : 0, beatWeight: i >= 10 && i < 16 ? w : 0 };
      stepCircuitBoard(st, sig, DT, drive);
    }
    return { light: st.burstPacked[1], share: st.burstZ[2] };
  }

  it("grows the burst with the beat's weight and sends none at Calm", () => {
    const quiet = oneBurst(0.05);
    const kickless = oneBurst(0.25);
    const kick = oneBurst(1.2);
    const top = oneBurst(1.6);
    expect(quiet.share).toBe(0);
    expect(kickless.share).toBeGreaterThan(quiet.share);
    expect(kick.share).toBeGreaterThan(kickless.share);
    expect(kick.share).toBeLessThan(0.7);
    expect(top.share).toBe(1);
    expect(kick.light).toBeGreaterThan(3 * kickless.light);
    const calm = oneBurst(1.2, 0);
    expect(calm.light).toBe(0);
  });

  it("takes every lane at most once per FULL_GAP, however many kicks sit at the top weight", () => {
    const st = createCircuitBoardState();
    let full = 0;
    for (let i = 0; i < 60 * 12; i++) {
      const on = i % 30 === 0;
      stepCircuitBoard(st, { ...restSignal(), loudness: 0.9, drive: LIVELY, beat: on ? 1.6 : 0, beatWeight: i % 30 < 6 ? 1.6 : 0 }, DT, LIVELY);
      // Read each kick's burst once its weight follow has closed.
      if (i % 30 === 15 && st.bursts[st.bursts.length - 1].z[2] === 1) full += 1;
    }
    // 24 kicks at the top weight over 12 s: one in every 3 s takes every lane, the others SHARE_TOP.
    expect(full).toBe(4);
  });

  it("follows the beat's weight up as its bass lands, inside the weight window only", () => {
    const st = createCircuitBoardState();
    const w = (i: number) => (i === 0 ? 0.3 : i < 6 ? 0.9 : i < 20 ? 0 : 1.5);
    for (let i = 0; i < 24; i++) stepCircuitBoard(st, { ...restSignal(), loudness: 0.9, drive: LIVELY, beat: i === 0 ? 1.6 : 0, beatWeight: w(i) }, DT, LIVELY);
    // The burst took the landed weight 0.9, not the first frame's 0.3, and not the stray value after its window.
    expect(st.bursts.length).toBe(1);
    expect(st.bursts[0].weight).toBeCloseTo(0.9, 9);
  });

  it("starts the lanes a rising weight adds at the leads, at the age they joined", () => {
    const st = createCircuitBoardState();
    // The weight lands in three engine frames, two display frames apart.
    const w = [0.3, 0.3, 0.6, 0.6, 1.0, 1.0];
    for (let i = 0; i < 6; i++) stepCircuitBoard(st, { ...restSignal(), loudness: 0.9, drive: 1, beat: i === 0 ? 1 : 0, beatWeight: w[i] }, DT, 1);
    const b = st.bursts[0];
    expect(b.steps).toBe(2);
    expect(b.z[0]).toBeCloseTo(burstShare(0.3, 1), 9);
    expect(b.z[1]).toBeCloseTo(burstShare(0.6, 1), 9);
    expect(b.z[2]).toBe(1);
    // Each step opened on the frame its share grew: the burst's age then, not 0.
    expect(b.t[0]).toBeCloseTo(2 * DT, 9);
    expect(b.t[1]).toBeCloseTo(4 * DT, 9);
    // The shader reads the steps as packed.
    expect(Array.from(st.burstZ.slice(0, 4))).toEqual(Array.from(Float32Array.of(b.z[0], b.z[1], b.z[2], b.t[1])));
    expect(st.burstPacked[3]).toBeCloseTo(b.t[0], 6);
  });

  it("lets a beat's weight follow finish when a surge lands inside its window", () => {
    const st = createCircuitBoardState();
    for (let i = 0; i < 12; i++) {
      const sig = { ...restSignal(), loudness: 0.9, drive: 1, beat: i === 0 ? 1 : 0, beatWeight: i === 0 ? 0.3 : i < 6 ? 0.9 : 0, surge: i === 2 ? 1 : 0 };
      stepCircuitBoard(st, sig, DT, 1);
    }
    const beatBurst = st.bursts.find((b) => !b.surge);
    expect(beatBurst?.weight).toBeCloseTo(0.9, 9);
  });

  it("sends one countable burst per kick at 128 BPM", () => {
    const st = createCircuitBoardState();
    const gap = Math.round(60 / (128 / 60));
    let beats = 0;
    let maxAlive = 0;
    let launched = 0;
    let lastN = st.burstN;
    for (let i = 0; i < 60 * 10; i++) {
      const on = i % gap === 0;
      if (on) beats += 1;
      stepCircuitBoard(st, { ...restSignal(), loudness: 0.9, drive: LIVELY, beat: on ? 1.6 : 0, beatWeight: i % gap < 6 ? 1.2 : 0 }, DT, LIVELY);
      launched += st.burstN - lastN;
      lastN = st.burstN;
      maxAlive = Math.max(maxAlive, st.bursts.length);
      // When a kick lands, the one before has spent most of its light.
      if (on && st.bursts.length === 2) expect(st.burstPacked[1]).toBeLessThan(0.5 * CIRCUIT.BURST_LIGHT);
    }
    expect(launched).toBe(beats);
    expect(maxAlive).toBeLessThanOrEqual(2);
  });

  it("runs the trickle by loudness: none near silence, a thin share when loud", () => {
    const run = (loudness: number) => {
      const st = createCircuitBoardState();
      for (let i = 0; i < 60 * 5; i++) stepCircuitBoard(st, { ...restSignal(), loudness, drive: LIVELY }, DT, LIVELY);
      return st;
    };
    const silent = run(0.05);
    const quiet = run(0.3);
    const loud = run(0.9);
    expect(silent.lanes).toBe(0);
    expect(quiet.lanes).toBeGreaterThan(0);
    expect(loud.lanes).toBeCloseTo(CIRCUIT.TRICKLE, 6);
    expect(loud.lanes).toBeGreaterThan(quiet.lanes);
    expect(loud.pk).toBeGreaterThan(quiet.pk);
  });

  it("sends a surge burst brighter than any beat's, with the board-wide wave", () => {
    const st = createCircuitBoardState();
    let peak = 0;
    let share = 0;
    let waved = false;
    for (let i = 0; i < 60; i++) {
      stepCircuitBoard(st, { ...restSignal(), loudness: 0.9, drive: LIVELY, surge: i === 5 ? 1 : 0 }, DT, LIVELY);
      peak = Math.max(peak, burstPeak(st));
      share = Math.max(share, st.burstZ[0]);
      waved = waved || st.surgeAge >= 0;
    }
    expect(peak).toBeGreaterThan(CIRCUIT.BURST_LIGHT);
    expect(share).toBe(1);
    expect(waved).toBe(true);
  });

  it("dims and stills the board on a cut, and a surge lifts it", () => {
    const st = createCircuitBoardState();
    const loud = { ...restSignal(), loudness: 0.9, drive: LIVELY };
    for (let i = 0; i < 60 * 3; i++) stepCircuitBoard(st, loud, DT, LIVELY);
    stepCircuitBoard(st, { ...loud, cut: 1 }, DT, LIVELY);
    for (let i = 0; i < 30; i++) stepCircuitBoard(st, loud, DT, LIVELY);
    expect(st.dark).toBeGreaterThan(0.7);
    const pk = st.pk;
    stepCircuitBoard(st, loud, DT, LIVELY);
    // The trickle all but stops while dark.
    expect(st.pk - pk).toBeLessThan(0.3 * 0.18 * DT);
    stepCircuitBoard(st, { ...loud, surge: 1 }, DT, LIVELY);
    for (let i = 0; i < 30; i++) stepCircuitBoard(st, loud, DT, LIVELY);
    expect(st.dark).toBeLessThan(0.1);
    // Left alone, a cut recovers by itself.
    stepCircuitBoard(st, { ...loud, cut: 1 }, DT, LIVELY);
    for (let i = 0; i < 60 * 5; i++) stepCircuitBoard(st, loud, DT, LIVELY);
    expect(st.dark).toBeLessThan(0.01);
  });

  /**
   * The board's large-area light on one frame, as a share of its rest: the cut's dim over a base of 1 plus each
   * burst's light times its final share, plus the surge's burst (in the bursts) and its wave (it starts with that burst).
   */
  const areaLight = (st: CircuitBoardState) => {
    let sum = 1;
    for (let k = 0; k < 4; k++) sum += st.burstPacked[k * 4 + 1] * st.burstZ[k * 4 + 2];
    return (1 - 0.6 * st.dark) * sum;
  };

  it("rises at most three times a second across a cut then a surge, with beats at the cap running", () => {
    for (let gap = 0.2; gap <= 1.5 + 1e-9; gap += 0.05) {
      for (const phase of [0, 7, 13]) {
        const st = createCircuitBoardState();
        const cutAt = 600 + phase;
        const surgeAt = cutAt + Math.round(gap * 60);
        // A rise: the light turning up by 0.3 from its last low, counted once until it has turned down by 0.3.
        const rises: number[] = [];
        let ext = areaLight(st);
        let up = false;
        for (let i = 0; i < 60 * 16; i++) {
          const sig = {
            ...restSignal(),
            loudness: 0.9,
            drive: LIVELY,
            beat: i % 20 === 0 ? 1.6 : 0,
            beatWeight: i % 20 < 6 ? 1.6 : 0,
            cut: i === cutAt ? 1.6 : 0,
            surge: i === surgeAt ? 1.6 : 0,
          };
          stepCircuitBoard(st, sig, DT, LIVELY);
          const v = areaLight(st);
          if (up ? v > ext : v < ext) ext = v;
          if (!up && v - ext >= 0.3) {
            rises.push(i * DT);
            up = true;
            ext = v;
          } else if (up && ext - v >= 0.3) {
            up = false;
            ext = v;
          }
        }
        for (let k = 3; k < rises.length; k++) expect(rises[k] - rises[k - 3]).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(rises.length).toBeGreaterThan(20);
      }
    }
  });

  it("blinks the small parts on hits and lets them fall over HIT_TAU", () => {
    const st = createCircuitBoardState();
    stepCircuitBoard(st, { ...restSignal(), drive: LIVELY, bassHit: 1.6, highHit: 0.5 }, DT, LIVELY);
    expect(st.hits[0]).toBe(1);
    expect(st.hits[1]).toBe(0);
    expect(st.hits[2]).toBe(0.5);
    for (let i = 0; i < 9; i++) stepCircuitBoard(st, { ...restSignal(), drive: LIVELY }, DT, LIVELY);
    expect(st.hits[0]).toBeCloseTo(Math.exp((-9 * DT) / CIRCUIT.HIT_TAU), 6);
  });

  it("settles back to rest once the music goes quiet", () => {
    const st = createCircuitBoardState();
    for (let i = 0; i < 60 * 50; i++) stepCircuitBoard(st, drop(i), DT, LIVELY);
    expect(st.field + st.low).toBeGreaterThan(0.5);
    const quiet = { ...restSignal(), bands: new Float32Array(24), level: 0.12, loudness: 0.05, drive: LIVELY };
    for (let i = 0; i < 60 * 120; i++) stepCircuitBoard(st, quiet, DT, LIVELY);
    expect(st.field + st.low).toBeLessThan(1e-3);
    expect(st.lanes).toBe(0);
    expect(Math.max(...st.bars)).toBeLessThan(1e-3);
    expect(Math.max(...st.bands)).toBeLessThan(1e-3);
    // PWR and CH0 idle on: the board never goes fully dark.
    expect(st.val[0]).toBeCloseTo(1, 2);
    expect(st.val[6]).toBeCloseTo(1, 2);
    expect(Math.max(...st.val.slice(1, 6), ...st.val.slice(7))).toBeLessThan(1e-2);
    for (const r of st.burstPacked) expect(r).toBe(0);
  });

  it("replays the same state from the same signal", () => {
    const run = (shift: number) => {
      const st = createCircuitBoardState();
      for (let i = 0; i < 60 * 30; i++) stepCircuitBoard(st, capped(i + shift, 0.5), DT, LIVELY);
      return st;
    };
    const a = run(0);
    const b = run(0);
    const c = run(7);
    expect(Array.from(a.val)).toEqual(Array.from(b.val));
    expect(Array.from(a.trace)).toEqual(Array.from(b.trace));
    expect(Array.from(a.burstPacked)).toEqual(Array.from(b.burstPacked));
    expect([a.pk, a.beatN, a.scroll, a.segCur, a.field, a.low]).toEqual([b.pk, b.beatN, b.scroll, b.segCur, b.field, b.low]);
    expect(Array.from(a.trace)).not.toEqual(Array.from(c.trace));
  });
});

describe("layoutCircuitModules", () => {
  const SIZE = { w: 1400, h: 900, dpr: 1 };
  const geo = (cover: [number, number, number, number]): Geometry => ({ cover, radius: 16, mask: null, floor: 120, hush: [[40, 700, 300, 120]] });
  // A placed module's half size in css px: its design size at the scale the layout chose.
  const halfOf = (a: Float32Array, i: number) => [[54, 33], [54, 39], [56, 30], [56, 26]][i].map((v) => v * a[i * 4 + 3]);

  it("places every module clear of the chip's bus fans and inside the stage in the Player", () => {
    const g = geo([400, 380, 300, 300]);
    const out = layoutCircuitModules(g, SIZE, false, new Float32Array(16));
    const fit = circuitFit(g, SIZE, new Float32Array(4));
    const cx = 550;
    const cy = 530;
    const u = circuitUnit(300, SIZE.w, SIZE.h);
    const pitch = (2 * 0.6 * 300 - 0.14 * 300) / 16;
    // Each side's fan: the leads, the run before the jog and the jog (right, left, top, bottom).
    const fan = Array.from(fit).map((k) => 0.6 * 300 + 18 * u + k * (0.15 * 300 + 4 * pitch));
    const lanes = 0.6 * 300 + 6;
    let shown = 0;
    for (let i = 0; i < 4; i++) {
      if (out[i * 4 + 2] === 0) continue;
      shown += 1;
      const [x, y] = [out[i * 4], out[i * 4 + 1]];
      const [hw, hh] = halfOf(out, i);
      expect(out[i * 4 + 3]).toBeCloseTo(Math.sqrt(u), 6);
      expect(x - hw).toBeGreaterThanOrEqual(12);
      expect(x + hw).toBeLessThanOrEqual(SIZE.w - 342);
      expect(y - hh).toBeGreaterThanOrEqual(12);
      expect(y + hh).toBeLessThanOrEqual(SIZE.h - 12);
      // Neither bus fan.
      const overlapsH = x + hw > cx - fan[1] && x - hw < cx + fan[0] && y + hh > cy - lanes && y - hh < cy + lanes;
      const overlapsV = x + hw > cx - lanes && x - hw < cx + lanes && y + hh > cy - fan[3] && y - hh < cy + fan[2];
      expect(overlapsH || overlapsV).toBe(false);
      // The transport below the floor line, centred on the cover.
      expect(x + hw > 550 - 300 && x - hw < 550 + 300 && y - hh < 120 + 16).toBe(false);
    }
    expect(shown).toBeGreaterThanOrEqual(3);
  });

  it("draws the board in design pixels that follow the cover, floored by the stage", () => {
    expect(circuitUnit(340, 1000, 680)).toBeCloseTo(340 / 240, 9);
    expect(circuitUnit(400, 1280, 800)).toBeCloseTo(400 / 240, 9);
    expect(circuitUnit(480, 1000, 680)).toBeGreaterThan(circuitUnit(340, 1000, 680));
    // A small cover on a large stage keeps the board from shrinking into a mosaic.
    expect(circuitUnit(128, 680, 424)).toBeCloseTo(424 / 560, 9);
  });

  it("scales the modules with the cover, less than the board", () => {
    const wide = { w: 3000, h: 1100, dpr: 1 };
    const small = layoutCircuitModules({ ...geo([400, 50, 480, 480]), hush: [] }, wide, true, new Float32Array(16));
    const big = layoutCircuitModules({ ...geo([400, 50, 600, 600]), hush: [] }, wide, true, new Float32Array(16));
    // The DSP module sits at the chip's top right corner, set back from its lanes by its own half size and push.
    expect(small[2]).toBe(1);
    expect(big[2]).toBe(1);
    expect(big[3] / small[3]).toBeCloseTo(Math.sqrt(600 / 480), 6);
    const reach = (a: Float32Array, cw: number) => a[0] - (400 + cw / 2 + 0.6 * cw + 14);
    expect(reach(big, 600) / reach(small, 480)).toBeCloseTo(Math.sqrt(600 / 480), 1);
  });

  // The lab's Player and ambient-side stages in GL px, y up: cover, floor (the transport's top) and the text zones.
  const STAGES = {
    player: { size: { w: 1000, h: 680, dpr: 1 }, ambient: false, geo: { cover: [330, 250, 340, 340], radius: 16, mask: null, floor: 80, hush: [[300, 202, 400, 28], [320, 176, 360, 20]] } },
    "ambient-side": { size: { w: 1280, h: 800, dpr: 1 }, ambient: true, geo: { cover: [170, 275, 400, 400], radius: 20, mask: null, floor: 143, hush: [[650, 390, 440, 171]] } },
  } as const;
  const stageGeo = (id: keyof typeof STAGES) => STAGES[id].geo as unknown as Geometry;
  const NAMES = ["DSP", "REG", "SYS", "IO"];
  const rects = (a: Float32Array) =>
    shown(a).map((i) => {
      const s = a[i * 4 + 3];
      const [hw, hh] = [[54, 33], [54, 39], [56, 30], [56, 26]][i].map((v) => v * s);
      return { name: NAMES[i], x0: a[i * 4] - hw, x1: a[i * 4] + hw, y0: a[i * 4 + 1] - hh, y1: a[i * 4 + 1] + hh, s };
    });

  it.each([
    ["player", ["REG", "SYS"]],
    ["ambient-side", ["DSP", "REG", "SYS", "IO"]],
  ] as const)("places the screen modules on the real %s stage, clear of the chip and each other", (id, expected) => {
    const st = STAGES[id];
    const out = layoutCircuitModules(stageGeo(id), st.size, st.ambient, new Float32Array(16));
    const placed = rects(out);
    expect(placed.map((r) => r.name)).toEqual(expected);
    const [cx0, cy0, cw] = st.geo.cover;
    const chip = { x0: cx0 + cw / 2 - 0.6 * cw, x1: cx0 + cw / 2 + 0.6 * cw, y0: cy0 + cw / 2 - 0.6 * cw, y1: cy0 + cw / 2 + 0.6 * cw };
    const hit = (a: typeof chip, b: typeof chip) => a.x1 > b.x0 && a.x0 < b.x1 && a.y1 > b.y0 && a.y0 < b.y1;
    for (const r of placed) {
      // Readable: never under 0.9 of the plain size.
      expect(r.s).toBeGreaterThanOrEqual(0.9 - 1e-6);
      expect(hit(r, chip)).toBe(false);
      expect(r.x0).toBeGreaterThanOrEqual(12);
      expect(r.y0).toBeGreaterThanOrEqual(12);
      expect(r.y1).toBeLessThanOrEqual(st.size.h - 12);
      for (const o of placed) if (o !== r) expect(hit(r, o)).toBe(false);
    }
  });

  it.each(["player", "ambient-side"] as const)("fits every lane of the real %s stage inside it: none runs off", (id) => {
    const st = STAGES[id];
    const g = stageGeo(id);
    const fit = circuitFit(g, st.size, new Float32Array(4));
    const [x, y, cw] = st.geo.cover;
    const cx = x + cw / 2;
    const cy = y + cw / 2;
    const H = 0.6 * cw;
    // Room past the chip edge: right, left, top, and below down to the transport's top (16 px over the floor).
    const room = [st.size.w - (cx + H), cx - H, st.size.h - (cy + H), cy - H - (st.geo.floor + 16)];
    for (let i = 0; i < 4; i++) {
      // The fit stays above its floor here, so the bound holds for the longest lane and its end via.
      expect(fit[i]).toBeGreaterThan(0.05);
      expect(circuitReach(g, st.size, fit[i])).toBeLessThanOrEqual(room[i] + 1e-3);
    }
    // A side with room keeps its full length.
    expect(Math.max(...fit)).toBeGreaterThan(0.8);
  });

  it("leaves a module out when the stage has no room for it", () => {
    const tight = layoutCircuitModules(geo([400, 380, 300, 300]), { w: 700, h: 700, dpr: 1 }, false, new Float32Array(16));
    const roomy = layoutCircuitModules(geo([400, 380, 300, 300]), SIZE, false, new Float32Array(16));
    const count = (a: Float32Array) => [0, 1, 2, 3].filter((i) => a[i * 4 + 2] === 1).length;
    expect(count(roomy)).toBeGreaterThan(count(tight));
  });

  const shown = (a: Float32Array) => [0, 1, 2, 3].filter((i) => a[i * 4 + 2] === 1);

  it("keeps a module off a hush block that sits where it would go", () => {
    const base = geo([400, 380, 300, 300]);
    const free = layoutCircuitModules({ ...base, hush: [] }, SIZE, false, new Float32Array(16));
    expect(shown(free)).toContain(0);
    // A block centred on the free module, in GL pixels (x, y, w, h) with the same origin as the layout's y-up.
    const [x, y] = [free[0], free[1]];
    const blocked = layoutCircuitModules({ ...base, hush: [[x - 60, y - 40, 120, 80]] }, SIZE, false, new Float32Array(16));
    const moved = blocked[2] === 0 || blocked[0] !== x || blocked[1] !== y;
    expect(moved).toBe(true);
    if (blocked[2] === 1) {
      const [bx, by] = [blocked[0], blocked[1]];
      const [hw, hh] = halfOf(blocked, 0);
      const clear = bx - hw >= x + 60 + 16 || bx + hw <= x - 60 - 16 || by - hh >= y + 40 + 16 || by + hh <= y - 40 - 16;
      expect(clear).toBe(true);
    }
  });

  it("reads a missing floor as 0 and keeps modules above a raised one", () => {
    const base = geo([400, 380, 300, 300]);
    const none = layoutCircuitModules({ ...base, floor: null }, SIZE, false, new Float32Array(16));
    const zero = layoutCircuitModules({ ...base, floor: 0 }, SIZE, false, new Float32Array(16));
    expect(Array.from(none)).toEqual(Array.from(zero));
    const raised = layoutCircuitModules({ ...base, floor: 400 }, SIZE, false, new Float32Array(16));
    // The transport block runs from the floor down, so no module may dip below it inside the transport's width.
    for (const i of shown(raised)) {
      const [x, y] = [raised[i * 4], raised[i * 4 + 1]];
      const [hw, hh] = halfOf(raised, i);
      expect(x + hw > 550 - 300 && x - hw < 550 + 300 && y - hh < 400 + 16).toBe(false);
    }
    expect(Array.from(raised)).not.toEqual(Array.from(zero));
  });

  it("lets ambient use the right edge the Player keeps for the queue", () => {
    const narrow = { w: 1100, h: 900, dpr: 1 };
    const g = geo([400, 380, 300, 300]);
    const player = layoutCircuitModules(g, narrow, false, new Float32Array(16));
    const ambient = layoutCircuitModules(g, narrow, true, new Float32Array(16));
    expect(shown(player)).not.toContain(0);
    expect(shown(ambient)).toContain(0);
    for (const i of shown(ambient)) expect(ambient[i * 4] + halfOf(ambient, i)[0]).toBeLessThanOrEqual(narrow.w - 12);
  });

  it("clears the output before it writes", () => {
    const out = new Float32Array(16).fill(7);
    layoutCircuitModules(geo([20, 20, 60, 60]), { w: 100, h: 100, dpr: 1 }, true, out);
    expect(Array.from(out)).toEqual(new Array(16).fill(0));
  });
});
