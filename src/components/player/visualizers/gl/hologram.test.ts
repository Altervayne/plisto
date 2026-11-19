// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createRng } from "./cozy";
import { cyberGain } from "./cyber";
import { HOLO, HOLOGRAM_PROGRAMS, createHologramState, createSolidFrame, solidFrame, stepHologram, type HologramState, type SolidFrame } from "./hologram";

// -- Type Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// The rate cap on beats, in seconds.
const BEAT_GAP = 1 / 3;
// A cover width in css px for the solid's frame.
const CW = 400;
// The slide, in px, below which a slice is taken as not moving.
const VISIBLE = 0.5;

/**
 * A frame of a loud passage at the caps: every envelope and hit at 1.6, full bands, a beat at the rate cap whose
 * weight is held for six frames, and loudness equal to `level`.
 */
function capped(i: number, level = 0.6): VisualSignal {
  const on = i % 20 === 0;
  const held = i % 20 < 6;
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
    beatWeight: held ? LIVELY : 0,
    bassHit: held ? LIVELY : 0,
    midHit: i % 10 < 6 ? LIVELY : 0,
    highHit: i % 7 < 4 ? LIVELY : 0,
    drive: LIVELY,
  };
}

/** One beat at frame 0 whose weight rises to `weight` over its six-frame hold, at loudness `loudness`. */
function beatAt(i: number, weight: number, loudness = 0.85): VisualSignal {
  const w = i < 6 ? weight * (0.5 + 0.1 * i) : 0;
  return { ...restSignal(), level: 0.95, loudness, beat: i === 0 ? LIVELY : 0, beatWeight: w, drive: LIVELY };
}

/** Steps a fresh state through `frames` frames of `sig(i)` at Lively and returns it with the peak of each solid reaction. */
function runPeaks(frames: number, sig: (i: number) => VisualSignal, drive = LIVELY) {
  const st = createHologramState();
  const rng = createRng(3);
  const peak = { flare: 0, burst: 0, grow: 0, kick: 0, shock: 0, fold: 0 };
  for (let i = 0; i < frames; i++) {
    stepHologram(st, sig(i), DT, drive, rng);
    peak.flare = Math.max(peak.flare, st.flare);
    peak.burst = Math.max(peak.burst, st.burst);
    peak.grow = Math.max(peak.grow, st.grow - 1);
    peak.kick = Math.max(peak.kick, st.kick);
    peak.shock = Math.max(peak.shock, st.shockAmt);
    peak.fold = Math.max(peak.fold, 1 - st.grow);
  }
  return { st, peak };
}

/** The local minima in a run of values: each dip of a flicker. */
function dips(values: number[]): number {
  let n = 0;
  for (let i = 2; i < values.length; i++) if (values[i - 1] < values[i - 2] && values[i] > values[i - 1]) n++;
  return n;
}

/** The highest face corner of a frame, css px above the cover centre. */
function tipOf(fr: SolidFrame): number {
  let top = -Infinity;
  for (let o = 0; o < 72; o += 12) {
    const y = fr.faces[o + 1];
    top = Math.max(top, y, y + fr.faces[o + 3], y + fr.faces[o + 5], y + fr.faces[o + 3] + fr.faces[o + 5]);
  }
  return fr.rise + top;
}

/** Alternating quiet and loud halves of `period` seconds: the intensity crosses into its top range every period. */
function dropRun(seed: number, secs: number, period: number, drive = LIVELY): HologramState[] {
  const st = createHologramState();
  const rng = createRng(seed);
  const trace: HologramState[] = [];
  for (let i = 0; i * DT < secs; i++) {
    const t = i * DT;
    const level = t % period < period / 2 ? 0.1 : 0.9;
    stepHologram(st, { ...restSignal(), level, loudness: level, drive }, DT, drive, rng);
    trace.push({ ...st, pulse: [...st.pulse] });
  }
  return trace;
}

/** The frames at which a glitch started, from the trace's own record of it. */
function glitchStarts(trace: HologramState[]): number[] {
  const at: number[] = [];
  trace.forEach((st, i) => {
    if (i > 0 && st.lastGlitch !== trace[i - 1].lastGlitch) at.push(i);
  });
  return at;
}

/** Steps a loud passage whose own drive is `sigDrive`, while playing or not, and checks nothing beat-driven or band-driven moves. */
function expectNoReaction(sigDrive: number, playing: boolean): void {
  const drive = cyberGain({ ...restSignal(), drive: sigDrive }, playing);
  const st = createHologramState();
  const rng = createRng(4);
  // The largest value of each reaction over the run; every one must stay exactly zero.
  const peak = { packet: 0, ring: 0, glitch: 0, kick: 0, open: 0, tumble: 0, env: 0, bands: 0, flare: 0, burst: 0, grow: 0, shock: 0 };
  for (let i = 0; i < 60 * 40; i++) {
    // A surge and a cut every few seconds on top of the capped beats and hits.
    const shift = { surge: i % 300 === 100 ? LIVELY : 0, cut: i % 300 === 250 ? LIVELY : 0 };
    stepHologram(st, { ...capped(i, i < 1200 ? 0.1 : 0.9), ...shift, drive: sigDrive }, DT, drive, rng);
    peak.packet = Math.max(peak.packet, Math.abs(st.packetAmt));
    peak.ring = Math.max(peak.ring, ...st.rings.packed);
    peak.glitch = Math.max(peak.glitch, Math.abs(st.glitchAmt));
    peak.kick = Math.max(peak.kick, Math.abs(st.kick));
    peak.open = Math.max(peak.open, Math.abs(st.open));
    peak.tumble = Math.max(peak.tumble, Math.abs(st.tumble));
    peak.env = Math.max(peak.env, st.bass + st.edge + st.spark + st.focus + st.high);
    peak.bands = Math.max(peak.bands, ...st.bands);
    peak.flare = Math.max(peak.flare, st.flare);
    peak.burst = Math.max(peak.burst, st.burst);
    peak.grow = Math.max(peak.grow, Math.abs(st.grow - 1));
    peak.shock = Math.max(peak.shock, st.shockAmt);
  }
  expect(peak).toEqual({ packet: 0, ring: 0, glitch: 0, kick: 0, open: 0, tumble: 0, env: 0, bands: 0, flare: 0, burst: 0, grow: 0, shock: 0 });
  expect(st.lastGlitch).toBe(-99);
  expect(st.spin).toBeCloseTo(HOLO.TURN_CALM, 2);
}

