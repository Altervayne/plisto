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

/**
 * A frame of a loud passage at the caps: every envelope and hit at 1.6, a beat at the rate cap whose weight
 * rises to 1.6 over its first frames, and a surge and a cut every 10 s. The loudness follows the level.
 */
function capped(i: number, level = 0.6, drive = LIVELY): VisualSignal {
  const on = i % 20 === 0;
  const k = i % 20;
  const bands = new Float32Array(24).fill(i % 40 < 20 ? 1 : 0.2);
  return {
    ...restSignal(),
    bands,
    level,
    loudness: level,
    bassMotion: on ? 1.6 : 0,
    midMotion: 1.6,
    highMotion: i % 30 < 15 ? 1.6 : 0,
    beat: on ? 1.5 : 0,
    beatWeight: k < 6 ? 1.6 * Math.min(1, (k + 1) / 3) : 0,
    bassHit: k < 4 ? 1.6 : 0,
    midHit: i % 15 < 3 ? 1.6 : 0,
    highHit: i % 10 < 2 ? 1.6 : 0,
    surge: i % 600 === 300 ? 1.6 : 0,
    cut: i % 600 === 450 ? 1.6 : 0,
    drive,
  };
}

/** A quiet frame at `loudness` with one beat of `weight` on frame `at`, its weight held for six frames. */
function beatAt(i: number, at: number, weight: number, loudness = 0.8): VisualSignal {
  const k = i - at;
  return { ...restSignal(), level: 0.9, loudness, beat: k === 0 ? LIVELY : 0, beatWeight: k >= 0 && k < 6 ? weight : 0, drive: LIVELY };
}

