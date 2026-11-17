/*
 * The lab's measurement modes for one scene: brightness steps over the song's drop, WCAG flashes over the
 * same drop, the brightness a motion signal at its cap may add, and the Calm rule. Each run draws through
 * the real renderer at pixel ratio 1 with the scene's own theme, so a dark-only scene is measured dark.
 * Every result names the theme, layout and luma space it was taken in.
 */

// -- Local Imports --
import {
  LAB_LAYOUTS,
  applyTheme,
  labFrame,
  reseed,
  sceneTheme,
  type LabLayoutId,
  type LabTheme,
} from "./labScene";
import { DROP_START, createLabSong } from "./labSong";
import {
  FLASH_SPAN_FRAMES,
  createFlashMeter,
  meanLuma709,
  readPixels,
  redness,
  relativeLuminance,
  round,
  sha256,
  worstWindow,
} from "./labPixels";

// -- State Imports --
import { restSignal, type VisualSignal } from "../../state/player/visualSignal";

// -- Type Imports --
import type { Renderer } from "../../components/player/visualizers/gl/renderer";
import type { Frame } from "../../components/player/visualizers/gl/kit";

/** A scene to measure, with the cover, the themes and layouts a run covers and a way to open a renderer. */
export interface Probe {
  kind: string;
  darkOnly: boolean;
  cover: ImageBitmap;
  themes: LabTheme[];
  layouts: LabLayoutId[];
  open: (layout: LabLayoutId) => { canvas: HTMLCanvasElement; renderer: Renderer<string> };
}

const DT = 1 / 60;
// The song is followed from its start to two seconds into the drop, then read for ten seconds.
const LEAD_IN = 2;
const READ_SECONDS = 10;
// A third of a second of 60 fps frames: the window the largest brightness swing is taken over.
const SWING_FRAMES = 20;

// WCAG 2.3.1: the general-flash window, the relative-luminance step that counts, and the darker state's ceiling.
const FLASH_WINDOW_W = 341;
const FLASH_WINDOW_H = 256;
const FLASH_STEP = 0.1;
const FLASH_DARKER_BELOW = 0.8;
// The red check: a change of this much in the saturated-red measure counts.
const RED_STEP = 20;

// A held run: its length, the frames that settle before the mean is taken, and the motion cap and beat rate.
const HOLD_FRAMES = 360;
const HOLD_SETTLE = 120;
const MOTION_CAP = 1.6;
const BEATS_PER_SECOND = 3;
// The brightness a motion signal may add to the motionless mean, in percentage points.
const LEVEL_TOLERANCE_PTS = 1.5;
const HOLD_SWELL = 0.32;

const CALM_FRAMES = 120;
const CALM_SAMPLE_EVERY = 10;

/** The themes a probe covers: a dark-only scene has just the one. */
function themesOf(p: Probe): LabTheme[] {
  return p.darkOnly ? ["dark"] : p.themes;
}

/** A fresh renderer and the frame template for one theme and layout, the random stream restarted. */
function begin(p: Probe, theme: LabTheme, layout: LabLayoutId) {
  applyTheme(sceneTheme(p.darkOnly, theme));
  const { canvas, renderer } = p.open(layout);
  reseed();
  const base: Frame = { ...labFrame(sceneTheme(p.darkOnly, theme), layout, p.cover), still: false };
  return { canvas, renderer, base };
}

/**
 * Plays the song at Lively through a fresh renderer and hands each frame of the read window to `onFrame`
 * with the seconds since the window opened. The frames before it are drawn too, so a stateful scene is
 * settled when the reading starts.
 */
function playDrop(
  p: Probe,
  theme: LabTheme,
  layout: LabLayoutId,
  onFrame: (bytes: Uint8Array, since: number) => void,
): void {
  const { canvas, renderer, base } = begin(p, theme, layout);
  const song = createLabSong(0, "lively");
  const start = DROP_START + LEAD_IN;
  for (let t = 0; t < start + READ_SECONDS; t += DT) {
    const m = song.step(DT);
    renderer.render(p.kind, { ...base, sig: m.sig, t, dt: DT });
    if (t >= start) onFrame(readPixels(canvas), t - start);
  }
  renderer.dispose();
}

/**
 * Brightness steps: the largest frame-to-frame change of the stage's mean brightness, the largest swing
 * inside any third of a second, and the mean, over ten seconds of the drop at Lively.
 */
