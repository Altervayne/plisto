/*
 * The frame a plugin visualizer draws: the built-in kinds' Frame, plus what only the feed knows. The
 * fine spectrum is eased here with the same rates the built-in stage uses, so a plugin sees the same
 * motion a built-in kind does.
 */

// -- Local Imports --
import { smoothBands } from "../state/player/smoothBands";
import { restSignal } from "../state/player/visualSignal";

// -- Type Imports --
import type { Frame } from "../components/player/visualizers/gl/kit";
import type { Tick, VisColors, VisContext, VisPointer, VisSettingValue } from "./protocol";

export interface VisFrame extends Frame {
  settings: Record<string, VisSettingValue>;
  rawBands: number[];
  // Beats fired since the last drawn frame.
  nBeats: number;
  // The playback position in seconds of the latest beat, or null before any.
  beatAt: number | null;
  trackSeq: number;
  pointer: VisPointer | null;
  wave: Float32Array | null;
  colors: VisColors;
}

// The fine spectrum's easing, the rates the built-in stage uses.
const FINE_ATTACK = 0.5;
const FINE_DECAY = 0.15;
// The time a still frame is drawn at.
const STILL_T = 14;

export interface FrameBuilder {
  // The frame for a consumed tick, drawn with step `dt`.
  build: (tick: Tick, dt: number, ctx: VisContext) => VisFrame;
  // A still frame on the resting signal, at the latest tick's track state.
  rest: (ctx: VisContext) => VisFrame;
}

export function createFrameBuilder(): FrameBuilder {
  let fine: number[] | null = null;
  let latest: Tick | null = null;

  const shared = (ctx: VisContext) => ({
    palette: ctx.palette,
    light: ctx.light,
    ambient: ctx.ambient,
    cover: ctx.cover,
    mirrored: false,
    backing: ctx.colors.backing,
    ground: ctx.colors.ground,
    settings: ctx.settings,
    colors: ctx.colors,
  });

  return {
    build(tick, dt, ctx) {
      latest = tick;
      fine = tick.fine ? smoothBands(fine ?? [], tick.fine, FINE_ATTACK, FINE_DECAY) : null;
      return {
        ...shared(ctx),
        t: tick.t,
        dt,
        sig: tick.sig,
        still: false,
        playing: tick.playing,
        fine,
        progress: tick.progress,
        rawBands: tick.rawBands,
        nBeats: tick.nBeats,
        beatAt: tick.beatAt,
        trackSeq: tick.trackSeq,
        pointer: tick.pointer,
        wave: tick.wave,
      };
    },
    rest(ctx) {
      return {
        ...shared(ctx),
        t: STILL_T,
        dt: 1 / 60,
        sig: restSignal(),
        still: true,
        playing: latest?.playing ?? false,
        fine: null,
        progress: latest?.progress ?? null,
        rawBands: [],
        nBeats: 0,
        beatAt: latest?.beatAt ?? null,
        trackSeq: latest?.trackSeq ?? 0,
        pointer: null,
        wave: null,
      };
    },
  };
}
