/*
 * The lab's song measures for one scene: brightness steps and WCAG flashes over a window of the song, and
 * Fireflies' worst-case flash. Each run draws through the real renderer at pixel ratio 1 with the scene's own
 * theme, so a dark-only scene is measured dark, and reads the composited picture: the layout's ground with
 * the layer over it in the kind's blend. Every result names the theme, layout and luma space it was taken in.
 */

// -- Local Imports --
import { fireflyProbe } from "../../components/player/visualizers/gl/fireflies";
import { createComposer } from "./labCompose";
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
  redness,
  relativeLuminance,
  round,
  worstWindow,
} from "./labPixels";

// -- State Imports --
import type { Reactivity } from "../../state/player/visualizerKind";

// -- Type Imports --
import type { Renderer } from "../../components/player/visualizers/gl/renderer";
import type { Frame } from "../../components/player/visualizers/gl/kit";
import type { ReadWindow } from "./labParams";
import type { GlBlendMode } from "../../state/player/visualizerRegistry";

/** A scene to measure, with the cover, the themes and layouts a run covers and a way to open a renderer. */
export interface Probe {
  kind: string;
  darkOnly: boolean;
  // Whether the scene draws from the 128-band spectrum, which the song then supplies.
  needsFine: boolean;
  // The song seconds a steps or flash run reads, and the reactivity the song is followed at.
  window: ReadWindow;
  reactivity: Reactivity;
  // The blend the layer takes over the stage in the scene's light.
  blend: (light: boolean) => GlBlendMode;
  cover: ImageBitmap;
  themes: LabTheme[];
  layouts: LabLayoutId[];
  open: (layout: LabLayoutId) => { canvas: HTMLCanvasElement; renderer: Renderer<string> };
}

const DT = 1 / 60;
// The default window: from two seconds into the song's drop, for ten seconds.
const LEAD_IN = 2;
const READ_SECONDS = 10;
export const DEFAULT_WINDOW: ReadWindow = { from: DROP_START + LEAD_IN, length: READ_SECONDS };
// A third of a second of 60 fps frames: the window the largest brightness swing is taken over.
const SWING_FRAMES = 20;

// WCAG 2.3.1: the general-flash window, the relative-luminance step that counts, and the darker state's ceiling.
const FLASH_WINDOW_W = 341;
const FLASH_WINDOW_H = 256;
const FLASH_STEP = 0.1;
const FLASH_DARKER_BELOW = 0.8;
// The red check: a change of this much in the saturated-red measure counts.
const RED_STEP = 20;

const PICTURE = "Rec. 709 luma of the composited sRGB picture (ground, then the layer in its blend)";

/** The themes a probe covers: a dark-only scene has just the one. */
export function themesOf(p: Probe): LabTheme[] {
  return p.darkOnly ? ["dark"] : p.themes;
}

/**
 * A fresh renderer and the frame template for one theme and layout, the random stream restarted. `read`
 * returns the composited picture in `readPixels` byte order; its array is reused by the next call.
 */
export function begin(p: Probe, theme: LabTheme, layout: LabLayoutId) {
  const drawn = sceneTheme(p.darkOnly, theme);
  applyTheme(drawn);
  const { canvas, renderer } = p.open(layout);
  reseed();
  const base: Frame = { ...labFrame(drawn, layout, p.cover), still: false };
  const { width, height } = LAB_LAYOUTS[layout];
  const compose = createComposer(width, height, base.ground, p.blend(base.light));
  return { canvas, renderer, base, read: () => compose(canvas) };
}

/** The song's window as text, for a result. */
function windowText(p: Probe): string {
  const { from, length } = p.window;
  return `song time ${from} s to ${round(from + length)} s (${length} s) at 60 fps, pixel ratio 1`;
}

/**
 * Plays the song through a fresh renderer and hands each frame of the read window to `onFrame` with the
 * seconds since the window opened. The frames before it are drawn too, so a stateful scene is settled when
 * the reading starts.
 */
function playDrop(
  p: Probe,
  theme: LabTheme,
  layout: LabLayoutId,
  onFrame: (bytes: Uint8Array, since: number) => void,
): void {
  const { renderer, base, read } = begin(p, theme, layout);
  const song = createLabSong(0, p.reactivity);
  const { from, length } = p.window;
  let framesRead = 0;
  for (let t = 0; t < from + length; t += DT) {
    const m = song.step(DT);
    renderer.render(p.kind, { ...base, sig: m.sig, fine: p.needsFine ? m.fine : null, t, dt: DT });
    if (t >= from) {
      onFrame(read(), t - from);
      framesRead++;
    }
  }
  renderer.dispose();
  if (framesRead === 0) throw new Error(`the window ${from} s for ${length} s holds no frame`);
}