describe("stepHologram", () => {
  it("keeps every envelope in range under the caps at Lively", () => {
    const st = createHologramState();
    const rng = createRng(1);
    // The extremes of each quantity over the run, asserted once after it.
    const lo = { env: Infinity, open: Infinity, spin: Infinity, yaw: Infinity, scan: Infinity };
    const hi = { env: -Infinity, bands: -Infinity, open: -Infinity, spin: -Infinity, tumble: 0, yaw: -Infinity, scan: -Infinity, packet: -Infinity, glitch: -Infinity, ring: -Infinity };
    for (let i = 0; i < 60 * 60; i++) {
      stepHologram(st, capped(i, i % 1200 < 600 ? 0.1 : 0.9), DT, LIVELY, rng);
      lo.env = Math.min(lo.env, st.bass, st.edge, st.spark, st.focus, st.high);
      hi.env = Math.max(hi.env, st.bass, st.edge, st.spark, st.focus, st.high);
      hi.bands = Math.max(hi.bands, ...st.bands);
      lo.open = Math.min(lo.open, st.open);
      hi.open = Math.max(hi.open, st.open);
      lo.spin = Math.min(lo.spin, st.spin);
      hi.spin = Math.max(hi.spin, st.spin);
      hi.tumble = Math.max(hi.tumble, Math.abs(st.tumble));
      lo.yaw = Math.min(lo.yaw, st.yaw);
      hi.yaw = Math.max(hi.yaw, st.yaw);
      lo.scan = Math.min(lo.scan, st.scan);
      hi.scan = Math.max(hi.scan, st.scan);
      hi.packet = Math.max(hi.packet, st.packetAmt);
      hi.glitch = Math.max(hi.glitch, st.glitchAmt);
      for (let r = 1; r < st.rings.packed.length; r += 2) hi.ring = Math.max(hi.ring, st.rings.packed[r]);
    }
    // The hit envelopes take the hits up to the 1.3 cap; the motion envelopes stay within 1.
    expect(lo.env).toBeGreaterThanOrEqual(0);
    expect(hi.env).toBeLessThanOrEqual(1.3);
    expect(hi.bands).toBeLessThanOrEqual(1);
    expect(lo.open).toBeGreaterThanOrEqual(0);
    expect(hi.open).toBeLessThanOrEqual(1.15);
    expect(lo.spin).toBeGreaterThanOrEqual(HOLO.TURN_LIVELY[0] - 1e-9);
    expect(hi.spin).toBeLessThanOrEqual(HOLO.TURN_LIVELY[1] + 1e-9);
    expect(hi.tumble).toBeLessThan(0.5);
    expect(lo.yaw).toBeGreaterThanOrEqual(0);
    expect(hi.yaw).toBeLessThan(Math.PI * 2);
    expect(lo.scan).toBeGreaterThanOrEqual(-HOLO.SCAN_SPAN);
    expect(hi.scan).toBeLessThanOrEqual(HOLO.SCAN_SPAN);
    expect(hi.packet).toBeLessThanOrEqual(1.3);
    expect(hi.glitch).toBeLessThanOrEqual(18 * 1.3);
    // A ring takes the beat's final weight, at most 1.3, on a height of 0.6.
    expect(hi.ring).toBeLessThanOrEqual(0.6 * 1.3);
  });

  it("moves everything in small steps with Lively beats at the cap", () => {
    const st = createHologramState();
    const rng = createRng(2);
    const solid = createSolidFrame();
    const worst = { spin: 0, yaw: 0, open: 0, tumble: 0, bass: 0, focus: 0, high: 0, scan: 0, glitch: 0, face: 0, packet: 0 };
    let prev = { spin: st.spin, yaw: st.yaw, open: 0, tumble: 0, bass: 0, focus: 0, high: 0, scan: st.scan, glitch: 0 };
    let prevFaces = new Float32Array(72);
    let prevPacket = 0;
    let nextBeat = 0;
    let sinceBeat = 99;
    for (let i = 0; i < 60 * 60; i++) {
      const t = i * DT;
      const beat = t >= nextBeat ? 1.5 : 0;
      if (beat) {
        nextBeat += BEAT_GAP;
        sinceBeat = 0;
      } else sinceBeat++;
      const held = sinceBeat < 6 ? LIVELY : 0;
      const level = t % 30 < 15 ? 0.1 : 0.9;
      const sig = { ...restSignal(), level, loudness: level, beat, beatWeight: held, bassHit: held, midHit: i % 10 < 5 ? LIVELY : 0, highHit: held, bassMotion: beat ? 1.6 : 0, midMotion: i % 40 < 20 ? 1.6 : 0, highMotion: 1.6, drive: LIVELY };
      stepHologram(st, sig, DT, LIVELY, rng);
      const now = { spin: st.spin, yaw: st.yaw, open: st.open, tumble: st.tumble, bass: st.bass, focus: st.focus, high: st.high, scan: st.scan, glitch: st.glitchAmt };
      for (const key of Object.keys(now) as (keyof typeof now)[]) {
        let d = Math.abs(now[key] - prev[key]);
        // The yaw wraps at a full turn and the scan band wraps across its span.
        if (key === "yaw") d = Math.min(d, Math.PI * 2 - d);
        if (key === "scan") d = Math.min(d, 2 * HOLO.SCAN_SPAN - d);
        worst[key] = Math.max(worst[key], d);
      }
      solidFrame(st, CW, false, solid, DT);
      if (i > 0) {
        for (const f of [0, 1, 2, 3, 4, 5]) for (let face = 0; face < 6; face++) worst.face = Math.max(worst.face, Math.abs(solid.faces[face * 12 + f] - prevFaces[face * 12 + f]));
      }
      worst.packet = Math.max(worst.packet, Math.abs(st.packetAmt - prevPacket));
      prevPacket = st.packetAmt;
      prevFaces = Float32Array.from(solid.faces);
      prev = now;
    }
    // The bass hit envelope rises over HIT_UP toward at most 1.3.
    expect(worst.bass).toBeLessThanOrEqual(1.3 * (1 - Math.exp(-DT / HOLO.HIT_UP)) + 1e-9);
    expect(worst.focus).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.25) + 1e-9);
    expect(worst.high).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.2) + 1e-9);
    // The turn rate eases over TURN_UP across at most the Lively range.
    const [slow, fast] = HOLO.TURN_LIVELY;
    expect(worst.spin).toBeLessThanOrEqual((fast - slow) * (1 - Math.exp(-DT / HOLO.TURN_UP)) + 1e-9);
    expect(worst.open).toBeLessThan(0.02);
    expect(worst.tumble).toBeLessThan(0.02);
    expect(worst.scan).toBeLessThan(DT * (HOLO.SCAN_BASE + HOLO.SCAN_HIGH * 1.3) + 1e-9);
    // The slices slide in, at most a few px a frame.
    expect(worst.glitch).toBeLessThan(5);
    // A kick swells and bursts the solid over a few frames, so its corners move tens of css px a frame at a
    // 400 px cover, never a jump across the solid.
    expect(worst.face).toBeLessThan(40);
    // A packet ramps in and out over PACKET_RAMP: its strength (at most 1.3) changes by at most that share a frame, plus its slow fade.
    expect(worst.packet).toBeLessThanOrEqual((1.3 * DT) / HOLO.PACKET_RAMP + 0.03);
    expect(worst.packet).toBeGreaterThan(0.1);
    // The turn and the lean did move, so the bounds above are not met by standing still.
    expect(worst.yaw).toBeGreaterThan(0.005);
    expect(worst.face).toBeGreaterThan(0.5);
  });

  it("gives no beat or band reaction under Calm", () => {
    expectNoReaction(0, true);
  });

  it("gives no beat or band reaction while paused", () => {
    expectNoReaction(LIVELY, false);
  });

  it("eases to rest when playback pauses mid-song", () => {
    const st = createHologramState();
    const rng = createRng(9);
    // A quiet stretch, then the drop: the intensity sits well above its mean.
    for (let i = 0; i < 60 * 28; i++) stepHologram(st, capped(i, i < 60 * 20 ? 0.1 : 0.9), DT, LIVELY, rng);
    expect(st.bass + st.focus + st.high).toBeGreaterThan(0.5);
    expect(st.spin).toBeGreaterThan(0.4);
    expect(st.open).toBeGreaterThan(0.5);
    const before = st.bass;
    // The same loud signal now arrives with no gain: the first frame moves only a step toward rest.
    stepHologram(st, capped(1), DT, 0, rng);
    expect(st.bass).toBeGreaterThan(0);
    expect(before - st.bass).toBeLessThanOrEqual(1 - Math.exp(-DT / 0.4) + 1e-9);
    for (let i = 0; i < 60 * 30; i++) stepHologram(st, capped(i), DT, 0, rng);
    expect(st.bass + st.focus + st.high).toBeLessThan(1e-3);
    expect(st.open).toBeLessThan(1e-3);
    expect(Math.abs(st.tumble)).toBeLessThan(1e-3);
    expect(st.kick).toBeLessThan(1e-3);
    expect(Math.max(...st.bands)).toBeLessThan(1e-3);
    expect(st.spin).toBeCloseTo(HOLO.TURN_CALM, 2);
  });

  it("settles back to rest once the beats stop", () => {
    const st = createHologramState();
    const rng = createRng(5);
    for (let i = 0; i < 60 * 20; i++) stepHologram(st, capped(i), DT, LIVELY, rng);
    expect(st.packetAmt + Math.max(...st.rings.packed)).toBeGreaterThan(0);
    expect(st.kick).toBeGreaterThan(0.05);
    // A near-silent passage: the energy falls to 0, so the solid folds and turns at the bottom of its range.
    const quiet = { ...restSignal(), bands: new Float32Array(24), level: 0.6, loudness: 0.05, drive: LIVELY };
    for (let i = 0; i < 60 * 90; i++) stepHologram(st, quiet, DT, LIVELY, rng);
    expect(st.packetAmt).toBe(0);
    expect(Math.max(...st.rings.packed)).toBe(0);
    expect(st.glitchAmt).toBe(0);
    expect(st.kick).toBeLessThan(1e-3);
    expect(st.bass + st.focus + st.high).toBeLessThan(1e-3);
    expect(Math.max(...st.bands)).toBeLessThan(1e-3);
    expect(st.open).toBeLessThan(0.02);
    expect(Math.abs(st.tumble)).toBeLessThan(1e-3);
    expect(st.spin).toBeCloseTo(HOLO.TURN_LIVELY[0], 2);
    expect(st.flare + st.burst + st.shockAmt).toBe(0);
    expect(st.grow).toBe(1);
  });
});

