// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createSolarFlareState, stepSolarFlare, type SolarFlareState } from "./solarFlare";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

const DT = 1 / 60;
const LIVELY = 1.6;
// Beats at the follower's cap: three a second.
const BEAT_EVERY = 20;
// The frames a beat's weight is held for, rising as the kick's bass lands.
const WEIGHT_FRAMES = 6;
// A full kick's weight under Lively.
const KICK = 1.5;
// The loudness of the quiet stretch, the still's.
const REST_LOUD = 0.3;
// The quiet stretch before the drop, in frames, and the frame the drop's surge fires on.
const QUIET = 900;
const SURGE_AT = QUIET + 24;

const sig = (over: Partial<VisualSignal>): VisualSignal =>
  ({
    rms: 0.3,
    level: 0.5,
    swell: 0.1,
    loudness: REST_LOUD,
    bassMotion: 0,
    midMotion: 0,
    highMotion: 0,
    bassHit: 0,
    midHit: 0,
    highHit: 0,
    beat: 0,
    beatWeight: 0,
    surge: 0,
    cut: 0,
    drive: LIVELY,
    ...over,
  }) as VisualSignal;

/** A beat's weight `since` frames after its onset: it starts low, rises to `full` as the bass lands, then reads 0. */
function weightAt(since: number, full: number): number {
  return since < WEIGHT_FRAMES ? full * Math.min(1, 0.4 + 0.2 * since) : 0;
}

/** A loud passage at frame i: every motion envelope, hit and beat at the cap, each beat weighing `weight`. */
function loud(i: number, weight = KICK, drive = LIVELY): VisualSignal {
  const since = i % BEAT_EVERY;
  const m = since < 4 ? LIVELY : 0.4;
  const hit = since < 4 ? LIVELY : 0;
  return sig({
    level: 1,
    swell: 0.5,
    loudness: 0.9,
    bassMotion: m,
    midMotion: m,
    highMotion: m,
    bassHit: hit,
    midHit: hit,
    highHit: hit,
    beat: since === 0 ? 1.5 : 0,
    beatWeight: weightAt(since, weight),
    drive,
  });
}

/** A song at frame i: a quiet stretch, then a drop that lands with a surge. */
function drop(i: number, drive = LIVELY): VisualSignal {
  if (i < QUIET) return sig({ drive });
  return { ...loud(i, KICK, drive), surge: i === SURGE_AT ? LIVELY : 0 };
}

/** What the shader reads, so two runs can be compared by their pixels' inputs. */
function uniforms(st: SolarFlareState) {
  return [
    st.heat, st.shine, st.churn, st.heave, st.stir, st.beat, st.jump, st.spike, st.spark, st.flow, st.rainClk, st.stream,
    st.high, st.highClk, ...st.regA, ...st.regB, ...st.ropeA, ...st.ropeB, ...st.jet, ...st.wave, ...st.kink,
  ];
}

/** The strengths the shader reads for the surface waves, the blast wave's slot left out. */
function waveStrengths(st: SolarFlareState): number[] {
  return Array.from({ length: st.wave.length / 4 - 1 }, (_, i) => st.wave[(i + 1) * 4 + 3]);
}

/** The largest sideways shove the shader reads for a kink, and the brightest jet. */
function kinkShove(st: SolarFlareState): number {
  return Math.max(...Array.from({ length: st.kink.length / 2 }, (_, i) => Math.abs(st.kink[i * 2 + 1])));
}
function jetLight(st: SolarFlareState): number {
  return Math.max(...Array.from({ length: st.jet.length / 4 }, (_, i) => st.jet[i * 4 + 3]));
}

/** The height arcade k stands at, before a beat lifts it. */
function height(st: SolarFlareState, k: number): number {
  return st.regs[k].size * st.regs[k].stand;
}

/** Runs `frames` of `at` through a fresh state and counts the ropes that leave an arcade. */
function eruptions(frames: number, at: (i: number) => VisualSignal): { count: number; times: number[]; st: SolarFlareState } {
  const st = createSolarFlareState();
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const had = st.lastErupt;
    stepSolarFlare(st, at(i), DT, true, false);
    if (st.lastErupt !== had) times.push(i * DT);
  }
  return { count: times.length, times, st };
}