/**
 * Brightness steps: the largest frame-to-frame change of the stage's mean brightness, the largest swing
 * inside any third of a second, and the mean, over the window of the song.
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
      const swung = means.length >= SWING_FRAMES;
      const { width, height } = LAB_LAYOUTS[layout];
      rows.push({
        theme: sceneTheme(p.darkOnly, theme),
        layout,
        size: `${width}x${height}`,
        maxStepPct: round(maxStep * 100),
        atS: round(at),
        atSongS: round(p.window.from + at),
        swingPct: swung ? round(swing * 100) : null,
        meanPct: round((means.reduce((a, b) => a + b, 0) / means.length) * 100),
      });
    }
  }
  return {
    mode: "steps",
    kind: p.kind,
    lumaSpace: PICTURE,
    reactivity: p.reactivity,
    song: windowText(p),
    swing: `swingPct is null when the window holds fewer than ${SWING_FRAMES} frames, the span a swing is taken over`,
    rows,
  };
}

// A sequence passes with no more than this many flashes in any second.
const FLASHES_PER_SECOND_LIMIT = 3;

/**
 * WCAG 2.3.1 flashes over the window of the song, through `createFlashMeter`: pixels are followed across
 * frames, area transitions are taken over bins of concurrent change, and `flashesPerSec` is the most window
 * flashes in any second. It is the gate: over 3 fails. `flickerSharePct` sums unrelated flicker and is
 * information only; `stepWindowPct` is the single-frame change share. With `red`, the same is done on
 * saturated-red change (a step of 20 in WCAG's (R-G-B) x 320 measure).
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
    lumaSpace: "WCAG relative luminance (linear) of the composited sRGB picture (ground, then the layer in its blend)",
    reactivity: p.reactivity,
    song: windowText(p),
    counted: `per pixel across frames, a transition completes when the pixel has moved ${FLASH_STEP} from its last extreme with the darker end under ${FLASH_DARKER_BELOW} (an up transition by the trough it rose from, a down one by the low it reaches); a 341x256 window makes an up or down area transition when a quarter of its pixels complete that transition within the last ${FLASH_SPAN_FRAMES} frames (50 ms), each pixel transition used by one area transition at most; a window flash is an area transition followed by the opposing one within a second; flashesPerSec is the most window flashes in any second over all windows (stride 4 px); flickerSharePct (pixels flashing at any moment, information only, not the gate) and stepWindowPct (single-frame change share) are not gates`,
    gate: `fails when flashesPerSec is over ${FLASHES_PER_SECOND_LIMIT} or the stage is smaller than the window (measured false); the red fields are held to the same`,
    rows,
  };
}

// The frames each of Fireflies' two shots runs, and the share of a window that may change (WCAG's quarter).
const FIREFLY_FRAMES = 31;
const FIREFLY_LIMIT_PCT = 25;

/**
 * Fireflies' worst case through the real renderer: every light at its blink floor, the level at maximum, once
 * with no swell and once with the group at full swell. Reports the share of the composited stage that changes
 * by 0.1 relative luminance or more, and the most inside any 341 x 256 window. `p` is a probe of Fireflies.
 */
export function runFireflyFlash(p: Probe, theme: LabTheme) {
  const rows: { layout: string; theme: string; stagePct: number; windowPct: number }[] = [];
  fireflyProbe.floor = true;
  try {
    for (const layout of p.layouts) {
      const shot = (swell: boolean): Uint8Array => {
        const { renderer, base, read } = begin(p, theme, layout);
        for (let i = 0; i < FIREFLY_FRAMES; i++) {
          const sig = { ...base.sig, level: 1, drive: 1.5, beat: swell && i === 0 ? 1 : 0 };
          renderer.render(p.kind, { ...base, sig, t: 14 + i / 60, still: false });
        }
        const bytes = read().slice();
        renderer.dispose();
        return bytes;
      };
      const rest = shot(false);
      const full = shot(true);
      const w = LAB_LAYOUTS[layout].width;
      const h = LAB_LAYOUTS[layout].height;
      const mask = new Uint8Array(w * h);
      let changed = 0;
      for (let i = 0; i < w * h; i++) {
        const hit = Math.abs(relativeLuminance(full, i * 4) - relativeLuminance(rest, i * 4)) >= FLASH_STEP ? 1 : 0;
        mask[i] = hit;
        changed += hit;
      }
      const worst = worstWindow(mask, w, h, FLASH_WINDOW_W, FLASH_WINDOW_H);
      rows.push({
        layout,
        theme,
        stagePct: round((100 * changed) / (w * h)),
        windowPct: round((100 * worst) / (FLASH_WINDOW_W * FLASH_WINDOW_H)),
      });
    }
  } finally {
    fireflyProbe.floor = false;
  }
  return {
    mode: "flash",
    kind: p.kind,
    lumaSpace: "WCAG relative luminance (linear) of the composited sRGB picture (ground, then the layer in its blend)",
    worstCase: "every light at its blink floor, level at maximum, once with no swell and once with the group at full swell",
    limitPct: FIREFLY_LIMIT_PCT,
    rows,
  };
}