export function runSteps(p: Probe) {
  const rows: Record<string, unknown>[] = [];
  for (const theme of themesOf(p)) {
    for (const layout of p.layouts) {
      const means: number[] = [];
      let maxStep = 0;
      let at = 0;
      playDrop(p, theme, layout, (bytes, since) => {
        const mean = meanLuma709(bytes);
        const prev = means[means.length - 1];
        if (prev !== undefined && Math.abs(mean - prev) > maxStep) {
          maxStep = Math.abs(mean - prev);
          at = since;
        }
        means.push(mean);
      });
      let swing = 0;
      for (let i = 0; i + SWING_FRAMES <= means.length; i++) {
        const win = means.slice(i, i + SWING_FRAMES);
        swing = Math.max(swing, Math.max(...win) - Math.min(...win));
      }
      const { width, height } = LAB_LAYOUTS[layout];
      rows.push({
        theme: sceneTheme(p.darkOnly, theme),
        layout,
        size: `${width}x${height}`,
        maxStepPct: round(maxStep * 100),
        atS: round(at),
        swingPct: round(swing * 100),
        meanPct: round((means.reduce((a, b) => a + b, 0) / means.length) * 100),
      });
    }
  }
  return {
    mode: "steps",
    kind: p.kind,
    lumaSpace: "Rec. 709 luma of sRGB bytes",
    reactivity: "lively",
    song: `drop +${LEAD_IN} s for ${READ_SECONDS} s at 60 fps, pixel ratio 1`,
    rows,
  };
}

// A sequence passes with no more than this many flashes in any second.
const FLASHES_PER_SECOND_LIMIT = 3;

/**
 * WCAG 2.3.1 flashes over ten seconds of the drop at Lively, through `createFlashMeter`: pixels are
 * followed across frames, area transitions are taken over bins of concurrent change, and `flashesPerSec`
 * is the most window flashes in any second. It is the gate: over 3 fails. `flickerSharePct` sums unrelated
 * flicker and is information only; `stepWindowPct` is the single-frame change share. With `red`, the same
 * is done on saturated-red change (a step of 20 in WCAG's (R-G-B) x 320 measure).
 */
export function runDropFlash(p: Probe, red: boolean) {
  const rows: Record<string, unknown>[] = [];
  const windowArea = FLASH_WINDOW_W * FLASH_WINDOW_H;
  for (const theme of themesOf(p)) {
    for (const layout of p.layouts) {
      const { width: w, height: h } = LAB_LAYOUTS[layout];
      const n = w * h;
      const win = { winW: FLASH_WINDOW_W, winH: FLASH_WINDOW_H };
      const lum = createFlashMeter(w, h, { ...win, step: FLASH_STEP, darkerBelow: FLASH_DARKER_BELOW });
      const redMeter = red ? createFlashMeter(w, h, { ...win, step: RED_STEP, darkerBelow: null }) : null;
      const lumVals = new Float32Array(n);
      const redVals = new Float32Array(n);
      const stepMask = new Uint8Array(n);
      let before: Float32Array | null = null;
      let worstStep = 0;
      playDrop(p, theme, layout, (bytes) => {
        for (let i = 0; i < n; i++) {
          lumVals[i] = relativeLuminance(bytes, i * 4);
          if (red) redVals[i] = redness(bytes, i * 4);
        }
        if (before) {
          let changed = 0;
          for (let i = 0; i < n; i++) {
            const a = before[i];
            const b = lumVals[i];
            const hit = Math.abs(b - a) >= FLASH_STEP && Math.min(a, b) < FLASH_DARKER_BELOW ? 1 : 0;
            stepMask[i] = hit;
            changed += hit;
          }
          if (changed > 0) worstStep = Math.max(worstStep, worstWindow(stepMask, w, h, FLASH_WINDOW_W, FLASH_WINDOW_H) / windowArea);
        }
        before = Float32Array.from(lumVals);
        lum.frame(lumVals);
        redMeter?.frame(redVals);
      });
      const seen = lum.result();
      const redSeen = redMeter?.result();
      rows.push({
        theme: sceneTheme(p.darkOnly, theme),
        layout,
        size: `${w}x${h}`,
        flashesPerSec: seen.flashesPerSec,
        measured: seen.measured,
        pass: seen.measured && seen.flashesPerSec <= FLASHES_PER_SECOND_LIMIT,
        flickerSharePct: round(seen.flickerShare * 100),
        stepWindowPct: round(worstStep * 100),
        ...(redSeen
          ? {
              redFlashesPerSec: redSeen.flashesPerSec,
              redPass: redSeen.measured && redSeen.flashesPerSec <= FLASHES_PER_SECOND_LIMIT,
              redFlickerSharePct: round(redSeen.flickerShare * 100),
            }
          : {}),
      });
    }
  }
  return {
    mode: "flash",
    kind: p.kind,
    lumaSpace: "WCAG relative luminance (linear)",
    reactivity: "lively",
    song: `drop +${LEAD_IN} s for ${READ_SECONDS} s at 60 fps, pixel ratio 1`,
    counted: `per pixel across frames, a transition completes when the pixel has moved ${FLASH_STEP} from its last extreme with the darker end under ${FLASH_DARKER_BELOW} (an up transition by the trough it rose from, a down one by the low it reaches); a 341x256 window makes an up or down area transition when a quarter of its pixels complete that transition within the last ${FLASH_SPAN_FRAMES} frames (50 ms), each pixel transition used by one area transition at most; a window flash is an area transition followed by the opposing one within a second; flashesPerSec is the most window flashes in any second over all windows (stride 4 px); flickerSharePct (pixels flashing at any moment, information only, not the gate) and stepWindowPct (single-frame change share) are not gates`,
    gate: `fails when flashesPerSec is over ${FLASHES_PER_SECOND_LIMIT} or the stage is smaller than the window (measured false); the red fields are held to the same`,
    rows,
  };
}