describe("the solid's reaction", () => {
  it("swells, bursts, flares and kicks by the beat's weight", () => {
    const full = runPeaks(60, (i) => beatAt(i, LIVELY)).peak;
    const kickless = runPeaks(60, (i) => beatAt(i, 0.25 * LIVELY)).peak;
    const quiet = runPeaks(60, (i) => beatAt(i, 0.02)).peak;
    // A full-weight beat at Lively: a swell of a seventh, a burst past half open, a flare near full, a turn kick over 1 rad/s.
    expect(full.grow).toBeGreaterThan(0.1);
    expect(full.burst).toBeGreaterThan(0.5);
    expect(full.flare).toBeGreaterThan(0.9);
    expect(full.kick).toBeGreaterThan(1);
    // A kickless onset moves it a little; a beat in a quiet passage barely.
    expect(kickless.flare).toBeLessThan(full.flare * 0.4);
    expect(kickless.flare).toBeGreaterThan(full.flare * 0.15);
    expect(quiet.flare).toBeLessThan(0.03);
    expect(quiet.kick).toBeLessThan(0.03);
    // The push is KICK times the final weight, which the full beat holds at the 1.3 cap.
    expect(kickless.kick / full.kick).toBeGreaterThan(0.2);
    expect(kickless.kick / full.kick).toBeLessThan(0.4 / 1.3 + 0.01);
  });

  it("settles a full beat before the next kick at 128 BPM", () => {
    const st = createHologramState();
    const rng = createRng(3);
    let peak = 0;
    const gap = Math.round(60 / 128 / DT);
    for (let i = 0; i < gap; i++) {
      stepHologram(st, beatAt(i, LIVELY), DT, LIVELY, rng);
      peak = Math.max(peak, st.flare);
    }
    expect(st.flare).toBeLessThan(peak * 0.05);
    expect(st.grow - 1).toBeLessThan(0.01);
    // The flare peaks within the beat's hold and a few frames after, not later.
    const rise = runPeaks(10, (i) => beatAt(i, LIVELY)).peak.flare;
    expect(rise).toBeGreaterThan(peak * 0.95);
  });

  it("turns, opens and lights by the loudness", () => {
    const run = (loudness: number) => {
      const st = createHologramState();
      const rng = createRng(3);
      for (let i = 0; i < 60 * 20; i++) stepHologram(st, { ...restSignal(), level: 0.95, loudness, drive: LIVELY }, DT, LIVELY, rng);
      return st;
    };
    const silent = run(0.08);
    const loud = run(0.88);
    expect(silent.spin).toBeLessThan(0.08);
    expect(loud.spin).toBeGreaterThan(0.85);
    expect(silent.open).toBeLessThan(0.01);
    expect(loud.open).toBeGreaterThan(0.9);
    expect(loud.glow / silent.glow).toBeGreaterThan(2);
    expect(loud.solidLight / silent.solidLight).toBeGreaterThan(1.6);
  });

  it("rocks the solid both ways on bass hits", () => {
    const st = createHologramState();
    const rng = createRng(3);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 60 * 8; i++) {
      stepHologram(st, { ...restSignal(), loudness: 0.85, bassHit: i % 30 < 6 ? LIVELY : 0, drive: LIVELY }, DT, LIVELY, rng);
      lo = Math.min(lo, st.tumble);
      hi = Math.max(hi, st.tumble);
    }
    expect(hi).toBeGreaterThan(0.12);
    expect(lo).toBeLessThan(-0.12);
  });

  it("throws the solid open on a surge, with a full flare and a shock ring", () => {
    const { peak } = runPeaks(120, (i) => ({ ...restSignal(), loudness: 0.85, surge: i === 0 ? 1 : 0, drive: LIVELY }));
    expect(peak.burst).toBeGreaterThan(0.6);
    expect(peak.flare).toBeGreaterThan(0.9);
    expect(peak.shock).toBeGreaterThan(0.8);
  });

  it("dims, flickers and folds the projection on a cut, then recovers", () => {
    const st = createHologramState();
    const rng = createRng(3);
    const calm = { ...restSignal(), loudness: 0.6, drive: LIVELY };
    for (let i = 0; i < 60 * 5; i++) stepHologram(st, calm, DT, LIVELY, rng);
    const lit = st.solidLight;
    const lights: number[] = [];
    let fold = 0;
    for (let i = 0; i < 60; i++) {
      stepHologram(st, { ...calm, cut: i === 0 ? 1 : 0 }, DT, LIVELY, rng);
      lights.push(st.solidLight);
      fold = Math.max(fold, 1 - st.grow);
    }
    expect(Math.min(...lights)).toBeLessThan(lit * 0.5);
    expect(fold).toBeGreaterThan(0.1);
    expect(st.lastGlitch).toBeGreaterThan(0);
    // The flicker: the light turns back up at least once inside the dip.
    expect(dips(lights)).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 4; i++) stepHologram(st, calm, DT, LIVELY, rng);
    expect(st.solidLight).toBeCloseTo(lit, 2);
  });

  it("flickers under three dips a second, even with a cut every second", () => {
    const st = createHologramState();
    const rng = createRng(3);
    const lights: number[] = [];
    const secs = 6;
    for (let i = 0; i < 60 * secs; i++) {
      stepHologram(st, { ...restSignal(), loudness: 0.6, cut: i % 60 === 0 ? LIVELY : 0, drive: LIVELY }, DT, LIVELY, rng);
      lights.push(st.solidLight);
    }
    expect(dips(lights)).toBeGreaterThan(secs);
    expect(dips(lights) / secs).toBeLessThanOrEqual(3);
    for (let s = 0; s < secs; s++) expect(dips(lights.slice(s * 60, s * 60 + 60))).toBeLessThanOrEqual(3);
  });

  it("keeps the turn under half a turn a second through full-weight kicks at 128 and 180 BPM", () => {
    const peakRate = (bpm: number) => {
      const st = createHologramState();
      const rng = createRng(3);
      const gap = 60 / bpm;
      let next = 0;
      let since = 99;
      let rate = 0;
      for (let i = 0; i < 60 * 20; i++) {
        const t = i * DT;
        const on = t >= next;
        if (on) {
          next += gap;
          since = 0;
        } else since++;
        const before = st.yaw;
        stepHologram(st, { ...restSignal(), level: 0.95, loudness: 0.9, beat: on ? LIVELY : 0, beatWeight: since < 6 ? LIVELY : 0, drive: LIVELY }, DT, LIVELY, rng);
        const d = Math.abs(st.yaw - before);
        rate = Math.max(rate, Math.min(d, Math.PI * 2 - d) / DT);
      }
      return rate;
    };
    const at128 = peakRate(128);
    const at180 = peakRate(180);
    // The kicks show well over the loud base turn, and pile up more as they come faster, without a spin-out.
    expect(at128).toBeGreaterThan(HOLO.TURN_LIVELY[1] + 0.8);
    expect(at180).toBeGreaterThan(at128);
    expect(at180).toBeLessThan(Math.PI);
  });

  it("launches no table ring when Calm or a pause lands inside a beat's hold", () => {
    for (const stopAt of [1, 3, 5]) {
      const st = createHologramState();
      const rng = createRng(3);
      let ring = 0;
      for (let i = 0; i < 60 * 3; i++) {
        const drive = i < stopAt ? LIVELY : 0;
        stepHologram(st, { ...beatAt(i, LIVELY), drive }, DT, drive, rng);
        ring = Math.max(ring, ...st.rings.packed);
      }
      expect(ring).toBe(0);
    }
  });
});

