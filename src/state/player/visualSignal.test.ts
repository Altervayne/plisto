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
  frameLoudness,
  motionEnvelope,
  onsetStrength,
  restSignal,
  WEIGHT_BASS_LAG_EMITS,
  WEIGHT_SPAN_SECS,
  type SignalInput,
  type VisualSignal,
} from "./visualSignal";
import { BAND_COUNT, type LevelFrame } from "../../types";
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

describe("the transient fields", () => {
  /** An engine frame: the bass bands at `bass`, the mids at `mid`, the highs at 0.25. */
  function tick(bass: number, mid = 0.35): number[] {
    return Array.from({ length: BAND_COUNT }, (_, b) => (b < 5 ? bass : b < 15 ? mid : 0.25));
  }

  /** A 120 BPM kick at thirty engine frames a second over steady mids and highs. */
  function hitTrain(seconds: number): number[][] {
    return Array.from({ length: seconds * 30 }, (_, i) => tick(i % 15 < 2 ? 0.9 : 0.3));
  }

  /** Steady bands: no rise anywhere after the first frame. */
  function steady(seconds: number): number[][] {
    return Array.from({ length: seconds * 30 }, () => tick(0.6));
  }

  const loud = (rmsDb: number) => (): LevelFrame => ({ rms: 0.9, peak: 0.95, flux: 0, rmsDb });

  /** Steps a follower over `input`, two display frames per engine frame, with each frame's level from `levelOf`. */
  function follow(
    input: number[][],
    levelOf: (bands: number[], i: number) => LevelFrame,
    reactivity: Reactivity = "balanced",
    follower = createSignalFollower(),
  ): VisualSignal[] {
    const out: VisualSignal[] = [];
    input.forEach((bands, i) => {
      const level = levelOf(bands, i);
      for (let k = 0; k < 2; k++) {
        const s = follower.step(DT, { bands, level, playing: true, reactivity });
        out.push({ ...s, bands: Float32Array.from(s.bands) });
      }
    });
    return out;
  }

  const HIT_FIELDS = ["bassHit", "midHit", "highHit"] as const;
  const EVENT_FIELDS = ["beatWeight", "surge", "cut"] as const;

  it("rests with the loudness at the rest level and every transient at 0", () => {
    const rest = restSignal();
    expect(rest.loudness).toBe(rest.level);
    for (const field of [...HIT_FIELDS, ...EVENT_FIELDS]) expect(rest[field]).toBe(0);
  });

  it("leaves every original field bit-identical", () => {
    // The exact sums of the fields other than the transient ones over this run: a kick train with dBFS on
    // two frames in three, and a one-second pause in the middle.
    const pinned: Record<Reactivity, number> = { calm: 5770.801243252017, balanced: 6983.965090452864, lively: 7647.988671679535 };
    for (const reactivity of ["calm", "balanced", "lively"] as const) {
      const follower = createSignalFollower();
      let sum = 0;
      for (let i = 0; i < 240; i++) {
        const bands = Array.from({ length: BAND_COUNT }, (_, b) => (b < 5 ? (i % 15 < 2 ? 0.9 : 0.3) : b < 15 ? 0.35 : i % 2 === 0 ? 0.5 : 0.3));
        const level: LevelFrame = { rms: bands[0] * 0.8, peak: bands[0], flux: 0, ...(i % 3 === 0 ? {} : { rmsDb: bands[0] > 0.5 ? -8 : -20 }) };
        const playing = i < 150 || i >= 180;
        for (let k = 0; k < 2; k++) {
          const s = follower.step(DT, { bands, level, playing, reactivity });
          sum += s.rms + s.peak + s.flux + s.kick + s.bass + s.mid + s.high + s.level + s.swell;
          sum += s.bassMotion + s.midMotion + s.highMotion + s.beat + s.drive;
          for (const v of s.bands) sum += v;
        }
      }
      expect(sum).toBe(pinned[reactivity]);
    }
  });

  describe("loudness", () => {
    it("maps dBFS through its window, and the unit rms through the engine's window without it", () => {
      expect(frameLoudness({ rms: 0, rmsDb: -6 })).toBe(1);
      expect(frameLoudness({ rms: 0, rmsDb: 0 })).toBe(1);
      expect(frameLoudness({ rms: 0, rmsDb: -33 })).toBe(0);
      expect(frameLoudness({ rms: 0, rmsDb: -120 })).toBe(0);
      expect(frameLoudness({ rms: 0, rmsDb: -19.5 })).toBeCloseTo(0.5, 9);
      // Unit 1 is -10 dBFS, unit 0.5 is -35 dBFS.
      expect(frameLoudness({ rms: 1 })).toBeCloseTo(23 / 27, 9);
      expect(frameLoudness({ rms: 0.5 })).toBe(0);
    });

    it("settles on a steady input and stays live under Calm", () => {
      const balanced = follow(steady(6), loud(-12));
      expect(balanced[balanced.length - 1].loudness).toBeCloseTo(21 / 27, 2);
      expect(follow(steady(6), loud(-12), "calm").map((s) => s.loudness)).toEqual(balanced.map((s) => s.loudness));
    });

    it("moves smoothly on a hit train whose dBFS swings with every kick", () => {
      const sig = follow(hitTrain(6), (bands) => ({ rms: 0.9, peak: 1, flux: 0, rmsDb: bands[0] > 0.5 ? -6 : -30 }));
      for (let i = 1; i < sig.length; i++) expect(Math.abs(sig[i].loudness - sig[i - 1].loudness)).toBeLessThan(0.03);
    });

    it("falls back to the unit rms when the source sends no dBFS", () => {
      const sig = follow(steady(6), () => ({ rms: 0.9, peak: 0.95, flux: 0 }));
      expect(sig[sig.length - 1].loudness).toBeCloseTo(18 / 27, 2);
      for (const s of sig) expect(Number.isFinite(s.loudness)).toBe(true);
    });

    it("starts from the first playing frame instead of easing up from silence", () => {
      const sig = follow(steady(1), loud(-12));
      expect(sig[0].loudness).toBe(frameLoudness({ rms: 0.9, rmsDb: -12 }));
    });

    it("takes the unit rms in place of a non-finite dBFS value", () => {
      for (const rmsDb of [NaN, Infinity, -Infinity]) {
        expect(frameLoudness({ rms: 0.9, rmsDb })).toBe(frameLoudness({ rms: 0.9 }));
        const sig = follow(hitTrain(3), () => ({ rms: 0.9, peak: 1, flux: 0, rmsDb }));
        for (const s of sig) {
          for (const field of [...HIT_FIELDS, ...EVENT_FIELDS, "loudness"] as const) expect(Number.isFinite(s[field])).toBe(true);
        }
      }
    });

    it("reads the same loudness whether a frame carries dBFS or only the unit rms", () => {
      // Unit 0.9 is -15 dBFS, so frames with and without the dBFS value agree.
      const sig = follow(steady(6), (_, i) => ({ rms: 0.9, peak: 1, flux: 0, ...(i % 2 === 0 ? { rmsDb: -15 } : {}) }));
      for (const s of sig) expect(s.loudness).toBeCloseTo(18 / 27, 9);
      for (const s of sig) expect(s.surge + s.cut).toBe(0);
    });

    it("settles where the level does when paused", () => {
      const follower = createSignalFollower();
      follow(steady(3), loud(-8), "balanced", follower);
      for (let i = 0; i < 600; i++) follower.step(DT, { bands: tick(0.6), level: quiet, playing: false });
      expect(follower.signal.loudness).toBeCloseTo(follower.signal.level, 2);
    });
  });

  describe("hits", () => {
    it("punches on every kick of a loud hit train and rests between", () => {
      const tail = follow(hitTrain(6), loud(-9)).slice(120);
      const bass = tail.map((s) => s.bassHit);
      expect(Math.max(...bass)).toBeGreaterThan(0.8);
      expect(bass.filter((v) => v < 0.15).length / bass.length).toBeGreaterThan(0.4);
      // The mids and highs hold still, so they read no hit.
      for (const s of tail) {
        expect(s.midHit).toBeLessThan(0.05);
        expect(s.highHit).toBeLessThan(0.05);
      }
    });

    it("reads near 0 on steady loud music", () => {
      for (const s of follow(steady(6), loud(-8)).slice(60)) {
        for (const field of HIT_FIELDS) expect(s[field]).toBeLessThan(0.05);
      }
    });

    it("stays small on the same kicks in a quiet passage", () => {
      for (const s of follow(hitTrain(6), loud(-40))) expect(s.bassHit).toBeLessThan(0.05);
    });

    it("reads 0 under Calm and scales with the reactivity gain", () => {
      for (const s of follow(hitTrain(6), loud(-9), "calm")) for (const field of HIT_FIELDS) expect(s[field]).toBe(0);
      const peak = (r: Reactivity) => Math.max(...follow(hitTrain(6), loud(-9), r).map((s) => s.bassHit));
      expect(peak("lively")).toBeCloseTo(peak("balanced") * REACTIVITY_PROFILES.lively.gain, 9);
    });

    it("gates on the unit rms when the source sends no dBFS", () => {
      const unit = (rms: number) => () => ({ rms, peak: rms, flux: 0 });
      expect(Math.max(...follow(hitTrain(6), unit(0.9)).map((s) => s.bassHit))).toBeGreaterThan(0.8);
      expect(Math.max(...follow(hitTrain(6), unit(0.3)).map((s) => s.bassHit))).toBeLessThan(0.05);
    });

    it("reads no hit on a resume into steady loud music, even after a zero frame, and the next kick still reads", () => {
      const follower = createSignalFollower();
      follow(hitTrain(2), loud(-9), "balanced", follower);
      for (let i = 0; i < 120; i++) follower.step(DT, { bands: tick(0.6), level: quiet, playing: false });
      const zero = new Array<number>(BAND_COUNT).fill(0);
      const resumed = follow([zero, ...steady(1)], loud(-9), "lively", follower);
      for (const s of resumed) for (const field of HIT_FIELDS) expect(s[field]).toBeLessThan(0.05);
      // Nine steady engine frames after a resume, then a kick, 0.3 s in.
      for (let i = 0; i < 120; i++) follower.step(DT, { bands: tick(0.6), level: quiet, playing: false });
      const kick = follow([...steady(1).slice(0, 9), tick(0.9), tick(0.9), ...steady(1)], loud(-9), "balanced", follower);
      expect(Math.max(...kick.map((s) => s.bassHit))).toBeGreaterThan(0.8);
    });

    it("settles to 0 when paused", () => {
      const follower = createSignalFollower();
      follow(hitTrain(2), loud(-9), "balanced", follower);
      for (let i = 0; i < 60; i++) follower.step(DT, { bands: tick(0.9), level: quiet, playing: false });
      for (const field of HIT_FIELDS) expect(follower.signal[field]).toBeLessThan(1e-3);
    });
  });

  describe("beatWeight", () => {
    // `follow` steps two display frames per engine frame, so a beat's span covers this many frames.
    const SPAN = 2 * (WEIGHT_BASS_LAG_EMITS + 1);

    /** Each beat's display-frame index, its span of weights, its provisional and its final weight. */
    function beats(sig: VisualSignal[]): { i: number; span: number[]; first: number; w: number }[] {
      return sig.flatMap((s, i) => {
        if (s.beat === 0 || i + SPAN > sig.length) return [];
        const span = sig.slice(i, i + SPAN).map((t) => t.beatWeight);
        return [{ i, span, first: span[0], w: span[span.length - 1] }];
      });
    }

    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

    it("starts on the beat frame, only rises over its span, and reads 0 outside it", () => {
      const sig = follow(hitTrain(6), loud(-9));
      const found = beats(sig);
      expect(found.length).toBeGreaterThanOrEqual(10);
      const inSpan = new Set(found.flatMap((b) => b.span.map((_, k) => b.i + k)));
      for (const b of found) {
        for (const v of b.span) expect(v).toBeGreaterThan(0);
        for (let k = 1; k < b.span.length; k++) expect(b.span[k]).toBeGreaterThanOrEqual(b.span[k - 1]);
      }
      sig.forEach((s, i) => {
        if (!inSpan.has(i)) expect(s.beatWeight).toBe(0);
      });
    });

    it("never starts a beat inside the span of the one before", () => {
      const found = beats(follow(hitTrain(6), loud(-9)));
      for (let k = 1; k < found.length; k++) expect(found[k].i - found[k - 1].i).toBeGreaterThanOrEqual(SPAN);
      // The minimum beat gap alone is longer than the span.
      expect(BEAT_MIN_GAP_SECS).toBeGreaterThan((WEIGHT_BASS_LAG_EMITS + 1) / 30);
    });

    it("gives a kick whose bass lands after the onset a provisional weight below its final one", () => {
      // The onset frame lifts the mids; the kick's bass lands on the next engine frame.
      const late = Array.from({ length: 180 }, (_, i) => {
        const p = i % 15;
        return tick(p === 1 || p === 2 ? 0.9 : 0.3, p === 0 ? 0.9 : 0.35);
      });
      const found = beats(follow(late, loud(-9))).filter((b) => b.i >= 60);
      expect(found.length).toBeGreaterThanOrEqual(5);
      for (const b of found) {
        expect(b.first).toBeLessThan(b.w);
        expect(b.w).toBeGreaterThanOrEqual(0.9);
      }
    });

    it("drops to 0 on a pause mid-span and does not resume it", () => {
      const follower = createSignalFollower();
      const level = loud(-9)();
      // Fifteen engine frames, then the second kick starts a span.
      follow(hitTrain(1).slice(0, 15), loud(-9), "balanced", follower);
      const kick = tick(0.9);
      const start = follower.step(DT, { bands: kick, level, playing: true });
      expect(start.beat).toBeGreaterThan(0);
      expect(start.beatWeight).toBeGreaterThan(0);
      expect(follower.step(DT, { bands: kick, level, playing: false }).beatWeight).toBe(0);
      for (let i = 0; i < 6; i++) expect(follower.step(DT, { bands: tick(0.9), level, playing: true }).beatWeight).toBe(0);
    });

    it("closes the span after its time bound when the feed stalls mid-span", () => {
      const follower = createSignalFollower();
      const level = loud(-9)();
      follow(hitTrain(1).slice(0, 15), loud(-9), "balanced", follower);
      const kick = tick(0.9);
      expect(follower.step(DT, { bands: kick, level, playing: true }).beatWeight).toBeGreaterThan(0);
      // The same frame held for a second, still playing: no new emit arrives.
      for (let i = 1; i < 60; i++) {
        const s = follower.step(DT, { bands: kick, level, playing: true });
        if (i * DT > WEIGHT_SPAN_SECS) expect(s.beatWeight).toBe(0);
      }
    });

    it("weighs the first kicks after a cold start, a zero first frame or a resume like steady playback", () => {
      const final = (sig: VisualSignal[], from: number) => beats(sig).filter((b) => b.i >= from)[0].w;
      const steadyWeight = final(follow(hitTrain(6), loud(-9)), 120);
      // Ten engine frames between kicks, then the kick: a third of a second in, past the beat gap that
      // the onset of the first frame opens.
      const entry = hitTrain(3).slice(5);
      const zero = new Array<number>(BAND_COUNT).fill(0);
      const cold = follow(entry, loud(-9));
      const zeroFirst = follow([zero, ...entry], loud(-9));
      const follower = createSignalFollower();
      follow(hitTrain(3), loud(-9), "balanced", follower);
      for (let i = 0; i < 600; i++) follower.step(DT, { bands: tick(0.6), level: quiet, playing: false });
      const resumed = follow(entry, loud(-9), "balanced", follower);
      // Skip the beat the entry itself fires on its first rising frame.
      for (const sig of [cold, zeroFirst, resumed]) expect(final(sig, 10)).toBeGreaterThanOrEqual(0.8 * steadyWeight);
    });

    it("gives the same final weights at 30, 60 and 144 Hz when every engine frame is fed at a steady loudness", () => {
      const input = hitTrain(4);
      const finals = (hz: number) => {
        const follower = createSignalFollower();
        const out: number[] = [];
        let last = 0;
        let inSpan = false;
        for (let k = 0; k < Math.floor(4 * hz); k++) {
          const bands = input[Math.min(input.length - 1, Math.floor((k * 30) / hz))];
          const s = follower.step(1 / hz, { bands, level: loud(-9)(), playing: true });
          if (s.beatWeight > 0) {
            inSpan = true;
            last = s.beatWeight;
          } else if (inSpan) {
            inSpan = false;
            out.push(last);
          }
        }
        return out;
      };
      const at60 = finals(60);
      expect(at60.length).toBeGreaterThanOrEqual(6);
      for (const hz of [30, 144]) {
        const other = finals(hz);
        expect(other).toHaveLength(at60.length);
        other.forEach((w, i) => expect(w).toBeCloseTo(at60[i], 9));
      }
    });

    it("weighs a loud bass-led kick high", () => {
      const weights = beats(follow(hitTrain(6), loud(-9))).filter((b) => b.i >= 60);
      expect(weights.length).toBeGreaterThanOrEqual(10);
      for (const b of weights) expect(b.w).toBeGreaterThan(0.7);
    });

    it("weighs the same kicks low in a quiet passage, where the beat still fires", () => {
      const weights = beats(follow(hitTrain(6), loud(-30)));
      expect(weights.length).toBeGreaterThanOrEqual(10);
      for (const b of weights) expect(b.w).toBeLessThan(0.35);
    });

    it("weighs a kickless onset below a bass-led one", () => {
      const snare = Array.from({ length: 180 }, (_, i) => tick(0.3, i % 15 < 2 ? 0.9 : 0.35));
      const weights = beats(follow(snare, loud(-9))).filter((b) => b.i >= 60);
      expect(weights.length).toBeGreaterThanOrEqual(10);
      for (const b of weights) expect(b.w).toBeLessThan(0.35);
    });

    it("does not lend a kick's bass to a kickless onset after it", () => {
      // A kick every twenty engine frames, and a mid-only onset ten frames after each kick.
      const mixed = Array.from({ length: 300 }, (_, i) => {
        const p = i % 20;
        return tick(p < 2 ? 0.9 : 0.3, p >= 10 && p < 12 ? 0.9 : 0.35);
      });
      const sig = follow(mixed, loud(-9));
      const late = beats(sig).filter((b) => b.i >= 120);
      const kicks = late.filter((b) => Math.floor(b.i / 2) % 20 < 10).map((b) => b.w);
      const kickless = late.filter((b) => Math.floor(b.i / 2) % 20 >= 10).map((b) => b.w);
      expect(kicks.length).toBeGreaterThanOrEqual(5);
      expect(kickless.length).toBeGreaterThanOrEqual(5);
      expect(median(kicks)).toBeGreaterThanOrEqual(0.9);
      expect(median(kickless)).toBeLessThanOrEqual(0.5);
    });

    it("scales an onset down by its share of the recent onsets' mean", () => {
      // Mid-only onsets alternating strong and weak, so the bass term is the same for both.
      const snares = Array.from({ length: 300 }, (_, i) => {
        const strong = i % 30 < 15;
        return tick(0.3, i % 15 < 2 ? (strong ? 0.9 : 0.55) : 0.35);
      });
      const late = beats(follow(snares, loud(-9))).filter((b) => b.i >= 120);
      const strong = late.filter((b) => Math.floor(b.i / 2) % 30 < 15).map((b) => b.w);
      const weak = late.filter((b) => Math.floor(b.i / 2) % 30 >= 15).map((b) => b.w);
      expect(weak.length).toBeGreaterThanOrEqual(3);
      for (const w of weak) expect(w).toBeLessThan(median(strong) * 0.9);
    });

    it("weighs the first kick of a track started mid-song in full", () => {
      // The follower starts at rest and meets a loud passage between kicks.
      const sig = follow(hitTrain(3).slice(5), loud(-9));
      const kicks = beats(sig).filter((b) => b.i > 0);
      expect(kicks[0].w).toBeGreaterThan(0.9);
    });

    it("reads 0 on steady input and under Calm, and scales with the reactivity gain", () => {
      for (const s of follow(steady(6), loud(-9)).slice(SPAN)) expect(s.beatWeight).toBe(0);
      for (const s of follow(hitTrain(6), loud(-9), "calm")) expect(s.beatWeight).toBe(0);
      const balanced = follow(hitTrain(6), loud(-9)).map((s) => s.beatWeight);
      const lively = follow(hitTrain(6), loud(-9), "lively").map((s) => s.beatWeight);
      lively.forEach((w, i) => expect(w).toBeCloseTo(balanced[i] * REACTIVITY_PROFILES.lively.gain, 9));
    });

    it("follows the unit rms when the source sends no dBFS", () => {
      const weights = beats(follow(hitTrain(6), () => ({ rms: 0.95, peak: 1, flux: 0 }))).filter((b) => b.i >= 60);
      expect(weights.length).toBeGreaterThanOrEqual(10);
      for (const b of weights) expect(b.w).toBeGreaterThan(0.5);
    });
  });

  describe("a reactivity change mid-song", () => {
    it("zeroes every transient under Calm and leaves nothing non-finite after it", () => {
      const follower = createSignalFollower();
      const levelOf = loud(-9);
      const run = (r: Reactivity) => follow(hitTrain(3), levelOf, r, follower);
      run("balanced");
      for (const s of run("calm")) for (const field of [...HIT_FIELDS, ...EVENT_FIELDS]) expect(s[field]).toBe(0);
      const back = run("lively");
      for (const s of back) {
        for (const field of [...HIT_FIELDS, ...EVENT_FIELDS, "loudness"] as const) expect(Number.isFinite(s[field])).toBe(true);
      }
      expect(Math.max(...back.map((s) => s.bassHit))).toBeGreaterThan(0.8);
    });
  });

  describe("surge and cut", () => {
    /** Steady bands at `quietDb` for six seconds, then at `loudDb` for six, then back. */
    const step = (quietDb: number, loudDb: number) => (_: number[], i: number): LevelFrame => ({
      rms: 0.5,
      peak: 0.6,
      flux: 0,
      rmsDb: i >= 180 && i < 360 ? loudDb : quietDb,
    });
    const events = (sig: VisualSignal[], field: "surge" | "cut") =>
      sig.flatMap((s, i) => (s[field] > 0 ? [{ t: i * DT, v: s[field] }] : []));

    it("fires one surge as the loudness jumps and one cut as it falls back", () => {
      const sig = follow(steady(18), step(-30, -8));
      const surges = events(sig, "surge");
      const cuts = events(sig, "cut");
      expect(surges).toHaveLength(1);
      expect(cuts).toHaveLength(1);
      expect(surges[0].t).toBeGreaterThan(6);
      expect(surges[0].t).toBeLessThan(6.6);
      expect(cuts[0].t).toBeGreaterThan(12);
      expect(cuts[0].t).toBeLessThan(12.6);
      expect(surges[0].v).toBeGreaterThan(0.9);
      expect(surges[0].v).toBeLessThanOrEqual(1);
    });

    it("holds a second jump closer than the hold, and fires one past it", () => {
      // Quiet, loud, quiet, then loud again: the second jump lands within the hold of the first.
      const db = (bounds: number[]) => (_: number[], i: number): LevelFrame => ({
        rms: 0.5,
        peak: 0.6,
        flux: 0,
        rmsDb: bounds.filter((b) => i >= b).length % 2 === 1 ? -8 : -30,
      });
      expect(events(follow(steady(12), db([120, 156, 192])), "surge")).toHaveLength(1);
      expect(events(follow(steady(16), db([120, 156, 300])), "surge")).toHaveLength(2);
    });

    it("stays silent on steady input and on a hit train", () => {
      for (const s of [...follow(steady(12), loud(-9)), ...follow(hitTrain(12), loud(-9))]) {
        expect(s.surge).toBe(0);
        expect(s.cut).toBe(0);
      }
    });

    it("reads 0 under Calm and scales with the reactivity gain", () => {
      for (const s of follow(steady(18), step(-30, -8), "calm")) {
        expect(s.surge).toBe(0);
        expect(s.cut).toBe(0);
      }
      const balanced = events(follow(steady(18), step(-30, -8)), "surge");
      const lively = events(follow(steady(18), step(-30, -8), "lively"), "surge");
      expect(lively[0].v).toBeCloseTo(balanced[0].v * REACTIVITY_PROFILES.lively.gain, 9);
    });

    it("fires from the unit rms when the source sends no dBFS", () => {
      const unit = (_: number[], i: number): LevelFrame => ({ rms: i >= 180 && i < 360 ? 0.95 : 0.3, peak: 1, flux: 0 });
      const sig = follow(steady(18), unit);
      expect(events(sig, "surge")).toHaveLength(1);
      expect(events(sig, "cut")).toHaveLength(1);
    });

    it("reads no shift across a pause", () => {
      const follower = createSignalFollower();
      const before = follow(steady(4), loud(-30), "balanced", follower);
      for (let i = 0; i < 120; i++) follower.step(DT, { bands: tick(0.6), level: quiet, playing: false });
      const after = follow(steady(6), loud(-8), "balanced", follower);
      for (const s of [...before, ...after]) {
        expect(s.surge).toBe(0);
        expect(s.cut).toBe(0);
      }
    });
  });
});
