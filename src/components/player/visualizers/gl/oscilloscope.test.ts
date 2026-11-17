// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { cyberGain } from "./cyber";
import { SCOPE, createOscilloscopeState, fitGlass, stepOscilloscope, type OscilloscopeState } from "./oscilloscope";

// -- Type Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
// The step of the long programme runs: the programme's timers do not depend on frame rate, and the app caps a frame at this.
const PDT = 0.1;
const LIVELY = 1.6;
// The rate cap on beats, in seconds.
const BEAT_GAP = 1 / 3;
const GLASS = Float32Array.of(400, 300, 300, 230);
// Where the harmonograph's strike rests with no beats: its decay toward STRIKE_REST (tau 5 s) held against the
// pull toward 0.9 (tau 2 s) that Calm and paused add.
const CALM_STRIKE = (SCOPE.STRIKE_REST / 5 + 0.9 / 2) / (1 / 5 + 1 / 2);

/** A frame of a loud passage at the caps: every envelope at 1.6, a beat at the rate cap. */
function capped(i: number, level = 0.6, drive = LIVELY): VisualSignal {
  const on = i % 20 === 0;
  const bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
  return { ...restSignal(), bands, level, bassMotion: on ? 1.6 : 0, midMotion: 1.6, highMotion: i % 30 < 15 ? 1.6 : 0, beat: on ? 1.5 : 0, drive };
}

/** The sum of the beam's time over all segments, per segment: the share of one period the beam is lit. */
function litShare(st: OscilloscopeState): number {
  let sum = 0;
  for (const w of st.now.w) sum += w;
  return sum / SCOPE.NSEG;
}

interface Programmed {
  figs: string[];
  kinds: string[];
  starts: number[];
}

/** The programme's figure changes over `secs`: the figure each morph leads to, and the kind of morph. */
function programme(seed: number, secs: number, drive: number): Programmed {
  const st = createOscilloscopeState();
  const rng = createRng(seed);
  const out: Programmed = { figs: [], kinds: [], starts: [] };
  let was = false;
  for (let i = 0; i * PDT < secs; i++) {
    stepOscilloscope(st, { ...restSignal(), level: 0.4, drive }, PDT, drive, rng, GLASS);
    const morphing = st.prog.next !== null;
    if (morphing && !was) {
      out.figs.push(st.prog.next!.fig);
      out.kinds.push(st.prog.kind);
      out.starts.push(st.clock);
    }
    was = morphing;
  }
  return out;
}

// One Calm run shared by the tests that read the programme's turnover.
let calmRun: Programmed | null = null;
const calmProgramme = () => (calmRun ??= programme(21, 360, 0));

describe("fitGlass", () => {
  const size = { w: 1600, h: 1000, dpr: 2 };

  it("centres the glass on the cover and keeps it clear of the stage edges and the floor", () => {
    const out = new Float32Array(4);
    // A 200 px (css) cover centred at (400, 250) on an 800 x 500 stage, the floor 60 css px up.
    fitGlass({ cover: [600, 300, 400, 400], radius: 16, mask: null, floor: 120, hush: [] }, size, out);
    expect(out[0]).toBeCloseTo(400, 3);
    expect(out[2]).toBeCloseTo(SCOPE.HX * 200, 3);
    // The glass reaches 0.78 cover widths above the cover's centre, and its bezel stops at the floor and its room.
    expect(out[1] + out[3]).toBeCloseTo(250 + SCOPE.HY * 200, 3);
    expect(out[1] - out[3] - SCOPE.BEZEL).toBeCloseTo(60 + SCOPE.FLOOR_ROOM, 3);
  });

  it("narrows the glass against a stage edge", () => {
    const out = new Float32Array(4);
    fitGlass({ cover: [100, 300, 400, 400], radius: 16, mask: null, floor: null, hush: [] }, size, out);
    expect(out[0]).toBeCloseTo(150, 3);
    expect(out[2]).toBeCloseTo(150 - SCOPE.EDGE - SCOPE.BEZEL, 3);
  });
});