describe("the projector glitch", () => {
  it("starts only as the intensity crosses into the top of its range", () => {
    // The loud halves last 50 s, longer than GLITCH_EVERY, so a glitch re-armed by staying high would show.
    const trace = dropRun(6, 160, 100);
    const starts = glitchStarts(trace);
    expect(starts.length).toBeGreaterThan(1);
    for (const i of starts) {
      expect(trace[i - 1].wasHigh).toBe(false);
      expect(trace[i].wasHigh).toBe(true);
    }
    // Every frame of the quiet halves, the intensity is below the top.
    expect(trace.filter((st) => st.glitchAmt > VISIBLE && !st.wasHigh).length).toBe(0);
  });

  it("starts at most once per GLITCH_EVERY seconds even when the intensity crosses far more often", () => {
    // Crossing every 12 s: twice inside one GLITCH_EVERY, so only the cap holds the spacing.
    const trace = dropRun(6, 200, 12);
    const crossings = trace.filter((st, i) => i > 0 && st.wasHigh && !trace[i - 1].wasHigh).length;
    const starts = glitchStarts(trace);
    expect(12).toBeLessThan(HOLO.GLITCH_EVERY);
    expect(crossings).toBeGreaterThan(starts.length + 3);
    expect(starts.length).toBeGreaterThan(3);
    for (let i = 1; i < starts.length; i++) expect(trace[starts[i]].lastGlitch - trace[starts[i - 1]].lastGlitch).toBeGreaterThan(HOLO.GLITCH_EVERY);
  });

  it("slides for a short burst that grows to its peak and ends at rest", () => {
    const trace = dropRun(6, 130, 40);
    const starts = glitchStarts(trace);
    for (const i of starts) {
      // The first frame is still too small to see, so count the visible frames in the second after the start.
      const run = trace.slice(i, i + 60);
      const n = run.filter((st) => st.glitchAmt > VISIBLE).length;
      // The slide is gone at 0.4 of GLITCH_LIFE: the shader's sin(pi * min(1, 2.5 * age)) reaches 0 there.
      expect(n * DT).toBeGreaterThan(0.4 * HOLO.GLITCH_LIFE - 6 * DT);
      expect(n * DT).toBeLessThan(0.4 * HOLO.GLITCH_LIFE + 3 * DT);
      const peak = Math.max(...run.map((st) => st.glitchAmt));
      expect(peak).toBeGreaterThan(15);
      expect(peak).toBeLessThan(18 * 1.3);
      expect(run[59].glitchAmt).toBeLessThan(VISIBLE);
    }
    // The rest of the run, the projection holds still.
    const burst = new Set<number>();
    for (const i of starts) for (let k = 0; k < 40; k++) burst.add(i + k);
    expect(trace.filter((st, i) => !burst.has(i) && st.glitchAmt > VISIBLE).length).toBe(0);
  });

  it("scales the slide with the motion gain and stays out of Balanced's excess", () => {
    const lively = Math.max(...dropRun(6, 60, 40).map((st) => st.glitchAmt));
    const balanced = Math.max(...dropRun(6, 60, 40, 1).map((st) => st.glitchAmt));
    expect(balanced).toBeGreaterThan(10);
    expect(balanced).toBeLessThan(lively * 0.85);
  });

  it("does not fire under Calm or while paused", () => {
    const calm = dropRun(6, 130, 12, 0);
    expect(calm.filter((st) => st.glitchAmt !== 0).length).toBe(0);
    expect(calm[calm.length - 1].lastGlitch).toBe(-99);
    // Paused hands the step the same gain as Calm, whatever the signal's own drive says.
    const gain = cyberGain({ ...restSignal(), drive: LIVELY }, false);
    const paused = createHologramState();
    const rng = createRng(6);
    let worst = 0;
    for (let i = 0; i < 60 * 130; i++) {
      const level = (i * DT) % 12 < 6 ? 0.1 : 0.9;
      stepHologram(paused, { ...restSignal(), level, loudness: level, drive: LIVELY }, DT, gain, rng);
      worst = Math.max(worst, Math.abs(paused.glitchAmt));
    }
    expect(worst).toBe(0);
    expect(paused.lastGlitch).toBe(-99);
  });

  it("replays the same glitch from the same seed", () => {
    const a = dropRun(7, 60, 40);
    const b = dropRun(7, 60, 40);
    const c = dropRun(8, 60, 40);
    expect(a.map((st) => [st.glitchSeed, st.glitchAmt])).toEqual(b.map((st) => [st.glitchSeed, st.glitchAmt]));
    expect(a[a.length - 1].glitchSeed).not.toBe(1);
    expect(c[c.length - 1].glitchSeed).not.toBe(a[a.length - 1].glitchSeed);
  });
});

