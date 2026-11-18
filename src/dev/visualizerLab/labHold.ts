/*
 * The lab's held-signal measures: the brightness a motion signal at its cap adds to a motionless run at the
 * same drive, and the Calm rule. Each holds level and swell fixed and varies only what the rule is about.
 */

// -- Local Imports --
import { begin, themesOf, type Probe } from "./labMeasure";
import { sceneTheme } from "./labScene";
import { meanLuma709, readPixels, round, sha256 } from "./labPixels";

// -- State Imports --
import { restSignal, type VisualSignal } from "../../state/player/visualSignal";

const DT = 1 / 60;

// A held run: its length, the frames that settle before the mean is taken, and the motion cap and beat rate.
const HOLD_FRAMES = 360;
const HOLD_SETTLE = 120;
export const MOTION_CAP = 1.6;
const BEATS_PER_SECOND = 3;
// The brightness a motion signal may add to the motionless mean, in percentage points.
const LEVEL_TOLERANCE_PTS = 1.5;
export const HOLD_SWELL = 0.32;

const CALM_FRAMES = 120;
const CALM_SAMPLE_EVERY = 10;

/**
 * The three held runs. `capped` has every motion envelope and the drive at the cap, beats at the rate limit
 * and the bands high. `rest` has the same drive with no envelopes, no beats and the bands at rest, so the
 * only difference from `capped` is motion. `calmRest` is `rest` with the drive at 0, the Calm setting.
 */
export type HeldRun = "capped" | "rest" | "calmRest";

/** A fixed level and swell for one held run, a beat every third of a second in the capped run. */
export function heldSignal(level: number, run: HeldRun, frame: number): VisualSignal {
  const capped = run === "capped";
  const motion = capped ? MOTION_CAP : 0;
  const sinceBeat = frame % Math.round(60 / BEATS_PER_SECOND);
  const base = restSignal();
  // The capped run also drives the raw channels high: loud bands and band groups, peak, and flux and kick
  // pulsing with each beat, so a scene whose light follows any of them shows it.
  const bands = capped ? Float32Array.from({ length: 24 }, (_, i) => Math.min(1, 0.95 - i * 0.015 + 0.05 * Math.sin(i + frame))) : base.bands;
  const mean = (from: number, to: number) => bands.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  return {
    ...base,
    bands,
    rms: level,
    level,
    peak: capped ? 1 : base.peak,
    bass: capped ? mean(0, 5) : base.bass,
    mid: capped ? mean(5, 15) : base.mid,
    high: capped ? mean(15, 24) : base.high,
    flux: capped ? Math.exp(-sinceBeat * DT * 8) : 0,
    swell: HOLD_SWELL,
    bassMotion: motion,
    midMotion: motion,
    highMotion: motion,
    drive: run === "calmRest" ? 0 : MOTION_CAP,
    beat: capped && sinceBeat === 0 ? MOTION_CAP : 0,
    kick: capped ? Math.exp(-sinceBeat * DT * 5.5) : 0,
  };
}

/** The mean brightness of the composited picture over the settled frames of one held run. */
function heldMean(p: Probe, theme: Probe["themes"][number], layout: Probe["layouts"][number], level: number, run: HeldRun): number {
  const { renderer, base, read } = begin(p, theme, layout);
  let sum = 0;
  for (let i = 0; i < HOLD_FRAMES; i++) {
    renderer.render(p.kind, { ...base, sig: heldSignal(level, run, i), t: 14 + i * DT, dt: DT });
    if (i >= HOLD_SETTLE) sum += meanLuma709(read());
  }
  renderer.dispose();
  return sum / (HOLD_FRAMES - HOLD_SETTLE);
}

/**
 * The brightness a motion signal at its cap adds. Level and swell are held. The gate compares the capped
 * run with a rest run at the same drive, so a scene whose light is scaled by the reactivity setting itself
 * is not read as motion adding light; the means over the settled frames must stay within the tolerance of
 * each other. A third run at drive 0 is reported beside it for information.
 */
