// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { cyberGain } from "./cyber";
import { CIRCUIT, RING_LIFE, createCircuitBoardState, layoutCircuitModules, stepCircuitBoard, type CircuitBoardState } from "./circuitBoard";

// -- State Imports --
import { restSignal } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Geometry } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// The rate cap on beats, in seconds.
const BEAT_GAP = 1 / 3;

/** A frame of a loud passage at the caps: every envelope at 1.6 for part of each beat, full bands, a beat at the rate cap. */
function capped(i: number, level = 0.6): VisualSignal {
  const on = i % 20 === 0;
  const bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
  return { ...restSignal(), bands, level, bassMotion: i % 20 < 8 ? 1.6 : 0, midMotion: i % 50 < 25 ? 1.6 : 0, highMotion: i % 30 < 15 ? 1.6 : 0, beat: on ? 1.5 : 0, drive: LIVELY };
}

/** A quiet 20 s, then a loud passage at the caps: each band crossing well above its own recent mean. */
function drop(i: number, level = 0.9): VisualSignal {
  return i < 60 * 20 ? { ...restSignal(), level: 0.1, drive: LIVELY } : capped(i, level);
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

describe("stepCircuitBoard", () => {
  it("keeps every envelope in range under the caps at Lively", () => {
    const st = createCircuitBoardState();
    const seen = { field: 0, low: 0, lanes: 0, led: 0 };
    let lo = 0;
    let hi = 0;
    let lanesLo = 1;
    let regsHi = 0;
    let ringHi = 0;
    for (let i = 0; i < 60 * 60; i++) {
      stepCircuitBoard(st, drop(i), DT, LIVELY);
      for (const v of [st.field, st.low, st.lanes, st.energy, st.traceV, st.segMix, ...st.bars, ...st.val, ...st.bands, ...st.trace]) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      lanesLo = Math.min(lanesLo, st.lanes);
      regsHi = Math.max(regsHi, ...st.regs);
      // A ring front stands at most at the strength of one beat.
      for (let k = 1; k < st.rings.packed.length; k += 2) ringHi = Math.max(ringHi, st.rings.packed[k]);
      seen.field = Math.max(seen.field, st.field);
      seen.low = Math.max(seen.low, st.low);
      seen.lanes = Math.max(seen.lanes, st.lanes);
      seen.led = Math.max(seen.led, st.val[13]);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lanesLo).toBeGreaterThanOrEqual(0.25 - 1e-6);
    expect(regsHi).toBeLessThanOrEqual(255);
    expect(ringHi).toBeLessThanOrEqual(1);
    // The run reaches the top of each range, so the bounds above are tested against real movement.
    expect(seen.field).toBeGreaterThan(0.5);
    expect(seen.low).toBeGreaterThan(0.5);
    expect(seen.lanes).toBeGreaterThan(0.9);
    expect(seen.led).toBeGreaterThan(0.5);
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
      const sig = { ...restSignal(), level, beat, bassMotion: beat ? 1.6 : 0, midMotion: loud && i % 40 < 20 ? 1.6 : 0, highMotion: loud && i % 24 < 12 ? 1.6 : 0, drive: LIVELY };
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
    // The comets' phase advances 0.14 + 0.7 x energy + 1.4 x surge a second; the surge tops out at 2.08.
    expect(worst.pk).toBeLessThan(0.07);
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

  // Calm is a signal whose own drive is 0 on a playing track; paused is a full Lively signal on a stopped one.
  it.each([
    ["Calm", 0, true],
    ["paused", LIVELY, false],
  ])("gives no beat reaction under %s", (_name, signalDrive, playing) => {
    const st = createCircuitBoardState();
    // The same board fed a silent signal: with no gain, a loud one must leave no trace beyond the level.
    const silent = createCircuitBoardState();
    let ringPeak = 0;
    for (let i = 0; i < 60 * 40; i++) {
      const sig = { ...drop(i), drive: signalDrive };
      const drive = cyberGain(sig, playing);
      expect(drive).toBe(0);
      stepCircuitBoard(st, sig, DT, drive);
      stepCircuitBoard(silent, { ...restSignal(), level: sig.level }, DT, drive);
      expect(st.beatN).toBe(0);
      expect(st.scroll).toBe(0);
      expect(st.segCur).toBe(0);
      expect(st.field + st.low).toBe(0);
      expect(st.lanes).toBe(0.5);
      expect(Math.max(...st.bands)).toBe(0);
      // Only PWR stays lit; SYNC, CLIP, ACT, TX, RX and the channel row stay dark.
      expect(st.val[0]).toBe(1);
      expect(Math.max(...st.val.slice(1))).toBe(0);
      expect(Array.from(st.rings.packed)).toEqual(Array.from(silent.rings.packed));
      expect(st.pk).toBeCloseTo(silent.pk, 9);
      expect(st.traceV).toBeCloseTo(silent.traceV, 9);
      expect(Array.from(st.bars)).toEqual(Array.from(silent.bars));
      for (let k = 1; k < st.rings.packed.length; k += 2) ringPeak = Math.max(ringPeak, st.rings.packed[k]);
    }
    // The idle ring front is there, at half a beat's strength, not a real beat's.
    expect(ringPeak).toBeGreaterThan(0.1);
    expect(ringPeak).toBeLessThanOrEqual(0.5);
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
    expect(st.lanes).toBeCloseTo(0.5, 6);
  });

  /** Plays 30 s of the drop, then 2 s without beats so every ring front has ended. */
  function playedThenQuiet(): CircuitBoardState {
    const st = createCircuitBoardState();
    for (let i = 0; i < 60 * 50; i++) stepCircuitBoard(st, drop(i), DT, LIVELY);
    const still = { ...restSignal(), level: 0.9, drive: LIVELY };
    for (let i = 0; i < 60 * 2; i++) stepCircuitBoard(st, still, DT, LIVELY);
    expect(Math.max(...st.rings.packed)).toBe(0);
    return st;
  }

  const ringHeight = (st: CircuitBoardState) => Math.max(st.rings.packed[1], st.rings.packed[3], st.rings.packed[5]);

  it("launches no idle ring for a full interval after the switch to drive 0, then one", () => {
    const st = playedThenQuiet();
    const still = { ...restSignal(), level: 0.9, drive: LIVELY };
    const paused = cyberGain(still, false);
    let first = -1;
    for (let i = 0; i < 60 * 6; i++) {
      stepCircuitBoard(st, still, DT, paused);
      if (first < 0 && ringHeight(st) > 0) first = i * DT;
    }
    expect(first).toBeGreaterThan(5 - 2 * DT);
    expect(first).toBeLessThan(5 + 2 * DT);
  });

  it("launches no ring when pause is toggled five times inside a second", () => {
    const st = playedThenQuiet();
    const still = { ...restSignal(), level: 0.9, drive: LIVELY };
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      stepCircuitBoard(st, still, DT, i % 12 < 6 ? cyberGain(still, false) : cyberGain(still, true));
      peak = Math.max(peak, ringHeight(st));
    }
    expect(peak).toBe(0);
  });

  /** Beats at `framesPerBeat` for 20 s: the remaining strength of the ring each fourth-or-later beat drops. */
  function droppedRings(framesPerBeat: number): number[] {
    const st = createCircuitBoardState();
    const dropped: number[] = [];
    for (let i = 0; i < 60 * 20; i++) {
      const beat = i % framesPerBeat === 0;
      if (beat) {
        const live = [0, 1, 2].filter((k) => st.rings.packed[k * 2] > 0).length;
        if (live === 3) dropped.push(st.rings.packed[1]);
      }
      stepCircuitBoard(st, { ...restSignal(), level: 0.5, beat: beat ? 1.5 : 0, drive: LIVELY }, DT, LIVELY);
    }
    return dropped;
  }

  it("drops the oldest ring at the fourth beat, mostly faded at 3 beats a second and ended at 1.5", () => {
    // The oldest is 3 gaps old at the fourth beat; a ring's height falls as (1 - age / life) squared.
    const fast = droppedRings(20);
    const expected = (1 - (3 * 20 * DT) / RING_LIFE) ** 2;
    expect(fast.length).toBeGreaterThan(20);
    for (const h of fast) expect(Math.abs(h - expected) / expected).toBeLessThan(0.1);
    expect(expected).toBeLessThan(0.15);
    const slower = droppedRings(30);
    expect(slower.length).toBeGreaterThan(10);
    for (const h of slower) expect(h).toBeLessThan(0.01);
    expect(droppedRings(40).length).toBe(0);
  });

  it("settles back to rest once the music goes quiet", () => {
    const st = createCircuitBoardState();
    for (let i = 0; i < 60 * 50; i++) stepCircuitBoard(st, drop(i), DT, LIVELY);
    expect(st.field + st.low).toBeGreaterThan(0.5);
    const quiet = { ...restSignal(), bands: new Float32Array(24), level: 0.12, drive: LIVELY };
    for (let i = 0; i < 60 * 120; i++) stepCircuitBoard(st, quiet, DT, LIVELY);
    expect(st.field + st.low).toBeLessThan(1e-3);
    expect(st.lanes).toBeCloseTo(0.25, 2);
    expect(Math.max(...st.bars)).toBeLessThan(1e-3);
    expect(Math.max(...st.bands)).toBeLessThan(1e-3);
    // PWR and CH0 idle on: the board never goes fully dark.
    expect(st.val[0]).toBeCloseTo(1, 2);
    expect(st.val[6]).toBeCloseTo(1, 2);
    expect(Math.max(...st.val.slice(1, 6), ...st.val.slice(7))).toBeLessThan(1e-2);
    for (const r of st.rings.packed) expect(r).toBe(0);
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
    expect([a.pk, a.beatN, a.scroll, a.segCur, a.field, a.low]).toEqual([b.pk, b.beatN, b.scroll, b.segCur, b.field, b.low]);
    expect(Array.from(a.trace)).not.toEqual(Array.from(c.trace));
  });
});

describe("layoutCircuitModules", () => {
  const SIZE = { w: 1400, h: 900, dpr: 1 };
  const geo = (cover: [number, number, number, number]): Geometry => ({ cover, radius: 16, mask: null, floor: 120, hush: [[40, 700, 300, 120]] });
  const HALF = [
    [54, 33],
    [54, 39],
    [56, 30],
    [56, 26],
  ];

  it("places every module clear of the chip's buses and inside the stage in the Player", () => {
    const g = geo([400, 380, 300, 300]);
    const out = layoutCircuitModules(g, SIZE, false, new Float32Array(16));
    const cx = 550;
    const cy = 530;
    const busLen = 0.56 * 300 + 0.46 * 300;
    const lanes = 0.56 * 300 + 6;
    let shown = 0;
    for (let i = 0; i < 4; i++) {
      if (out[i * 4 + 2] === 0) continue;
      shown += 1;
      const [x, y] = [out[i * 4], out[i * 4 + 1]];
      const [hw, hh] = HALF[i];
      expect(x - hw).toBeGreaterThanOrEqual(12);
      expect(x + hw).toBeLessThanOrEqual(SIZE.w - 342);
      expect(y - hh).toBeGreaterThanOrEqual(12);
      expect(y + hh).toBeLessThanOrEqual(SIZE.h - 12);
      // Neither bus corridor.
      const overlapsH = x + hw > cx - busLen && x - hw < cx + busLen && y + hh > cy - lanes && y - hh < cy + lanes;
      const overlapsV = x + hw > cx - lanes && x - hw < cx + lanes && y + hh > cy - busLen && y - hh < cy + busLen;
      expect(overlapsH || overlapsV).toBe(false);
      // The transport below the floor line, centred on the cover.
      expect(x + hw > 550 - 300 && x - hw < 550 + 300 && y - hh < 120 + 16).toBe(false);
    }
    expect(shown).toBeGreaterThanOrEqual(3);
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
      const clear = bx - 54 >= x + 60 + 16 || bx + 54 <= x - 60 - 16 || by - 33 >= y + 40 + 16 || by + 33 <= y - 40 - 16;
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
      expect(x + HALF[i][0] > 550 - 300 && x - HALF[i][0] < 550 + 300 && y - HALF[i][1] < 400 + 16).toBe(false);
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
    for (const i of shown(ambient)) expect(ambient[i * 4] + HALF[i][0]).toBeLessThanOrEqual(narrow.w - 12);
  });

  it("clears the output before it writes", () => {
    const out = new Float32Array(16).fill(7);
    layoutCircuitModules(geo([20, 20, 60, 60]), { w: 100, h: 100, dpr: 1 }, true, out);
    expect(Array.from(out)).toEqual(new Array(16).fill(0));
  });
});
