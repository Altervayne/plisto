// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  BEAT_MAX_PER_SEC,
  BEAT_MIN_GAP_SECS,
  LEVEL_TAU,
  MOTION_ATTACK_SECS,
  REACTIVITY_PROFILES,
  admitBeat,
  bandFlux,
  createSignalFollower,
  easeEnvelope,
  motionEnvelope,
  onsetStrength,
  type SignalInput,
  type VisualSignal,
} from "./visualSignal";
import { BAND_COUNT } from "../../types";
import type { Reactivity } from "./visualizerKind";

const DT = 1 / 60;
const quiet = { rms: 0, peak: 0, flux: 0 };

/** A fresh band frame with the bass bands at `bass` and the rest at `rest`. */
function frame(bass: number, rest = 0.1): number[] {
  return Array.from({ length: BAND_COUNT }, (_, i) => (i < 5 ? bass : rest));
}

/** `n` distinct engine frames of the same shape, as the engine sends a new array per emit. */
function frames(n: number, bass: number, rest = 0.1): number[][] {
  return Array.from({ length: n }, () => frame(bass, rest));
}

describe("easeEnvelope", () => {
  it("covers about 63% of a step after one time constant", () => {
    let v = 0;
    const frames = Math.round(LEVEL_TAU / DT);
    for (let i = 0; i < frames; i++) v = easeEnvelope(v, 1, DT, LEVEL_TAU);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(0.66);
  });

  it("does not overshoot the target at any frame rate", () => {
    expect(easeEnvelope(0, 1, 0.5, 0.1)).toBeLessThanOrEqual(1);
    expect(easeEnvelope(1, 0, 0.5, 0.1)).toBeGreaterThanOrEqual(0);
  });

  it("swings far less than its input on a 3 Hz square wave", () => {
    // A full-range input flipping at 3 Hz: the eased output must stay close to flat, or brightness
    // would flicker at the WCAG 2.3.1 limit.
    let v = 0.5;
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 60 * 6; i++) {
      const t = i * DT;
      const input = Math.floor(t * 6) % 2 === 0 ? 1 : 0;
      v = easeEnvelope(v, input, DT, LEVEL_TAU);
      if (t > 3) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    expect(hi - lo).toBeLessThan(0.1);
  });
});

describe("bandFlux", () => {
  it("counts rises only", () => {
    expect(bandFlux(frame(0.8), frame(0.2))).toBe(0);
    expect(bandFlux(frame(0.2), frame(0.8))).toBeGreaterThan(0);
  });

  it("weighs a bass rise above the same rise in the highs", () => {
    const flat = new Array(BAND_COUNT).fill(0);
    const bassHit = flat.map((_, i) => (i < 3 ? 0.3 : 0));
    const hatHit = flat.map((_, i) => (i >= BAND_COUNT - 3 ? 0.3 : 0));
    expect(bandFlux(flat, bassHit)).toBeGreaterThan(bandFlux(flat, hatHit));
  });

  it("clamps into 0..1 and ignores a length mismatch", () => {
    expect(bandFlux(new Array(BAND_COUNT).fill(0), new Array(BAND_COUNT).fill(1))).toBe(1);
    expect(bandFlux([0, 0], [1, 1, 1])).toBe(0);
  });
});

describe("onsetStrength", () => {
  const calm = new Array(30).fill(0.05);

  it("fires on a flux standing clear of the recent mean", () => {
    expect(onsetStrength(0.6, calm, 1)).toBeGreaterThan(0.35);
  });

  it("stays silent under the adaptive threshold", () => {
    expect(onsetStrength(0.1, calm, 1)).toBe(0);
    // The same flux in a busy passage is no onset.
    expect(onsetStrength(0.6, new Array(30).fill(0.5), 1)).toBe(0);
  });

  it("holds the refractory gap after an onset", () => {
    expect(onsetStrength(0.9, calm, 0.1)).toBe(0);
  });

  it("caps the strength at 1", () => {
    expect(onsetStrength(1, [], 1)).toBe(1);
  });
});