export function runLevel(p: Probe, level: number) {
  const rows: Record<string, unknown>[] = [];
  for (const theme of themesOf(p)) {
    for (const layout of p.layouts) {
      const rest = heldMean(p, theme, layout, level, "rest");
      const capped = heldMean(p, theme, layout, level, "capped");
      const calmRest = heldMean(p, theme, layout, level, "calmRest");
      const dev = (capped - rest) * 100;
      rows.push({
        theme: sceneTheme(p.darkOnly, theme),
        layout,
        restPct: round(rest * 100),
        cappedPct: round(capped * 100),
        devPts: round(dev),
        ok: Math.abs(dev) <= LEVEL_TOLERANCE_PTS,
        calmRestPct: round(calmRest * 100),
        calmDevPts: round((capped - calmRest) * 100),
      });
    }
  }
  return {
    mode: "level",
    kind: p.kind,
    lumaSpace: "Rec. 709 luma of the composited sRGB picture (ground, then the layer in its blend)",
    held: `level ${level}, swell ${HOLD_SWELL}; capped run: drive and envelopes ${MOTION_CAP}, beats ${BEATS_PER_SECOND} per second, bands, bass/mid/high, peak, flux and kick high; rest run: drive ${MOTION_CAP}, envelopes 0, no beats, bands at rest; calm rest run: the rest run with drive 0`,
    gate: `devPts (capped minus rest, both at drive ${MOTION_CAP}) is the gate: ok when its size is within tolerancePts; calmRestPct and calmDevPts compare against the drive 0 run and are information only`,
    tolerancePts: LEVEL_TOLERANCE_PTS,
    frames: `${HOLD_FRAMES} at 60 fps, mean over the last ${HOLD_FRAMES - HOLD_SETTLE}, pixel ratio 1`,
    rows,
  };
}

/** A signal under Calm: the level and swell are shared; the bands, the band groups, kick and flux are `varied`. */
function calmSignal(frame: number, varied: boolean): VisualSignal {
  const level = 0.4 + 0.1 * Math.sin(frame * 0.05);
  const bands = Float32Array.from({ length: 24 }, (_, i) => (varied ? 0.15 + 0.8 * Math.abs(Math.sin(i * 2.3 + frame * 0.7)) : 0.1));
  const mean = (from: number, to: number) => bands.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  return {
    ...restSignal(),
    bands,
    rms: level,
    level,
    swell: HOLD_SWELL,
    bass: mean(0, 5),
    mid: mean(5, 15),
    high: mean(15, 24),
    kick: varied ? 0.9 : 0,
    flux: varied ? 0.8 : 0,
  };
}

/**
 * The Calm rule: two runs with the same level and swell but different bands, band groups, kick and flux,
 * and every motion channel at zero, must draw identical frames. The raw framebuffer is hashed.
 */
export async function runCalm(p: Probe) {
  const rows: Record<string, unknown>[] = [];
  for (const theme of themesOf(p)) {
    for (const layout of p.layouts) {
      const runs: string[][] = [];
      for (const varied of [false, true]) {
        const { canvas, renderer, base } = begin(p, theme, layout);
        const hashes: string[] = [];
        for (let i = 0; i < CALM_FRAMES; i++) {
          renderer.render(p.kind, { ...base, sig: calmSignal(i, varied), t: 14 + i * DT, dt: DT });
          if ((i + 1) % CALM_SAMPLE_EVERY === 0) hashes.push(await sha256(readPixels(canvas)));
        }
        renderer.dispose();
        runs.push(hashes);
      }
      const differing = runs[0].flatMap((h, i) => (h === runs[1][i] ? [] : [(i + 1) * CALM_SAMPLE_EVERY]));
      rows.push({ theme: sceneTheme(p.darkOnly, theme), layout, identical: differing.length === 0, differingFrames: differing });
    }
  }
  return {
    mode: "calm",
    kind: p.kind,
    varied:
      "bands, bass/mid/high, kick and flux, on purpose: under Calm a scene must take no motion from them; held: level, swell, rms, peak and every motion channel at 0",
    frames: `${CALM_FRAMES} at 60 fps, sampled every ${CALM_SAMPLE_EVERY}, pixel ratio 1`,
    rows,
  };
}