describe("stepSolarFlare", () => {
  it.each([
    ["Player", false],
    ["ambient", true],
  ])("reaches meaningful values and stays in range under Lively at the cap (%s)", (_name, ambient) => {
    const st = createSolarFlareState();
    const peak = { shine: 0, heat: 0, size: 0, rain: 0, rope: 0, quake: 0, jet: 0, kink: 0, beat: 0, wave: 0, spike: 0, spark: 0 };
    const low = { heat: 1, size: 9, rain: 1 };
    for (let i = 0; i < 1800; i++) {
      stepSolarFlare(st, drop(i), DT, true, ambient);
      peak.shine = Math.max(peak.shine, st.shine);
      peak.heat = Math.max(peak.heat, st.heat);
      low.heat = Math.min(low.heat, st.heat);
      st.regs.forEach((g, k) => {
        peak.size = Math.max(peak.size, height(st, k));
        low.size = Math.min(low.size, height(st, k));
        peak.rain = Math.max(peak.rain, g.rain);
        low.rain = Math.min(low.rain, g.rain);
      });
      peak.rope = Math.max(peak.rope, st.ropeA[3]);
      peak.quake = Math.max(peak.quake, st.wave[3]);
      peak.wave = Math.max(peak.wave, ...waveStrengths(st));
      peak.beat = Math.max(peak.beat, st.beat);
      peak.spike = Math.max(peak.spike, st.spike);
      peak.spark = Math.max(peak.spark, st.spark);
      peak.jet = Math.max(peak.jet, jetLight(st));
      peak.kink = Math.max(peak.kink, kinkShove(st));
    }
    // The level reaches its cap and the drop heats the disc white-hot without passing its ceiling.
    expect(peak.shine).toBeGreaterThan(0.9);
    expect(peak.heat).toBeGreaterThan(0.9);
    expect(peak.heat).toBeLessThanOrEqual(1);
    // The quiet stretch holds the still's heat: a lit star, never a dying one.
    expect(low.heat).toBeGreaterThan(0.4);
    expect(low.size).toBeGreaterThan(0.2);
    expect(peak.size).toBeLessThan(1.6);
    expect(low.rain).toBeGreaterThan(0.2);
    expect(peak.rain).toBeGreaterThan(0.5);
    // The surge snaps an arcade: a rope leaves it and a blast wave runs over the surface.
    expect(peak.rope).toBeGreaterThan(0.3);
    expect(peak.rope).toBeLessThanOrEqual(1);
    expect(peak.quake).toBeGreaterThan(0.3);
    // A full beat lands: the envelope, a surface wave, a jet, a kink and the two hit envelopes.
    expect(peak.beat).toBeGreaterThan(1);
    expect(peak.wave).toBeGreaterThan(0.6);
    expect(peak.jet).toBeGreaterThan(0.9);
    expect(peak.jet).toBeLessThanOrEqual(1);
    expect(peak.kink).toBeGreaterThan(0.15);
    expect(peak.spike).toBeGreaterThan(1);
    expect(peak.spark).toBeGreaterThan(1);
  });

  it("lands a beat or a hit past the heaviest the follower sends no harder", () => {
    const run = (top: number) => {
      const st = createSolarFlareState();
      for (let i = 0; i < 240; i++) {
        const since = i % BEAT_EVERY;
        const hit = since < 4 ? top : 0;
        stepSolarFlare(st, sig({ loudness: 0.9, beatWeight: since < WEIGHT_FRAMES ? top : 0, bassHit: hit, highHit: hit }), DT, true, false);
      }
      return uniforms(st);
    };
    expect(run(2 * LIVELY)).toEqual(run(LIVELY));
  });

  it.each([
    ["Player", false],
    ["ambient", true],
  ])("moves in small steps under Lively beats at the cap (%s)", (_name, ambient) => {
    const st = createSolarFlareState();
    const most = { heat: 0, shine: 0, size: 0, rain: 0, churn: 0, flow: 0, beat: 0, lull: 0 };
    let erupted = 0;
    for (let i = 0; i < 2400; i++) {
      const before = {
        heat: st.heat,
        shine: st.shine,
        size: st.regs.map((_g, k) => height(st, k)),
        rain: st.regs.map((g) => g.rain),
        churn: st.churn,
        flow: st.flow,
        beat: st.beat,
        lull: st.lull,
      };
      const had = st.lastErupt;
      // A cut in the middle of the drop, so the lull's step is measured too.
      stepSolarFlare(st, { ...drop(i), cut: i === 1500 ? LIVELY : 0 }, DT, true, ambient);
      if (st.lastErupt !== had) erupted++;
      most.heat = Math.max(most.heat, Math.abs(st.heat - before.heat));
      most.shine = Math.max(most.shine, Math.abs(st.shine - before.shine));
      st.regs.forEach((g, k) => {
        most.size = Math.max(most.size, Math.abs(height(st, k) - before.size[k]));
        most.rain = Math.max(most.rain, Math.abs(g.rain - before.rain[k]));
      });
      most.churn = Math.max(most.churn, st.churn - before.churn);
      most.flow = Math.max(most.flow, st.flow - before.flow);
      most.beat = Math.max(most.beat, st.beat - before.beat);
      most.lull = Math.max(most.lull, Math.abs(st.lull - before.lull));
    }
    // The loudness jumps in one frame here; the heat still takes its ease.
    expect(most.heat).toBeLessThan(0.03);
    expect(most.shine).toBeLessThan(0.02);
    // The arcade drops as it snaps or as a cut sinks it, over half a second, never in one frame.
    expect(most.size).toBeLessThan(0.03);
    expect(most.rain).toBeLessThan(0.02);
    expect(most.churn).toBeLessThan(0.08);
    expect(most.flow).toBeLessThan(0.04);
    // The beat's light is eased in over a few frames, and the lull comes on over a third of a second.
    expect(most.beat).toBeLessThan(0.6);
    expect(most.lull).toBeLessThan(0.08);
    // The surge is the drop's one eruption: the beats that follow it are inside the rest after an eruption.
    expect(erupted).toBe(1);
  });

  it("starts at the passage's heat when opened mid-song", () => {
    const hot = createSolarFlareState();
    const quiet = createSolarFlareState();
    stepSolarFlare(hot, loud(1), DT, true, false);
    stepSolarFlare(quiet, sig({ level: 0.2, swell: 0.05, loudness: 0.05 }), DT, true, false);
    expect(hot.heat).toBeGreaterThan(0.95);
    expect(quiet.heat).toBeLessThan(0.25);
  });

  it("sets the heat, the churn and the arcades by the loudness, the same at Balanced and Lively", () => {
    const run = (loudness: number, drive: number) => {
      const st = createSolarFlareState();
      for (let i = 0; i < 600; i++) stepSolarFlare(st, sig({ loudness, drive }), DT, true, false);
      return st;
    };
    const silent = run(0.05, LIVELY);
    const rest = run(REST_LOUD, LIVELY);
    const hot = run(0.88, LIVELY);
    expect(silent.heat).toBeLessThan(rest.heat - 0.2);
    expect(hot.heat).toBeGreaterThan(rest.heat + 0.4);
    // A loud passage churns several times faster than a near-silent one, and its arcades stand taller.
    expect(hot.churn).toBeGreaterThan(silent.churn * 3);
    expect(hot.stir).toBeGreaterThan(silent.stir + 0.7);
    expect(height(hot, 0)).toBeGreaterThan(height(silent, 0) + 0.25);
    expect(run(0.88, 1).heat).toBe(hot.heat);
    // Calm keeps the heat, which is light, and drops the churn to its idle pace.
    const calm = run(0.88, 0);
    expect(calm.heat).toBe(hot.heat);
    expect(calm.stir).toBe(0);
    expect(calm.churn).toBeLessThan(silent.churn);
  });

  it("holds the still's heat through a pause and finds the passage's heat again", () => {
    const st = createSolarFlareState();
    const rest = createSolarFlareState().heat;
    for (let i = 0; i < 20 * 60; i++) stepSolarFlare(st, loud(i), DT, true, false);
    const before = st.heat;
    // Paused, the follower lets the level and the swell fall to the resting arch.
    for (let i = 0; i < 60 * 60; i++) stepSolarFlare(st, sig({ level: 0.1, swell: 0.05, loudness: 0.9 }), DT, false, false);
    expect(st.heat).toBeCloseTo(rest, 3);
    for (let i = 0; i < 5 * 60; i++) stepSolarFlare(st, loud(i), DT, true, false);
    expect(Math.abs(st.heat - before)).toBeLessThan(0.03);
  });

  it("gives no beat, hit or shift reaction under Calm or while paused", () => {
    const quiet = createSolarFlareState();
    const calm = createSolarFlareState();
    const paused = createSolarFlareState();
    const still = createSolarFlareState();
    for (let i = 0; i < 2400; i++) {
      const s = { ...drop(i), cut: i === 1500 ? LIVELY : 0 };
      stepSolarFlare(quiet, sig({ level: s.level, swell: s.swell, loudness: s.loudness, drive: 0 }), DT, true, false);
      stepSolarFlare(calm, { ...s, drive: 0 }, DT, true, false);
      stepSolarFlare(paused, s, DT, false, false);
      stepSolarFlare(still, sig({ level: s.level, swell: s.swell, drive: 0 }), DT, false, false);
    }
    for (const st of [calm, paused]) {
      expect(st.jets).toHaveLength(0);
      expect(st.kinks).toHaveLength(0);
      expect(st.waves).toHaveLength(0);
      expect(st.rope).toBeNull();
      expect(st.quake).toBeNull();
      expect(st.beat).toBe(0);
      expect(st.jump).toBe(0);
      expect(st.spike).toBe(0);
      expect(st.spark).toBe(0);
      expect(st.lull).toBe(0);
    }
    expect(uniforms(calm)).toEqual(uniforms(quiet));
    expect(uniforms(paused)).toEqual(uniforms(still));
  });

  it.each([
    ["Calm", (s: VisualSignal) => ({ s: { ...s, drive: 0 }, playing: true })],
    ["a pause", (s: VisualSignal) => ({ s, playing: false })],
  ])("fades out everything in flight within half a second of %s", (_name, change) => {
    const st = createSolarFlareState();
    // The drop's eruption is under two seconds old, a cut has just sunk the arcades and a kick is landing.
    const stop = SURGE_AT + 100;
    for (let i = 0; i < stop; i++) stepSolarFlare(st, { ...drop(i), cut: i === stop - 30 ? 1 : 0 }, DT, true, false);
    // Arcade 0 snapped and rains; arcade 2 never snaps, so the cut alone has sunk it and its rain is the idle one.
    const flight = () => ({
      rope: st.ropeA[3],
      blast: st.wave[3],
      ring: Math.max(...waveStrengths(st)),
      kink: kinkShove(st),
      jet: jetLight(st),
      beat: st.beat,
      jump: st.jump,
      spike: st.spike,
      spark: st.spark,
      lull: st.lull,
      sink: 1 - st.regs[2].stand,
      snap: 1 - st.regs[0].stand,
      rain: st.regs[0].rain - st.regs[2].rain,
    });
    const before = flight();
    for (const key of ["rope", "blast", "ring", "jet", "beat", "jump", "spike", "spark", "lull", "snap"] as const) {
      expect(before[key]).toBeGreaterThan(0.3);
    }
    expect(before.kink).toBeGreaterThan(0.05);
    expect(before.sink).toBeGreaterThan(0.1);
    expect(before.rain).toBeGreaterThan(0.1);
    // Nothing rises again, and what was in flight fades, never cut: no more than a fifth of it goes in a frame.
    let last = before;
    for (let i = 0; i < 30; i++) {
      const { s, playing } = change({ ...drop(stop + i), surge: i === 10 ? LIVELY : 0, cut: i === 20 ? 1 : 0 });
      stepSolarFlare(st, s, DT, playing, false);
      const now = flight();
      for (const key of ["rope", "blast", "beat", "spike", "spark", "lull", "sink", "snap"] as const) {
        expect(now[key]).toBeLessThanOrEqual(last[key]);
      }
      for (const key of ["rope", "blast", "sink", "snap"] as const) expect(last[key] - now[key]).toBeLessThan(0.2 * before[key]);
      last = now;
    }
    for (const key of ["rope", "blast", "ring", "kink", "jet", "beat", "jump", "spike", "spark", "lull", "sink"] as const) {
      expect(last[key]).toBeLessThan(0.02);
    }
    expect(last.snap).toBeLessThan(0.03);
    expect(last.rain).toBeLessThan(0.05);
    // What was in flight is then gone, and the loud passage starts nothing new.
    for (let i = 30; i < 90; i++) {
      const { s, playing } = change(drop(stop + i));
      stepSolarFlare(st, s, DT, playing, false);
    }
    expect(st.rope).toBeNull();
    expect(st.quake).toBeNull();
    expect(st.jets).toHaveLength(0);
    expect(st.kinks).toHaveLength(0);
    expect(st.waves).toHaveLength(0);
    expect(Math.max(...st.jet, ...st.kink, ...st.wave, st.ropeA[3])).toBe(0);
  });

  it("lands a beat by its weight: none in a quiet passage, a faint one without a kick, a full one on a kick", () => {
    const land = (weight: number, rising = true) => {
      const st = createSolarFlareState();
      const peak = { beat: 0, wave: 0, kink: 0, jet: 0, lift: 0 };
      for (let i = 0; i < 120; i++) {
        const since = i - 60;
        const on = since >= 0 && since < WEIGHT_FRAMES;
        const beatWeight = on ? weightAt(rising ? since : 0, weight) : 0;
        stepSolarFlare(st, sig({ loudness: 0.9, beat: since === 0 ? LIVELY : 0, beatWeight }), DT, true, false);
        peak.beat = Math.max(peak.beat, st.beat);
        peak.wave = Math.max(peak.wave, ...waveStrengths(st));
        peak.kink = Math.max(peak.kink, kinkShove(st));
        peak.jet = Math.max(peak.jet, jetLight(st));
        peak.lift = Math.max(peak.lift, st.regA[3] / height(st, 0));
      }
      return peak;
    };
    const none = land(0);
    const faint = land(0.25 * LIVELY);
    const full = land(0.9 * LIVELY);
    for (const key of ["beat", "wave", "kink", "jet"] as const) expect(none[key]).toBe(0);
    expect(none.lift).toBeCloseTo(1, 6);
    for (const key of ["beat", "wave", "kink", "jet", "lift"] as const) {
      expect(faint[key]).toBeGreaterThan(none[key]);
      expect(full[key]).toBeGreaterThan(faint[key] * 1.5 - (key === "lift" ? 0.5 : 0));
    }
    // The wave and the envelope take the weight the beat ends on: a beat that stays at the weight it starts on
    // lands less than half as hard.
    const start = land(0.9 * LIVELY, false);
    expect(full.wave).toBeGreaterThan(start.wave * 2);
    expect(full.beat).toBeGreaterThan(start.beat * 2);
    // A full beat throws the loops several times further than a faint one.
    expect(full.kink).toBeGreaterThan(0.2);
    expect(full.lift).toBeGreaterThan(1.08);
  });

  it("keeps the waves of a 128 BPM kick apart and clears each before it muddles the next", () => {
    const st = createSolarFlareState();
    const every = 28;
    let gone = true;
    let oldest: { wave: object; strength: number } | null = null;
    for (let i = 0; i < 600; i++) {
      const since = i % every;
      stepSolarFlare(st, sig({ loudness: 0.9, beatWeight: weightAt(since, 1.2) }), DT, true, false);
      const rings = st.waves.map((w, k) => ({ radius: st.wave[(k + 1) * 4 + 2], strength: st.wave[(k + 1) * 4 + 3], age: w.age }));
      // Successive rings are a clear gap apart, and an older ring is fainter than the one behind it.
      for (let k = 1; k < rings.length; k++) {
        expect(rings[k - 1].radius - rings[k].radius).toBeGreaterThan(0.2);
        if (rings[k].age > 0.15) expect(rings[k - 1].strength).toBeLessThan(rings[k].strength);
      }
      // A ring leaves only once it has faded: a new beat never pushes a visible one out.
      if (oldest && st.waves[0] !== oldest.wave) expect(oldest.strength).toBeLessThan(0.1);
      oldest = st.waves.length > 0 ? { wave: st.waves[0], strength: rings[0].strength } : null;
      if (i > 300 && rings.length > 0 && rings[0].strength > 0.5 && rings[0].age > 1.3) gone = false;
    }
    // No ring is still strong late in its life.
    expect(gone).toBe(true);
    for (let i = 0; i < 120; i++) stepSolarFlare(st, sig({ loudness: 0.9 }), DT, true, false);
    expect(st.waves).toHaveLength(0);
    expect(Math.max(...waveStrengths(st))).toBe(0);
  });

  it("erupts on a surge that lands loud, sized by the surge, and on nothing smaller", () => {
    // A quiet passage with beats and bass rises: nothing.
    const quiet = eruptions(120 * 60, (i) => sig({ swell: 0.1 + 0.3 * ((i % 600) / 600), beat: i % 30 === 0 ? LIVELY : 0, beatWeight: weightAt(i % 30, 0.1) }));
    expect(quiet.count).toBe(0);
    // A steady loud passage whose beats carry half their weight, the bass rising and falling: nothing.
    const steady = eruptions(120 * 60, (i) => ({ ...loud(i, 0.5 * LIVELY), swell: 0.3 + 0.3 * ((i % 600) / 600) }));
    expect(steady.count).toBe(0);
    // A surge that lands in a passage that stays quiet: nothing.
    const hollow = eruptions(20 * 60, (i) => sig({ surge: i === 300 ? LIVELY : 0 }));
    expect(hollow.count).toBe(0);
    // A surge whose passage turns loud within the wait: one, on the frame the loudness arrives.
    const landing = eruptions(20 * 60, (i) => sig({ loudness: i < 320 ? 0.2 : 0.8, surge: i === 300 ? LIVELY : 0 }));
    expect(landing.count).toBe(1);
    expect(landing.times[0]).toBeCloseTo(320 * DT, 5);
    // A stronger surge throws a bigger rope and a stronger blast wave.
    const flare = (surge: number) => {
      const st = createSolarFlareState();
      for (let i = 0; i < 400; i++) stepSolarFlare(st, sig({ loudness: 0.85, surge: i === 300 ? surge : 0 }), DT, true, false);
      return { height: st.ropeA[1], width: st.ropeA[2], light: st.ropeA[3], blast: st.wave[3] };
    };
    const small = flare(0.4);
    const big = flare(LIVELY);
    for (const key of ["height", "width", "light", "blast"] as const) expect(big[key]).toBeGreaterThan(small[key] * 1.15);
  });

  it("erupts rarely on a long run of full-weight beats at high loudness", () => {
    const run = eruptions(150 * 60, (i) => loud(i));
    expect(run.count).toBeGreaterThanOrEqual(1);
    expect(run.count).toBeLessThanOrEqual(3);
    // The first needs several seconds of the run, and the next waits several times longer than that.
    expect(run.times[0]).toBeGreaterThan(4);
    for (let k = 1; k < run.times.length; k++) expect(run.times[k] - run.times[k - 1]).toBeGreaterThan(5 * run.times[0]);
    // The same beats in a passage that is not loud never fire one.
    expect(eruptions(150 * 60, (i) => ({ ...loud(i), loudness: 0.5 })).count).toBe(0);
  });

  it("starts a second rope only once the first has cleared", () => {
    const st = createSolarFlareState();
    let ropes = 0;
    let most = 0;
    for (let i = 0; i < 1200; i++) {
      const had = st.rope;
      const light = st.ropeA[3];
      stepSolarFlare(st, sig({ loudness: 0.85, surge: i === 60 || i === 360 ? LIVELY : 0 }), DT, true, false);
      if (st.rope && st.rope !== had) ropes++;
      most = Math.max(most, Math.abs(st.ropeA[3] - light));
    }
    expect(ropes).toBe(2);
    // The first rope fades out before the second fades in: its light never steps.
    expect(most).toBeLessThan(0.08);
  });

  it("cools the sun and sinks its arcades on a cut, until the lull fades", () => {
    const run = (cutAt: number, frames: number) => {
      const st = createSolarFlareState();
      for (let i = 0; i < frames; i++) stepSolarFlare(st, sig({ loudness: 0.85, cut: i === cutAt ? 1 : 0 }), DT, true, false);
      return st;
    };
    const steady = run(-1, 700);
    const cut = run(600, 700);
    expect(cut.lull).toBeGreaterThan(0.4);
    expect(cut.heat).toBeLessThan(steady.heat - 0.08);
    for (let k = 0; k < 3; k++) expect(height(cut, k)).toBeLessThan(height(steady, k) - 0.1);
    const later = run(600, 2400);
    const never = run(-1, 2400);
    expect(later.lull).toBeLessThan(0.01);
    expect(later.heat).toBeCloseTo(never.heat, 2);
    expect(height(later, 0)).toBeCloseTo(height(never, 0), 2);
  });

  it("clears a cut on a surge: the rope and the first kicks are as large as with no cut", () => {
    const surgeAt = 900;
    // Half-weight kicks, so the surge's eruption is the only one. `gap` is the frames from the cut to the surge.
    const run = (gap: number | null) => {
      const st = createSolarFlareState();
      const seen = { sunk: 0, rope: 0, lull: 0, lift: 0 };
      for (let i = 0; i < surgeAt + 60; i++) {
        const cut = gap !== null && i === surgeAt - gap ? 1 : 0;
        stepSolarFlare(st, { ...loud(i, 0.5 * LIVELY), cut, surge: i === surgeAt ? LIVELY : 0 }, DT, true, false);
        if (i === surgeAt - 1) seen.sunk = height(st, 1);
        if (i === surgeAt + 18) seen.lull = st.lull;
        if (i === surgeAt + 30) seen.rope = st.ropeA[1];
        // Arcade 1 does not snap: its height as the shader reads it, over the kicks after the drop's first.
        if (i >= surgeAt + 18) seen.lift = Math.max(seen.lift, st.regA[7]);
      }
      return seen;
    };
    const free = run(null);
    expect(free.rope).toBeGreaterThan(0.3);
    for (const gap of [18, 36, 60]) {
      const cut = run(gap);
      // The cut had sunk the arcade when the surge landed.
      expect(cut.sunk).toBeLessThan(free.sunk * 0.96);
      expect(cut.lull).toBeLessThan(0.05);
      expect(cut.rope / free.rope).toBeGreaterThan(0.97);
      expect(cut.rope / free.rope).toBeLessThan(1.03);
      expect(cut.lift / free.lift).toBeGreaterThan(0.97);
      expect(cut.lift / free.lift).toBeLessThan(1.03);
    }
  });

  it("settles back to rest after the drop", () => {
    const st = createSolarFlareState();
    const rest = createSolarFlareState();
    for (let i = 0; i < 2400; i++) stepSolarFlare(st, drop(i), DT, true, false);
    for (let i = 0; i < 600 * 60; i++) {
      stepSolarFlare(st, sig({}), DT, true, false);
      stepSolarFlare(rest, sig({}), DT, true, false);
    }
    expect(st.rope).toBeNull();
    expect(st.quake).toBeNull();
    expect(st.jets).toHaveLength(0);
    expect(st.kinks).toHaveLength(0);
    expect(st.waves).toHaveLength(0);
    expect(st.heat).toBeCloseTo(rest.heat, 3);
    expect(st.stir).toBeCloseTo(REST_LOUD, 3);
    expect(st.beat).toBeLessThan(0.001);
    expect(st.spike).toBeLessThan(0.001);
    expect(st.spark).toBeLessThan(0.001);
    expect(st.run).toBeLessThan(0.001);
    expect(st.bass).toBeLessThan(0.001);
    expect(st.mid).toBeLessThan(0.001);
    expect(st.high).toBeLessThan(0.001);
    st.regs.forEach((g, k) => {
      expect(g.stand).toBeCloseTo(1, 3);
      expect(g.wet).toBeLessThan(0.001);
      expect(g.rain).toBeCloseTo(rest.regs[k].rain, 2);
    });
    expect(Math.max(...st.jet, ...st.kink, ...st.wave)).toBe(0);
  });

  it("replays the same frames for the same music", () => {
    const run = (ambient: boolean) => {
      const st = createSolarFlareState();
      for (let i = 0; i < 1800; i++) stepSolarFlare(st, drop(i), DT, true, ambient);
      return uniforms(st);
    };
    expect(run(false)).toEqual(run(false));
    expect(run(true)).not.toEqual(run(false));
  });
});