describe("createSignalFollower", () => {
  /** Runs the follower over `frames`, one engine frame every other display frame. */
  function run(frames: number[][], playing = true) {
    const follower = createSignalFollower();
    const kicks: number[] = [];
    const levels: number[] = [];
    for (const bands of frames) {
      for (let k = 0; k < 2; k++) {
        const input: SignalInput = { bands, level: { rms: bands[0], peak: bands[0], flux: 0 }, playing };
        const s = follower.step(DT, input);
        kicks.push(s.kick);
        levels.push(s.level);
      }
    }
    return { follower, kicks, levels };
  }

  it("derives a beat from a bass hit after a quiet passage", () => {
    // The first frame rises from silence and reads as an onset; the steady passage after it adds none.
    const { kicks } = run([...frames(30, 0.1), frame(0.9)]);
    for (let i = 20; i < 60; i++) expect(kicks[i]).toBeLessThanOrEqual(kicks[i - 1]);
    expect(kicks[59]).toBeLessThan(0.05);
    expect(kicks[kicks.length - 1]).toBeGreaterThan(0.3);
  });

  it("derives no beat while paused", () => {
    const { kicks } = run([...frames(30, 0.1), frame(0.9)], false);
    expect(Math.max(...kicks)).toBe(0);
  });

  it("moves the brightness level slowly on a hit", () => {
    const { levels } = run([...frames(30, 0.1), ...frames(3, 0.9)]);
    // Frame to frame, the level never moves by more than a few percent.
    for (let i = 1; i < levels.length; i++) expect(Math.abs(levels[i] - levels[i - 1])).toBeLessThan(0.03);
  });

  it("settles the bands onto the resting arch when paused", () => {
    const follower = createSignalFollower();
    const loud = frame(0.9, 0.9);
    for (let i = 0; i < 10; i++) follower.step(DT, { bands: loud, level: quiet, playing: true });
    for (let i = 0; i < 240; i++) follower.step(DT, { bands: loud, level: quiet, playing: false });
    const s = follower.signal;
    expect(s.bands[0]).toBeLessThan(0.1);
    expect(s.bands[0]).toBeGreaterThan(0.01);
    expect(s.kick).toBeLessThan(1e-3);
  });

  it("feeds a repeated frame only once", () => {
    const follower = createSignalFollower();
    for (const bands of frames(60, 0.1)) follower.step(DT, { bands, level: quiet, playing: true });
    const hit = frame(0.9);
    let peakKick = 0;
    // The same array held for a second is one engine frame: one onset at most, then decay.
    for (let i = 0; i < 60; i++) peakKick = Math.max(peakKick, follower.step(DT, { bands: hit, level: quiet, playing: true }).kick);
    expect(peakKick).toBeGreaterThan(0.3);
    expect(follower.signal.kick).toBeLessThan(0.01);
  });
});

describe("motionEnvelope", () => {
  const release = REACTIVITY_PROFILES.balanced.release;

  it("covers about 63% of a rise after the attack time", () => {
    let v = 0;
    for (let t = 0; t < MOTION_ATTACK_SECS - 1e-9; t += 0.001) v = motionEnvelope(v, 1, 0.001, release);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(0.66);
  });

  it("falls back by about 63% after the release time", () => {
    let v = 1;
    for (let t = 0; t < release - 1e-9; t += 0.001) v = motionEnvelope(v, 0, 0.001, release);
    expect(v).toBeGreaterThan(0.34);
    expect(v).toBeLessThan(0.4);
  });

  it("releases faster under Lively than Balanced", () => {
    const fall = (r: Reactivity) => motionEnvelope(1, 0, 0.1, REACTIVITY_PROFILES[r].release);
    expect(fall("lively")).toBeLessThan(fall("balanced"));
  });
});

describe("admitBeat", () => {
  it("holds the minimum gap", () => {
    expect(admitBeat([1], 1 + BEAT_MIN_GAP_SECS - 0.01)).toBe(false);
    expect(admitBeat([1], 1 + BEAT_MIN_GAP_SECS)).toBe(true);
  });

  it("caps the events in any one second", () => {
    expect(admitBeat([0, 0.31, 0.62], 0.95)).toBe(false);
    expect(admitBeat([0, 0.31, 0.62], 1.0)).toBe(true);
  });

  it("thins a 10 Hz onset stream to the cap", () => {
    const fired: number[] = [];
    for (let i = 0; i < 100; i++) {
      const now = i / 10;
      if (admitBeat(fired, now)) fired.push(now);
    }
    for (let i = 1; i < fired.length; i++) expect(fired[i] - fired[i - 1]).toBeGreaterThanOrEqual(BEAT_MIN_GAP_SECS);
    for (const t of fired) expect(fired.filter((u) => u >= t && u < t + 1).length).toBeLessThanOrEqual(BEAT_MAX_PER_SEC);
    expect(fired.length).toBeGreaterThan(20);
  });
});