describe("a beat packet", () => {
  it("fades out over the last PACKET_RAMP instead of dropping from half strength", () => {
    const st = createHologramState();
    const rng = createRng(3);
    const amps: number[] = [];
    for (let i = 0; i < 60 * 2; i++) {
      stepHologram(st, { ...restSignal(), beat: i === 0 ? 1.5 : 0, drive: LIVELY }, DT, LIVELY, rng);
      amps.push(st.packetAmt);
    }
    const last = Math.max(...amps.map((a, i) => (a > 0 ? i : -1)));
    expect(last * DT).toBeGreaterThan(HOLO.PACKET_LIFE - 2 * DT);
    // The last frame is one ramp step above zero: half the strength (at most 1.3) scaled by DT over the ramp.
    expect(amps[last]).toBeLessThan(1.3 * 0.5 * (DT / HOLO.PACKET_RAMP) + 0.02);
    const peak = Math.max(...amps);
    for (let i = 1; i < amps.length; i++) expect(Math.abs(amps[i] - amps[i - 1])).toBeLessThan(peak * DT / HOLO.PACKET_RAMP + 0.03);
  });
});

describe("a glitch running when playback pauses", () => {
  /** The glitch offsets of a run whose gain drops to 0 at frame `pauseAt` (never when null). */
  function run(pauseAt: number | null): number[] {
    const st = createHologramState();
    const rng = createRng(6);
    const amps: number[] = [];
    for (let i = 0; i < 60 * 60; i++) {
      const level = (i * DT) % 40 < 20 ? 0.1 : 0.9;
      const gain = pauseAt !== null && i >= pauseAt ? 0 : LIVELY;
      stepHologram(st, { ...restSignal(), level, loudness: level, drive: LIVELY }, DT, gain, rng);
      amps.push(st.glitchAmt);
    }
    return amps;
  }

  it("finishes its own slide instead of snapping to rest", () => {
    const playing = run(null);
    const start = playing.findIndex((a) => a > 0);
    expect(start).toBeGreaterThan(0);
    // Pause 9 frames in, with the slide near its peak.
    const paused = run(start + 9);
    expect(playing[start + 9]).toBeGreaterThan(10);
    for (let i = start; i < start + 60; i++) expect(paused[i]).toBeCloseTo(playing[i], 9);
    const step = (a: number[]) => Math.max(...a.slice(start, start + 60).map((v, i, s) => (i ? Math.abs(v - s[i - 1]) : 0)));
    expect(step(paused)).toBeLessThanOrEqual(step(playing) + 1e-9);
    expect(step(paused)).toBeLessThan(3);
    // No second glitch launches once paused.
    expect(Math.max(...paused.slice(start + 60))).toBeLessThan(VISIBLE);
  });
});