/** A fixed level and swell with the motion signals at `motion`, a beat every third of a second at that cap. */
function heldSignal(level: number, motion: number, beat: boolean, frame: number): VisualSignal {
  const sinceBeat = frame % Math.round(60 / BEATS_PER_SECOND);
  const base = restSignal();
  // The capped run also drives the raw channels high: loud bands and band groups, peak, and flux and kick
  // pulsing with each beat, so a scene whose light follows any of them shows it.
  const bands = beat ? Float32Array.from({ length: 24 }, (_, i) => Math.min(1, 0.95 - i * 0.015 + 0.05 * Math.sin(i + frame))) : base.bands;
  const mean = (from: number, to: number) => bands.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  return {
    ...base,
    bands,
    rms: level,
    level,
    peak: beat ? 1 : base.peak,
    bass: beat ? mean(0, 5) : base.bass,
    mid: beat ? mean(5, 15) : base.mid,
    high: beat ? mean(15, 24) : base.high,
    flux: beat ? Math.exp(-sinceBeat * DT * 8) : 0,
    swell: HOLD_SWELL,
    bassMotion: motion,
    midMotion: motion,
    highMotion: motion,
    drive: motion,
    beat: beat && sinceBeat === 0 ? motion : 0,
    kick: beat ? Math.exp(-sinceBeat * DT * 5.5) : 0,
  };
}

/**
 * The brightness a motion signal at its cap adds. Level and swell are held; one run has no motion and no
 * beats, the other has every envelope at the cap, beats at the rate limit and the bands, band groups,
 * peak, flux and kick high. The means over the settled frames must stay within the tolerance of each other.
 */
export function runLevel(p: Probe, level: number) {
  const rows: Record<string, unknown>[] = [];
  for (const theme of themesOf(p)) {
    for (const layout of p.layouts) {
      const means = [0, 0];
      for (const moving of [false, true]) {
        const { canvas, renderer, base } = begin(p, theme, layout);
        let sum = 0;
        for (let i = 0; i < HOLD_FRAMES; i++) {
          const sig = heldSignal(level, moving ? MOTION_CAP : 0, moving, i);
          renderer.render(p.kind, { ...base, sig, t: 14 + i * DT, dt: DT });
          if (i >= HOLD_SETTLE) sum += meanLuma709(readPixels(canvas));
        }
        means[moving ? 1 : 0] = sum / (HOLD_FRAMES - HOLD_SETTLE);
        renderer.dispose();
      }
      const dev = (means[1] - means[0]) * 100;
      rows.push({
        theme: sceneTheme(p.darkOnly, theme),
        layout,
        restPct: round(means[0] * 100),
        cappedPct: round(means[1] * 100),
        devPts: round(dev),
        ok: Math.abs(dev) <= LEVEL_TOLERANCE_PTS,
      });
    }
  }
  return {
    mode: "level",
    kind: p.kind,
    lumaSpace: "Rec. 709 luma of sRGB bytes",
    held: `level ${level}, swell ${HOLD_SWELL}; capped run: envelopes ${MOTION_CAP}, beats ${BEATS_PER_SECOND} per second, bands, bass/mid/high, peak, flux and kick high`,
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
 * and every motion channel at zero, must draw identical frames.
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