describe("the motion channel", () => {
  /** A 120 BPM kick at the engine's thirty frames a second, with a busy hat on every other frame. */
  function kickFrames(seconds: number): number[][] {
    return Array.from({ length: seconds * 30 }, (_, i) => {
      const hit = i % 15 < 2;
      return Array.from({ length: BAND_COUNT }, (_, b) =>
        b < 5 ? (hit ? 0.9 : 0.3) : b < 15 ? 0.35 : i % 2 === 0 ? 0.5 : 0.3,
      );
    });
  }

  /** Runs the kick through a follower at `reactivity`, two display frames per engine frame. */
  function run(reactivity: Reactivity | undefined, input: number[][] = kickFrames(6)): VisualSignal[] {
    const follower = createSignalFollower();
    const out: VisualSignal[] = [];
    for (const bands of input) {
      const level = { rms: bands[0] * 0.8, peak: bands[0], flux: 0 };
      for (let k = 0; k < 2; k++) out.push({ ...follower.step(DT, { bands, level, playing: true, reactivity }) });
    }
    return out;
  }

  it("leaves brightness and the 2.5.0 fields identical at every level", () => {
    const strip = (s: VisualSignal) => ({
      bands: Array.from(s.bands),
      rms: s.rms,
      peak: s.peak,
      flux: s.flux,
      kick: s.kick,
      bass: s.bass,
      mid: s.mid,
      high: s.high,
      level: s.level,
      swell: s.swell,
    });
    const calm = run("calm").map(strip);
    expect(run("balanced").map(strip)).toEqual(calm);
    expect(run("lively").map(strip)).toEqual(calm);
  });

  it("zeroes the whole motion channel under Calm", () => {
    for (const s of run("calm")) {
      expect(s.bassMotion).toBe(0);
      expect(s.midMotion).toBe(0);
      expect(s.highMotion).toBe(0);
      expect(s.beat).toBe(0);
      expect(s.drive).toBe(0);
    }
  });

  it("punches the bass envelope on every kick and lets it fall between", () => {
    const sig = run("balanced");
    // Past the warm-up, each half-second beat lifts the envelope well above where it falls back to.
    const tail = sig.slice(120).map((s) => s.bassMotion);
    expect(Math.max(...tail)).toBeGreaterThan(0.5);
    expect(Math.min(...tail)).toBeLessThan(Math.max(...tail) * 0.45);
  });

  it("fires one beat per kick, within the cap", () => {
    const sig = run("balanced");
    const beats = sig.map((s, i) => [i * DT, s.beat] as const).filter(([, b]) => b > 0);
    // Twelve kicks in six seconds.
    expect(beats.length).toBeGreaterThanOrEqual(10);
    expect(beats.length).toBeLessThanOrEqual(13);
    for (let i = 1; i < beats.length; i++) expect(beats[i][0] - beats[i - 1][0]).toBeGreaterThanOrEqual(BEAT_MIN_GAP_SECS);
  });

  it("caps beats on a stream of hits faster than the limit", () => {
    // A bass hit every fourth engine frame: 7.5 a second.
    const fast = Array.from({ length: 180 }, (_, i) =>
      Array.from({ length: BAND_COUNT }, (_, b) => (b < 5 ? (i % 4 === 0 ? 0.95 : 0.15) : 0.2)),
    );
    const beats = run("lively", fast).filter((s) => s.beat > 0).length;
    expect(beats).toBeLessThanOrEqual(6 * BEAT_MAX_PER_SEC);
  });

  it("scales the motion with the level and reads an absent level as Balanced", () => {
    const peak = (r: Reactivity | undefined) => Math.max(...run(r).map((s) => s.bassMotion));
    expect(peak("lively")).toBeGreaterThan(peak("balanced"));
    expect(peak(undefined)).toBe(peak("balanced"));
  });
});