/** The largest |x| and |y| of the beam's path now, css px from the glass centre. */
function extent(st: OscilloscopeState): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let k = 0; k <= SCOPE.NSEG; k++) {
    x = Math.max(x, Math.abs(st.uP[k * 4]));
    y = Math.max(y, Math.abs(st.uP[k * 4 + 1]));
  }
  return { x, y };
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

  it("fills the stage inside the frame: the sides, the top strip and the control row above the floor", () => {
    const out = new Float32Array(4);
    // An 800 x 500 (css) stage, the floor 60 css px up.
    fitGlass({ cover: [600, 300, 400, 400], radius: 16, mask: null, floor: 120, hush: [] }, size, out);
    expect(out[0]).toBeCloseTo(400, 3);
    expect(out[0] - out[2] - SCOPE.BEZEL).toBeCloseTo(SCOPE.EDGE, 3);
    expect(out[0] + out[2] + SCOPE.BEZEL).toBeCloseTo(800 - SCOPE.EDGE, 3);
    expect(out[1] + out[3] + SCOPE.BEZEL).toBeCloseTo(500 - SCOPE.TOP_ROOM, 3);
    expect(out[1] - out[3] - SCOPE.BEZEL).toBeCloseTo(60 + SCOPE.FLOOR_ROOM, 3);
  });

  it("keeps the glass on the stage wherever the cover sits", () => {
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    fitGlass({ cover: [100, 300, 400, 400], radius: 16, mask: null, floor: null, hush: [] }, size, a);
    fitGlass({ cover: [900, 100, 300, 300], radius: 16, mask: null, floor: null, hush: [] }, size, b);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a[1] - a[3] - SCOPE.BEZEL).toBeCloseTo(SCOPE.FLOOR_ROOM, 3);
  });

  it("gives the glass at least two thirds of the Player and the ambient stage", () => {
    const share = (w: number, h: number, floor: number, cover: [number, number, number, number]) => {
      const out = new Float32Array(4);
      fitGlass({ cover, radius: 16, mask: null, floor, hush: [] }, { w, h, dpr: 1 }, out);
      return (4 * out[2] * out[3]) / (w * h);
    };
    // The Player: 1000 x 680 with a 340 px cover and the floor 80 px up; ambient: 1280 x 800, a 400 px cover on the left, the floor 143 px up.
    const player = share(1000, 680, 80, [330, 250, 340, 340]);
    const ambient = share(1280, 800, 143, [170, 275, 400, 400]);
    expect(player).toBeGreaterThan(0.69);
    expect(ambient).toBeGreaterThan(0.66);
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
    expect(st.power).toBeCloseTo(SCOPE.POWER[0] + SCOPE.POWER[1] * 0.3, 6);
    expect(st.bloom).toBe(0);
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
    const lo = { unit: 9, strike: 9, power: 9, size: 9 };
    const hi = { unit: -9, strike: -9, power: -9, spinV: 0, driftV: 0, ring3: 0, size: 0, bloom: 0 };
    const top = { bass: 0, mid: 0, high: 0, bh: 0, cut: 0, surge: 0 };
    let ring0 = 0.72;
    let finite = true;
    for (let i = 0; i < 60 * 60; i++) {
      // The bass and highs hold at their cap for a second at a time, so the envelopes can reach their top.
      const held = i % 120 < 60 ? 1.6 : 0;
      const sig = { ...capped(i, i % 1200 < 600 ? 0.1 : 0.9), bassMotion: held, highMotion: held };
      stepOscilloscope(st, sig, DT, LIVELY, rng, GLASS);
      const P = st.P;
      for (const v of [P.bass, P.mid, P.high, P.midSlow, st.density, st.mode, P.loud, P.bh, P.mh, P.hh, P.cut, P.surge, P.bloom]) {
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
      lo.size = Math.min(lo.size, P.size);
      hi.size = Math.max(hi.size, P.size);
      hi.bloom = Math.max(hi.bloom, st.bloom);
      ring0 = P.ringR[0];
      top.bass = Math.max(top.bass, P.bass);
      top.mid = Math.max(top.mid, P.mid);
      top.high = Math.max(top.high, P.high);
      top.bh = Math.max(top.bh, P.bh);
      top.cut = Math.max(top.cut, P.cut);
      top.surge = Math.max(top.surge, P.surge);
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
    expect(lo.power).toBeGreaterThanOrEqual(SCOPE.POWER[0]);
    expect(hi.power).toBeLessThanOrEqual(SCOPE.POWER[0] + SCOPE.POWER[1]);
    // The figure never grows past the glass, and only a cut takes it under the quiet size.
    expect(lo.size).toBeGreaterThanOrEqual(SCOPE.SIZE[0] - 1e-9);
    expect(hi.size).toBeLessThanOrEqual(1);
    expect(hi.bloom).toBeLessThanOrEqual(1);
    // The run reaches the top of each range, so the bounds above are not met by sitting at rest.
    expect(top.bass).toBeGreaterThan(0.9);
    expect(top.mid).toBeGreaterThan(0.9);
    expect(top.high).toBeGreaterThan(0.9);
    expect(top.bh).toBe(1);
    expect(top.cut).toBeGreaterThan(0.8);
    expect(top.surge).toBeGreaterThan(0.95);
    expect(hi.strike).toBeGreaterThan(0.95);
    expect(hi.size).toBeGreaterThan(0.97);
    expect(hi.bloom).toBe(1);
    expect(hi.ring3).toBeGreaterThan(0.72 + 3 * 0.09 - 0.05);
  });

  it("moves everything in small steps with Lively beats at the cap", () => {
    const st = createOscilloscopeState();
    const rng = createRng(2);
    const worst = { bass: 0, mid: 0, high: 0, spin: 0, phase: 0, mode: 0, knob: 0, morph: 0, strike: 0, ringR: 0 };
    let prev = { bass: 0, mid: 0, high: 0, spin: 0, phase: 0, mode: 0, knob: new Float32Array(6), s: 0, strike: 0.9, ringR: 0.81 };
    let nextBeat = 0;
    let beatFrame = -99;
    for (let i = 0; i < 60 * 60; i++) {
      const t = i * DT;
      const beat = t >= nextBeat ? 1.5 : 0;
      if (beat) {
        nextBeat += BEAT_GAP;
        beatFrame = i;
      }
      const beatWeight = i - beatFrame < 6 ? 1.6 : 0;
      const level = t % 30 < 15 ? 0.1 : 0.9;
      stepOscilloscope(
        st,
        { ...restSignal(), level, loudness: level, beat, beatWeight, bassMotion: beat ? 1.6 : 0, midMotion: i % 40 < 20 ? 1.6 : 0, highMotion: 1.6, drive: LIVELY },
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
    // Phase turns at its drift cap plus the eased beat kicks: at 3 full-weight beats a second the kick's backlog
    // peaks at one kick over the share the ease leaves between beats (a frame short of the cap's gap, as beats
    // land on frames), and a frame takes its ease's share of that.
    const backlog = (SCOPE.KICK * 1.6) / (1 - Math.exp(-(BEAT_GAP - DT) / SCOPE.KICK_TAU));
    expect(worst.phase).toBeLessThanOrEqual(SCOPE.DRIFT[1] * DT + backlog * (1 - Math.exp(-DT / SCOPE.KICK_TAU)) + 1e-6);
    // A full-weight beat turns the figure over visibly: over 0.05 rad in a frame.
    expect(worst.phase).toBeGreaterThan(0.05);
    // The mode switch and the strike glide.
    expect(worst.mode).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.15) + 1e-9);
    expect(worst.strike).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.25) + 1e-9);
    expect(worst.ringR).toBeLessThan(0.03);
    // A morph never advances faster than its shortest length.
    expect(worst.morph).toBeLessThanOrEqual(DT / Math.min(SCOPE.MORPH_SECTION, SCOPE.MORPH_SURGE) + 1e-9);
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
      const broke = { bands: 0, kick: 0, strikeTo: 0, phase: 0, strike: 0, beam: 0, hits: 0, beat: 0, shift: 0, programme: 0 };
      for (let i = 0; i < 60 * 15; i++) {
        stepOscilloscope(st, capped(i, 0.4, drive), DT, gain, rng, GLASS);
        // The same level, loudness and bass motion with no bands, beats, hits, shifts, mids or highs.
        const bare = { ...restSignal(), level: 0.4, loudness: 0.4, bassMotion: i % 20 === 0 ? 1.6 : 0, drive };
        stepOscilloscope(quiet, bare, DT, gain, quietRng, GLASS);
        const P = st.P;
        if (P.bass + P.mid + P.high !== 0) broke.bands++;
        if (P.kickTo !== 0 || P.hpTo !== 0) broke.kick++;
        if (P.strikeTo > 0.9 + 1e-9) broke.strikeTo++;
        if (P.phase !== quiet.P.phase) broke.phase++;
        if (P.strike !== quiet.P.strike) broke.strike++;
        if (P.bh + P.mh + P.hh !== 0) broke.hits++;
        if (P.pop + P.bloom + st.bloom !== 0 || P.size !== quiet.P.size) broke.beat++;
        if (P.surge + P.cut !== 0) broke.shift++;
        if (st.prog.next?.fig !== quiet.prog.next?.fig || st.prog.held !== quiet.prog.held) broke.programme++;
        if (i % 150 === 0 && st.uP.some((v, k) => v !== quiet.uP[k])) broke.beam++;
      }
      expect(broke).toEqual({ bands: 0, kick: 0, strikeTo: 0, phase: 0, strike: 0, beam: 0, hits: 0, beat: 0, shift: 0, programme: 0 });
      expect(st.P.strike).toBeCloseTo(CALM_STRIKE, 2);
    }
    // The same run at Lively does react, so the checks above can fail.
    const live = createOscilloscopeState();
    const rng = createRng(4);
    let shifted = 0;
    for (let i = 0; i < 60 * 10; i++) {
      stepOscilloscope(live, capped(i, 0.4), DT, LIVELY, rng, GLASS);
      shifted = Math.max(shifted, live.P.surge + live.P.cut);
    }
    expect(live.P.kickTo).toBeGreaterThan(1);
    expect(live.P.hpTo).toBeGreaterThan(1);
    expect(live.P.bass + live.P.mid + live.P.high).toBeGreaterThan(0.5);
    expect(live.P.bh + live.P.mh + live.P.hh).toBeGreaterThan(0);
    expect(live.P.pop).toBeGreaterThan(0);
    expect(shifted).toBeGreaterThan(0.5);
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
    expect(P.bh + P.mh + P.hh + P.pop + P.bloom + P.surge + P.cut + st.bloom).toBeLessThan(1e-3);
    expect(P.size).toBeCloseTo(SCOPE.SIZE[0] + (SCOPE.SIZE[1] - SCOPE.SIZE[0]) * 0.3, 3);
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

describe("stepOscilloscope reactions", () => {
  // A wide glass, so the X-Y figure is held by its height.
  const WIDE = Float32Array.of(500, 300, 460, 240);

  it("draws a near-silent passage small, slow and dim, and a loud one large, fast and bright", () => {
    const run = (loudness: number) => {
      const st = createOscilloscopeState();
      const rng = createRng(3);
      for (let i = 0; i < 60 * 6; i++) stepOscilloscope(st, { ...restSignal(), level: 0.95, loudness, drive: LIVELY }, DT, LIVELY, rng, WIDE);
      return { size: st.P.size, spinV: st.P.spinV, power: st.power, y: extent(st).y };
    };
    const quiet = run(0.08);
    const loud = run(0.88);
    expect(quiet.size).toBeLessThan(SCOPE.SIZE[0] + 0.05);
    expect(loud.size).toBeGreaterThan(SCOPE.SIZE[1] - 0.05);
    expect(loud.y).toBeGreaterThan(quiet.y * 1.2);
    expect(loud.spinV).toBeGreaterThan(quiet.spinV * 2.5);
    expect(loud.power).toBeGreaterThan(quiet.power * 2.5);
  });

  it("kicks the phase, jumps the size and blooms by the beat's weight, not by the beat alone", () => {
    const run = (weight: number) => {
      const st = createOscilloscopeState();
      const rng = createRng(3);
      for (let i = 0; i < 60 * 3; i++) stepOscilloscope(st, beatAt(i, 999, 0), DT, LIVELY, rng, WIDE);
      const before = { kickTo: st.P.kickTo, size: st.P.size };
      let size = 0;
      let bloom = 0;
      for (let i = 0; i < 12; i++) {
        stepOscilloscope(st, beatAt(i, 0, weight), DT, LIVELY, rng, WIDE);
        size = Math.max(size, st.P.size);
        bloom = Math.max(bloom, st.bloom);
      }
      return { kick: st.P.kickTo - before.kickTo, jump: size - before.size, bloom, strikeTo: st.P.strikeTo };
    };
    const none = run(0);
    const soft = run(0.25);
    const full = run(1);
    expect(none).toEqual({ kick: 0, jump: 0, bloom: 0, strikeTo: expect.any(Number) });
    expect(full.kick).toBeCloseTo(SCOPE.KICK, 6);
    expect(soft.kick).toBeCloseTo(SCOPE.KICK * 0.25, 6);
    expect(full.jump).toBeGreaterThan(0.08);
    expect(full.jump).toBeGreaterThan(soft.jump * 3);
    expect(full.bloom).toBe(1);
    expect(soft.bloom).toBeCloseTo(0.25, 6);
    expect(full.strikeTo).toBeGreaterThan(soft.strikeTo);
    expect(full.strikeTo).toBeGreaterThan(none.strikeTo);
  });

  it("re-strikes the harmonograph on every beat at the rate cap", () => {
    const st = createOscilloscopeState();
    const rng = createRng(3);
    let beats = 0;
    for (let i = 0; i < 60 * 6; i++) {
      const at = Math.floor(i / 20) * 20;
      if (i === at) beats++;
      stepOscilloscope(st, beatAt(i, at, 1), DT, LIVELY, rng, WIDE);
    }
    expect(st.P.hpTo).toBeCloseTo(0.6 * beats, 6);
  });

  it("pushes the figure's shape on a hit, then lets it go", () => {
    const run = (hit: boolean) => {
      const st = createOscilloscopeState();
      const rng = createRng(3);
      const peak = { bh: 0 };
      for (let i = 0; i < 60 * 2; i++) {
        const on = hit && i >= 100 && i < 106;
        stepOscilloscope(st, { ...restSignal(), loudness: 0.8, bassHit: on ? 1.6 : 0, midHit: on ? 1.6 : 0, drive: LIVELY }, DT, LIVELY, rng, WIDE);
        peak.bh = Math.max(peak.bh, st.P.bh);
        if (i === 106) return { st, peak };
      }
      return { st, peak };
    };
    const hit = run(true);
    const bare = run(false);
    expect(hit.peak.bh).toBe(1);
    expect(hit.st.uP.some((v, k) => Math.abs(v - bare.st.uP[k]) > 2)).toBe(true);
    // Half a second later the hit has gone.
    const st = hit.st;
    for (let i = 0; i < 30; i++) stepOscilloscope(st, { ...restSignal(), loudness: 0.8, drive: LIVELY }, DT, LIVELY, createRng(1), WIDE);
    expect(st.P.bh + st.P.mh).toBeLessThan(0.05);
  });

  it("restrikes into a new, larger figure with a bloom on a surge", () => {
    const st = createOscilloscopeState();
    const rng = createRng(3);
    const sig = (surge: number) => ({ ...restSignal(), level: 0.9, loudness: 0.85, surge, drive: LIVELY });
    for (let i = 0; i < 60 * 3; i++) stepOscilloscope(st, sig(0), DT, LIVELY, rng, WIDE);
    const before = { fig: st.prog.cur.fig, size: st.P.size };
    expect(st.prog.next).toBeNull();
    stepOscilloscope(st, sig(1), DT, LIVELY, rng, WIDE);
    expect(st.prog.next).not.toBeNull();
    expect(st.prog.next!.fig).not.toBe(before.fig);
    expect(st.prog.kind).toBe("bloom");
    expect(st.prog.dur).toBe(SCOPE.MORPH_SURGE);
    expect(st.P.strikeTo).toBe(1);
    expect(st.P.size).toBeGreaterThan(before.size + 0.05);
    expect(st.bloom).toBeGreaterThan(0.75);
    // The lift fades over a few seconds.
    for (let i = 0; i < 60 * 10; i++) stepOscilloscope(st, sig(0), DT, LIVELY, rng, WIDE);
    expect(st.P.size).toBeCloseTo(before.size, 2);
  });

  it("collapses the figure toward a flat line on a cut, then lets it grow back", () => {
    const st = createOscilloscopeState();
    const rng = createRng(3);
    const sig = (cut: number) => ({ ...restSignal(), level: 0.9, loudness: 0.6, cut, drive: LIVELY });
    for (let i = 0; i < 60 * 3; i++) stepOscilloscope(st, sig(0), DT, LIVELY, rng, WIDE);
    const open = extent(st);
    stepOscilloscope(st, sig(1), DT, LIVELY, rng, WIDE);
    for (let i = 0; i < 18; i++) stepOscilloscope(st, sig(0), DT, LIVELY, rng, WIDE);
    const shut = extent(st);
    expect(st.P.cut).toBeGreaterThan(0.75);
    expect(shut.y).toBeLessThan(open.y * 0.35);
    expect(shut.x).toBeLessThan(open.x);
    for (let i = 0; i < 60 * 6; i++) stepOscilloscope(st, sig(0), DT, LIVELY, rng, WIDE);
    expect(st.P.cut).toBeLessThan(0.02);
    expect(extent(st).y).toBeGreaterThan(open.y * 0.8);
  });
});