describe("beam re-aim", () => {
  it("moves each beam end a bounded step even as the lowest corners change", () => {
    const st = createHologramState();
    const rng = createRng(2);
    const solid = createSolidFrame();
    let prev: Float32Array | null = null;
    let prevZ: Float32Array | null = null;
    let prevSlots = "";
    let swaps = 0;
    let worstEnd = 0;
    let worstZ = 0;
    let maxZ = 0;
    let worstCone = 0;
    let prevCone = [0, 0];
    for (let i = 0; i < 60 * 120; i++) {
      // A loud passage at the caps, with the lean swung wide by hand so the lowest corners change.
      stepHologram(st, { ...capped(i, 0.9), midMotion: 1.6, highMotion: 1.6, drive: LIVELY }, DT, LIVELY, rng);
      st.tumble = 0.5 * Math.sin(i * DT * 1.3);
      solidFrame(st, CW, false, solid, DT);
      const slots = Array.from(solid.slots).join(",");
      if (prev && prevZ) {
        if (slots !== prevSlots) swaps++;
        for (let b = 0; b < 16; b++) worstEnd = Math.max(worstEnd, Math.abs(solid.beams[b] - prev[b]));
        for (let b = 0; b < 4; b++) worstZ = Math.max(worstZ, Math.abs(solid.beamZ[b] - prevZ[b]));
      }
      if (prev) worstCone = Math.max(worstCone, Math.abs(solid.cone[0] - prevCone[0]), Math.abs(solid.cone[1] - prevCone[1]));
      prevCone = [...solid.cone];
      for (const z of solid.beamZ) maxZ = Math.max(maxZ, Math.abs(z));
      prev = Float32Array.from(solid.beams);
      prevZ = Float32Array.from(solid.beamZ);
      prevSlots = slots;
    }
    // The run does reach corner swaps (an unfixed beam would jump hundreds of px at each).
    expect(swaps).toBeGreaterThan(5);
    // A re-aim carries at most the cube's span (3.9 half-edges, with a beat's swell and burst at their largest)
    // and sheds 1 - exp(-dt / BEAM_EASE) of it a frame, on top of the corners' own motion (a kick's swell included).
    const h = HOLO.SIZE * CW * 0.5 * (1 + HOLO.SWELL * 1.3) * (1 + 0.5 * HOLO.OPEN_GAP * HOLO.BURST * 1.3);
    const bound = 3.9 * h * (1 - Math.exp(-DT / HOLO.BEAM_EASE)) + 40;
    expect(worstEnd).toBeLessThan(bound);
    expect(worstZ).toBeLessThan(2 * (1 - Math.exp(-DT / HOLO.BEAM_EASE)) + 0.05);
    expect(maxZ).toBeLessThanOrEqual(1);
    // The haze cone follows the same re-aim, so its top and width take the same bound.
    expect(worstCone).toBeLessThan(bound);
  });

  it("eases the haze cone toward the corners' pose and settles on it", () => {
    const st = createHologramState();
    st.yaw = 1.1;
    const fresh = solidFrame(st, CW, false, createSolidFrame(), DT);
    const solid = createSolidFrame();
    solidFrame(st, CW, false, solid, DT);
    st.yaw = 1.4;
    st.tumble = 0.4;
    // A sudden change of pose (as a corner reorder would give) moves the cone one ease step toward its target.
    const before = [...solid.cone];
    const goal = solidFrame(st, CW, false, createSolidFrame(), DT);
    solidFrame(st, CW, false, solid, DT);
    const stepTo = 1 - Math.exp(-DT / HOLO.BEAM_EASE);
    expect(Math.abs(goal.cone[0] - before[0]) + Math.abs(goal.cone[1] - before[1])).toBeGreaterThan(5);
    expect(solid.cone[0]).toBeCloseTo(before[0] + (goal.cone[0] - before[0]) * stepTo, 3);
    expect(solid.cone[1]).toBeCloseTo(before[1] + (goal.cone[1] - before[1]) * stepTo, 3);
    for (let i = 0; i < 60 * 5; i++) solidFrame(st, CW, false, solid, DT);
    const target = solidFrame(st, CW, false, createSolidFrame(), DT);
    expect(solid.cone[0]).toBeCloseTo(target.cone[0], 3);
    expect(solid.cone[1]).toBeCloseTo(target.cone[1], 3);
    expect(Math.abs(target.cone[0] - fresh.cone[0]) + Math.abs(target.cone[1] - fresh.cone[1])).toBeGreaterThan(1);
  });

  it("keeps a beam on its corner while that corner stays among the lowest", () => {
    const st = createHologramState();
    const solid = createSolidFrame();
    solidFrame(st, CW, false, solid, DT);
    const first = Array.from(solid.slots);
    expect(new Set(first).size).toBe(4);
    st.yaw += 0.001;
    solidFrame(st, CW, false, solid, DT);
    expect(Array.from(solid.slots)).toEqual(first);
    expect(Math.max(...solid.resid.map(Math.abs))).toBe(0);
  });
});