describe("stepOscilloscope", () => {
  it("lights the rest still: a beam on the glass, the cover's label left bare", () => {
    const st = createOscilloscopeState();
    stepOscilloscope(st, restSignal(), DT, 0, createRng(1), GLASS);
    expect(litShare(st)).toBeGreaterThan(0.8);
    const lit = Array.from({ length: SCOPE.NSEG / SCOPE.CHUNK }, (_, c) => st.uBox[c * 4] < 1e5).filter(Boolean).length;
    expect(lit).toBeGreaterThan(20);
    expect(Math.max(...st.uP.map(Math.abs))).toBeLessThan(GLASS[2] * SCOPE.FILL + 1);
    expect(st.power).toBeCloseTo(0.6 + 0.55 * 0.45, 6);
  });

  it("holds a frozen frame as it was", () => {
    const st = createOscilloscopeState();
    const rng = createRng(1);
    for (let i = 0; i < 120; i++) stepOscilloscope(st, capped(i), DT, LIVELY, rng, GLASS);
    const before = { p: st.uP.slice(), clock: st.clock, glass: st.glass.slice() };
    stepOscilloscope(st, capped(7), 0, LIVELY, rng, Float32Array.of(1, 2, 3, 4));
    expect(Array.from(st.uP)).toEqual(Array.from(before.p));
    expect(st.clock).toBe(before.clock);
    expect(Array.from(st.glass)).toEqual(Array.from(before.glass));
  });

  it("keeps every envelope in range under the caps at Lively", () => {
    const st = createOscilloscopeState();
    const rng = createRng(1);
    const lo = { unit: 9, strike: 9, power: 9 };
    const hi = { unit: -9, strike: -9, power: -9, spinV: 0, driftV: 0, ring3: 0 };
    const top = { bass: 0, mid: 0, high: 0 };
    let ring0 = 0.72;
    let finite = true;
    for (let i = 0; i < 60 * 60; i++) {
      // The bass and highs hold at their cap for a second at a time, so the envelopes can reach their top.
      const held = i % 120 < 60 ? 1.6 : 0;
      const sig = { ...capped(i, i % 1200 < 600 ? 0.1 : 0.9), bassMotion: held, highMotion: held };
      stepOscilloscope(st, sig, DT, LIVELY, rng, GLASS);
      const P = st.P;
      for (const v of [P.bass, P.mid, P.high, P.midSlow, st.density, st.mode]) {
        lo.unit = Math.min(lo.unit, v);
        hi.unit = Math.max(hi.unit, v);
      }
      lo.strike = Math.min(lo.strike, P.strike);
      hi.strike = Math.max(hi.strike, P.strike);
      lo.power = Math.min(lo.power, st.power);
      hi.power = Math.max(hi.power, st.power);
      hi.spinV = Math.max(hi.spinV, P.spinV);
      hi.driftV = Math.max(hi.driftV, P.driftV);
      hi.ring3 = Math.max(hi.ring3, P.ringR[3]);
      ring0 = P.ringR[0];
      top.bass = Math.max(top.bass, P.bass);
      top.mid = Math.max(top.mid, P.mid);
      top.high = Math.max(top.high, P.high);
      if (i % 60 === 0) finite &&= st.uP.every(Number.isFinite) && st.uD.every(Number.isFinite) && st.knob.every(Number.isFinite);
    }
    expect(finite).toBe(true);
    expect(lo.unit).toBeGreaterThanOrEqual(0);
    expect(hi.unit).toBeLessThanOrEqual(1);
    expect(lo.strike).toBeGreaterThanOrEqual(0.7);
    expect(hi.strike).toBeLessThanOrEqual(1.0);
    expect(hi.spinV).toBeLessThanOrEqual(SCOPE.SPIN[1]);
    expect(hi.driftV).toBeLessThanOrEqual(SCOPE.DRIFT[1]);
    expect(ring0).toBe(0.72);
    expect(hi.ring3).toBeLessThanOrEqual(0.72 + 3 * 0.09 + 1e-6);
    expect(lo.power).toBeGreaterThanOrEqual(0.6);
    expect(hi.power).toBeLessThanOrEqual(0.6 + 0.55);
    // The run reaches the top of each range, so the bounds above are not met by sitting at rest.
    expect(top.bass).toBeGreaterThan(0.9);
    expect(top.mid).toBeGreaterThan(0.9);
    expect(top.high).toBeGreaterThan(0.9);
    expect(hi.strike).toBeGreaterThan(0.95);
    expect(hi.ring3).toBeGreaterThan(0.72 + 3 * 0.09 - 0.05);
  });

  it("moves everything in small steps with Lively beats at the cap", () => {
    const st = createOscilloscopeState();
    const rng = createRng(2);
    const worst = { bass: 0, mid: 0, high: 0, spin: 0, phase: 0, mode: 0, knob: 0, morph: 0, strike: 0, ringR: 0 };
    let prev = { bass: 0, mid: 0, high: 0, spin: 0, phase: 0, mode: 0, knob: new Float32Array(6), s: 0, strike: 0.9, ringR: 0.81 };
    let nextBeat = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const t = i * DT;
      const beat = t >= nextBeat ? 1.5 : 0;
      if (beat) nextBeat += BEAT_GAP;
      const level = t % 30 < 15 ? 0.1 : 0.9;
      stepOscilloscope(
        st,
        { ...restSignal(), level, beat, bassMotion: beat ? 1.6 : 0, midMotion: i % 40 < 20 ? 1.6 : 0, highMotion: 1.6, drive: LIVELY },
        DT,
        LIVELY,
        rng,
        GLASS,
      );
      const P = st.P;
      worst.bass = Math.max(worst.bass, Math.abs(P.bass - prev.bass));
      worst.mid = Math.max(worst.mid, Math.abs(P.mid - prev.mid));
      worst.high = Math.max(worst.high, Math.abs(P.high - prev.high));
      worst.spin = Math.max(worst.spin, Math.abs(P.spin - prev.spin));
      worst.phase = Math.max(worst.phase, Math.abs(P.phase - prev.phase));
      worst.mode = Math.max(worst.mode, Math.abs(st.mode - prev.mode));
      worst.strike = Math.max(worst.strike, Math.abs(P.strike - prev.strike));
      worst.ringR = Math.max(worst.ringR, Math.abs(P.ringR[3] - prev.ringR));
      for (let k = 0; k < 6; k++) worst.knob = Math.max(worst.knob, Math.abs(st.knob[k] - prev.knob[k]));
      if (st.prog.next && prev.s > 0) worst.morph = Math.max(worst.morph, st.prog.s - prev.s);
      prev = { bass: P.bass, mid: P.mid, high: P.high, spin: P.spin, phase: P.phase, mode: st.mode, knob: st.knob.slice(), s: st.prog.next ? st.prog.s : 0, strike: P.strike, ringR: P.ringR[3] };
    }
    // The fastest attack of each band moves it at most 1 - exp(-dt / tau) of the full range a frame.
    expect(worst.bass).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.14) + 1e-9);
    expect(worst.mid).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.25) + 1e-9);
    expect(worst.high).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.2) + 1e-9);
    // Spin turns at most SPIN[1] rad/s.
    expect(worst.spin).toBeLessThanOrEqual(SCOPE.SPIN[1] * DT + 1e-9);
    // Phase turns at its drift cap plus the beat kicks: at 3 beats a second, well under 2 rad/s.
    expect(worst.phase).toBeLessThan(0.04);
    expect(worst.phase).toBeGreaterThan(SCOPE.DRIFT[0] * DT);
    // The mode switch and the strike glide.
    expect(worst.mode).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.15) + 1e-9);
    expect(worst.strike).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.25) + 1e-9);
    expect(worst.ringR).toBeLessThan(0.03);
    // A morph never advances faster than its shortest length.
    expect(worst.morph).toBeLessThanOrEqual(DT / SCOPE.MORPH_SECTION + 1e-9);
    expect(worst.morph).toBeGreaterThan(0);
    // The knobs turn a few degrees a frame at most.
    expect(worst.knob).toBeLessThan(0.3);
  });

  it("keeps the beam's light the same through every figure and morph", () => {
    const st = createOscilloscopeState();
    const rng = createRng(11);
    let lo = 9;
    let hi = 0;
    let morphs = 0;
    const seen = new Set<string>();
    for (let i = 0; i * PDT < 400; i++) {
      stepOscilloscope(st, capped(i, 0.3 + 0.5 * Math.abs(Math.sin(i / 400))), PDT, LIVELY, rng, GLASS);
      const share = litShare(st);
      lo = Math.min(lo, share);
      hi = Math.max(hi, share);
      seen.add(st.prog.cur.fig);
      if (i > 0 && st.prog.next && st.prog.s < PDT / 2) morphs++;
    }
    expect(morphs).toBeGreaterThan(8);
    expect(seen.size).toBeGreaterThan(5);
    // One period of beam time spread over the lit path: at most the whole period, never less than the trace's share.
    expect(hi).toBeLessThanOrEqual(1 + 1e-3);
    expect(lo).toBeGreaterThan(0.85);
  });

  it("gives no beat reaction under Calm or while paused", () => {
    const calm = { gain: cyberGain({ ...restSignal(), drive: 0 }, true), drive: 0 };
    const paused = { gain: cyberGain({ ...restSignal(), drive: LIVELY }, false), drive: LIVELY };
    expect(calm.gain).toBe(0);
    expect(paused.gain).toBe(0);
    for (const { gain, drive } of [calm, paused]) {
      const st = createOscilloscopeState();
      const rng = createRng(4);
      const quiet = createOscilloscopeState();
      const quietRng = createRng(4);
      const broke = { bands: 0, kick: 0, strikeTo: 0, phase: 0, strike: 0, beam: 0 };
      for (let i = 0; i < 60 * 15; i++) {
        stepOscilloscope(st, capped(i, 0.4, drive), DT, gain, rng, GLASS);
        // The same level and bass motion with no bands, beats, mids or highs.
        const bare = { ...restSignal(), level: 0.4, bassMotion: i % 20 === 0 ? 1.6 : 0, drive };
        stepOscilloscope(quiet, bare, DT, gain, quietRng, GLASS);
        const P = st.P;
        if (P.bass + P.mid + P.high !== 0) broke.bands++;
        if (P.kickTo !== 0 || P.hpTo !== 0) broke.kick++;
        if (P.strikeTo > 0.9 + 1e-9) broke.strikeTo++;
        if (P.phase !== quiet.P.phase) broke.phase++;
        if (P.strike !== quiet.P.strike) broke.strike++;
        if (i % 150 === 0 && st.uP.some((v, k) => v !== quiet.uP[k])) broke.beam++;
      }
      expect(broke).toEqual({ bands: 0, kick: 0, strikeTo: 0, phase: 0, strike: 0, beam: 0 });
      expect(st.P.strike).toBeCloseTo(CALM_STRIKE, 2);
    }
    // The same run at Lively does react, so the checks above can fail.
    const live = createOscilloscopeState();
    const rng = createRng(4);
    for (let i = 0; i < 60 * 10; i++) stepOscilloscope(live, capped(i, 0.4), DT, LIVELY, rng, GLASS);
    expect(live.P.kickTo).toBeGreaterThan(1);
    expect(live.P.hpTo).toBeGreaterThan(1);
    expect(live.P.bass + live.P.mid + live.P.high).toBeGreaterThan(0.5);
  });

  it("reads the level alone under Calm, whatever bass motion the signal carries", () => {
    const run = (pulse: boolean) => {
      const st = createOscilloscopeState();
      const rng = createRng(6);
      for (let i = 0; i < 60 * 40; i++) {
        const level = 0.3 + 0.2 * Math.sin(i / 200);
        const bassMotion = pulse && i % 90 < 30 ? 1.6 : 0;
        stepOscilloscope(st, { ...restSignal(), level, bassMotion, drive: 0 }, DT, 0, rng, GLASS);
      }
      return st;
    };
    const a = run(true);
    const b = run(false);
    expect(a.P.rings).toBe(b.P.rings);
    expect(a.density).toBe(b.density);
    expect(a.rel).toBe(b.rel);
    expect(Array.from(a.uP)).toEqual(Array.from(b.uP));
  });

  it("eases to rest when playing switches to paused", () => {
    const st = createOscilloscopeState();
    const rng = createRng(9);
    for (let i = 0; i < 60 * 20; i++) stepOscilloscope(st, capped(i, 0.6), DT, LIVELY, rng, GLASS);
    const before = { bass: st.P.bass, mid: st.P.mid, high: st.P.high, strike: st.P.strike, phase: st.P.phase, kick: st.P.kick };
    expect(before.bass + before.mid + before.high).toBeGreaterThan(0.3);
    const paused = capped(1, 0.6);
    const gain = cyberGain({ ...paused, drive: LIVELY }, false);
    stepOscilloscope(st, paused, DT, gain, rng, GLASS);
    // The first paused frame eases: each band falls by at most its release step, none snaps to zero.
    expect(st.P.bass).toBeGreaterThan(before.bass * (1 - (1 - Math.exp(-DT / 0.6))) - 1e-9);
    expect(st.P.bass).toBeLessThan(before.bass);
    expect(st.P.mid).toBeGreaterThan(before.mid * Math.exp(-DT / 0.8) - 1e-9);
    expect(st.P.high).toBeGreaterThan(before.high * Math.exp(-DT / 0.7) - 1e-9);
    for (let i = 0; i < 60 * 12; i++) stepOscilloscope(st, capped(i, 0.6), DT, gain, rng, GLASS);
    expect(st.P.bass + st.P.mid + st.P.high).toBeLessThan(1e-3);
    // The last kick finishes and no more arrive: the phase only drifts.
    const phase = st.P.phase;
    stepOscilloscope(st, capped(20, 0.6), DT, gain, rng, GLASS);
    expect(Math.abs(st.P.phase - phase - DT * st.P.driftV)).toBeLessThan(1e-3);
    expect(st.P.strike).toBeCloseTo(CALM_STRIKE, 2);
  });

  it("settles back to rest once the beats stop", () => {
    const st = createOscilloscopeState();
    const rng = createRng(5);
    for (let i = 0; i < 60 * 20; i++) stepOscilloscope(st, capped(i), DT, LIVELY, rng, GLASS);
    expect(st.P.kickTo).toBeGreaterThan(1);
    const quiet = { ...restSignal(), level: 0.6, drive: LIVELY };
    for (let i = 0; i * PDT < 90; i++) stepOscilloscope(st, quiet, PDT, LIVELY, rng, GLASS);
    const P = st.P;
    expect(P.bass + P.mid + P.high + P.midSlow).toBeLessThan(1e-3);
    expect(P.strikeTo).toBeCloseTo(SCOPE.STRIKE_REST, 3);
    expect(P.strike).toBeCloseTo(SCOPE.STRIKE_REST, 2);
    expect(Math.abs(P.kickTo - P.kick)).toBeLessThan(1e-3);
    expect(P.spinV).toBeLessThan(SCOPE.SPIN[0] + (SCOPE.SPIN[1] - SCOPE.SPIN[0]) * 0.55);
  });

  it("alternates fold and bloom, and never repeats a recent figure", () => {
    const { figs, kinds } = calmProgramme();
    expect(figs.length).toBeGreaterThan(8);
    expect(kinds[0]).toBe("fold");
    kinds.forEach((k, i) => expect(k).toBe(i % 2 === 0 ? "fold" : "bloom"));
    for (let i = 2; i < figs.length; i++) {
      expect(figs[i]).not.toBe(figs[i - 1]);
      expect(figs[i]).not.toBe(figs[i - 2]);
    }
    expect(new Set(figs).size).toBeGreaterThan(3);
  });

  it("turns the programme over every 28 to 36 s under Calm", () => {
    const { starts } = calmProgramme();
    expect(starts.length).toBeGreaterThan(8);
    // First hold is the initial 14 s; after that a morph, then a hold from HOLD_CALM.
    expect(starts[0]).toBeGreaterThan(14);
    expect(starts[0]).toBeLessThan(14 + 2 * PDT);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      expect(gap).toBeGreaterThan(SCOPE.HOLD_CALM[0] + SCOPE.MORPH_CALM);
      expect(gap).toBeLessThan(SCOPE.HOLD_CALM[1] + SCOPE.MORPH_CALM + 2 * PDT);
    }
  });

  it("cuts in on a section change, but not before the figure has held MIN_HOLD", () => {
    const st = createOscilloscopeState();
    const rng = createRng(23);
    const starts: { held: number; dur: number }[] = [];
    let was = false;
    for (let i = 0; i * PDT < 240; i++) {
      // The intensity swings across its own mean every 5 s, faster than a figure may be cut.
      const level = (i * PDT) % 10 < 5 ? 0.1 : 0.9;
      stepOscilloscope(st, { ...restSignal(), level, drive: LIVELY }, PDT, LIVELY, rng, GLASS);
      const morphing = st.prog.next !== null;
      if (morphing && !was) starts.push({ held: st.prog.held, dur: st.prog.dur });
      was = morphing;
    }
    const sections = starts.filter((s) => s.dur === SCOPE.MORPH_SECTION);
    expect(sections.length).toBeGreaterThan(3);
    for (const s of sections) expect(s.held).toBeGreaterThan(SCOPE.MIN_HOLD);
    // Section changes turn over sooner than the timer's shortest hold would.
    expect(Math.min(...sections.map((s) => s.held))).toBeLessThan(SCOPE.HOLD[0] * 0.55);
    // A change on the timer takes the long morph.
    for (const s of starts) expect([SCOPE.MORPH, SCOPE.MORPH_SECTION]).toContain(s.dur);
  });

  it("replays the same programme from the same seed", () => {
    const a = calmProgramme();
    const b = programme(21, 360, 0);
    const c = programme(32, 360, 0);
    expect(a.figs).toEqual(b.figs);
    expect(a.starts).toEqual(b.starts);
    expect(c.figs.join()).not.toBe(a.figs.join());
  });

  it("replays the same beam from the same seed", () => {
    const run = (seed: number) => {
      const st = createOscilloscopeState();
      const rng = createRng(seed);
      for (let i = 0; i < 60 * 30; i++) stepOscilloscope(st, capped(i), DT, LIVELY, rng, GLASS);
      return Array.from(st.uP.slice(0, 64));
    };
    expect(run(41)).toEqual(run(41));
    expect(run(41)).not.toEqual(run(42));
  });
});