describe("shader uniforms", () => {
  it("are filled with as many floats as the shader declares", () => {
    const fs = HOLOGRAM_PROGRAMS[0].fs;
    const vec4s = (name: string) => Number(new RegExp(`uniform vec4 ${name}\\[(\\d+)\\]`).exec(fs)?.[1]) * 4;
    const solid = createSolidFrame();
    expect(solid.faces.length).toBe(vec4s("uFace"));
    expect(solid.beams.length).toBe(vec4s("uBeam"));
    expect(createHologramState().bands.length).toBe(vec4s("uBandsE"));
  });
});

describe("solidFrame", () => {
  it("builds six faces and four beams, two clearly toward the viewer", () => {
    const st = createHologramState();
    const fr = solidFrame(st, CW, false, createSolidFrame(), DT);
    expect(fr.h).toBeCloseTo(HOLO.SIZE * CW * 0.5, 6);
    expect(fr.lines).toBe(Math.floor((2 * fr.h) / HOLO.LINE_PITCH));
    const depth = [0, 1, 2, 3, 4, 5].map((f) => fr.faces[f * 12 + 6]);
    // Opposite faces of the cube face opposite ways; the pair turned most toward the viewer is far from edge-on.
    for (let k = 0; k < 3; k++) expect(depth[k * 2]).toBeCloseTo(-depth[k * 2 + 1], 6);
    expect(Math.max(...depth.map(Math.abs))).toBeGreaterThan(0.8);
    expect(depth.filter((z) => z > 0.015).length).toBe(2);
    expect(Array.from(fr.beamZ).every((z) => z >= -1 && z <= 1)).toBe(true);
    expect(solidFrame(st, CW, true, createSolidFrame(), DT).h).toBeCloseTo(HOLO.SIZE_AMB * CW * 0.5, 6);
  });

  it("parts the faces as the solid opens and pulls the beams in as the mids focus", () => {
    const closed = createHologramState();
    const open = createHologramState();
    open.open = 1;
    open.focus = 1;
    const a = solidFrame(closed, CW, false, createSolidFrame(), DT);
    const b = solidFrame(open, CW, false, createSolidFrame(), DT);
    const reach = (fr: { beams: Float32Array }) => Math.max(...[0, 1, 2, 3].map((i) => Math.abs(fr.beams[i * 4])));
    expect(reach(b)).toBeLessThan(reach(a) * 0.5);
    // A face's edge shrinks by half the gap as it moves out.
    const edge = (fr: { faces: Float32Array }) => Math.hypot(fr.faces[2], fr.faces[3]);
    expect(edge(b)).toBeLessThan(edge(a));
    expect(edge(b) / edge(a)).toBeCloseTo(1 - 0.5 * HOLO.OPEN_GAP, 2);
  });

  // Stages as cover width, room above the cover centre (css px) and framing: the Player, the ambient stage, a
  // short wide Player, a tall one and the still.
  const STAGES = [
    { name: "player", cw: 340, room: 260, ambient: false },
    { name: "ambient-side", cw: 400, room: 325, ambient: true },
    { name: "short player", cw: 300, room: 210, ambient: false },
    { name: "tall player", cw: 340, room: 700, ambient: false },
    { name: "still", cw: 128, room: 186, ambient: true },
  ];

  /** The lowest face corner of a frame, css px above the cover centre. */
  function lowOf(fr: SolidFrame): number {
    let low = Infinity;
    for (let o = 0; o < 72; o += 12) {
      const y = fr.faces[o + 1];
      low = Math.min(low, y, y + fr.faces[o + 3], y + fr.faces[o + 5], y + fr.faces[o + 3] + fr.faces[o + 5]);
    }
    return fr.rise + low;
  }

  it("keeps the solid inside at rest, a kick's tip just past the top, its scale even and its lower tip in place", () => {
    for (const stage of STAGES) {
      const st = createHologramState();
      const rng = createRng(3);
      const fr = createSolidFrame();
      // The same solid with no stage top: the capped one must be an even scale of it.
      const free = createSolidFrame();
      let restTip = -Infinity;
      let restLow = Infinity;
      let peakTip = -Infinity;
      let lowest = Infinity;
      let worstSkew = 0;
      let leastFit = 1;
      for (let i = 0; i < 60 * 12; i++) {
        const loud = i >= 60 * 4;
        const k = i % 28;
        const sig = loud
          ? { ...restSignal(), level: 0.95, loudness: 0.9, beat: k === 0 ? LIVELY : 0, beatWeight: k < 6 ? LIVELY : 0, bassHit: k < 6 ? LIVELY : 0, surge: i === 60 * 8 ? LIVELY : 0, drive: LIVELY }
          : { ...restSignal(), drive: LIVELY };
        stepHologram(st, sig, DT, LIVELY, rng);
        solidFrame(st, stage.cw, stage.ambient, fr, DT, stage.room);
        solidFrame(st, stage.cw, stage.ambient, free, DT, Infinity);
        if (!loud) {
          restTip = Math.max(restTip, tipOf(fr));
          restLow = Math.min(restLow, lowOf(fr));
        } else {
          peakTip = Math.max(peakTip, tipOf(fr));
          lowest = Math.min(lowest, lowOf(fr));
        }
        // Each face's edges against the free solid's: one common factor (the short stage's smaller rest size and
        // the cap) and no squash.
        const s = Math.hypot(fr.faces[2], fr.faces[3]) / Math.hypot(free.faces[2], free.faces[3]);
        leastFit = Math.min(leastFit, s);
        for (let o = 0; o < 72; o += 12) for (const j of [2, 3, 4, 5]) worstSkew = Math.max(worstSkew, Math.abs(fr.faces[o + j] - s * free.faces[o + j]));
      }
      // The faces are stored as 32-bit floats, so allow a thousandth of a px.
      expect(restTip, stage.name).toBeLessThanOrEqual(stage.room - HOLO.TOP_MARGIN * stage.cw + 1e-3);
      expect(peakTip, stage.name).toBeLessThanOrEqual(stage.room + HOLO.SWELL_OVER * stage.cw + 1e-3);
      // The lower tip stays where it rests, give or take the slow hover.
      expect(lowest, stage.name).toBeGreaterThanOrEqual(restLow - 2 * HOLO.BOB * stage.cw - 1e-3);
      expect(worstSkew, stage.name).toBeLessThan(1e-2);
      // Only the tall stage keeps every kick's full swell.
      if (stage.name === "tall player") expect(leastFit).toBeGreaterThan(1 - 1e-6);
    }
  });

  it("keeps the full size where the stage has room and shrinks only a little in the Player", () => {
    const sizeOf = (stage: (typeof STAGES)[number]) => solidFrame(createHologramState(), stage.cw, stage.ambient, createSolidFrame(), DT, stage.room).h;
    const [player, side, , tall] = STAGES;
    expect(sizeOf(side)).toBeCloseTo(HOLO.SIZE_AMB * side.cw * 0.5, 6);
    expect(sizeOf(tall)).toBeCloseTo(HOLO.SIZE * tall.cw * 0.5, 6);
    expect(sizeOf(player)).toBeGreaterThan(0.95 * HOLO.SIZE * player.cw * 0.5);
  });

  it("hands a face's lines to the screen raster when they slide fast and keeps them on the face at a slow turn", () => {
    const blurAt = (spin: number) => {
      const st = createHologramState();
      const fr = createSolidFrame();
      let worst = 0;
      for (let i = 0; i < 60; i++) {
        st.yaw += spin * DT;
        solidFrame(st, CW, false, fr, DT);
        // Only faces seen clearly face-on: an edge-on face is already filtered by its pitch.
        for (let f = 0; f < 6; f++) if (Math.abs(fr.faces[f * 12 + 6]) > 0.5) worst = Math.max(worst, fr.faces[f * 12 + 11]);
      }
      return worst;
    };
    // Calm turns at 0.22 rad/s and the still at about 0.3: both keep the face's own lines.
    expect(blurAt(0.2)).toBeLessThan(0.05);
    expect(blurAt(0.32)).toBeLessThan(0.05);
    expect(blurAt(2.5)).toBeGreaterThan(0.9);
  });
});
