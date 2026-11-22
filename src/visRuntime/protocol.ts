/*
 * The visualizer frame protocol, shared by the host and the runtime inside the frame. The host posts one
 * `plisto:vis-init` window message that transfers a MessagePort; every later message travels on that
 * port. Ticks are numbered and sent under a credit window: the frame acks the last tick it consumed, and
 * a host out of credit folds new ticks into one held tick. Folding sums `dt` and `nBeats`, keeps the
 * largest value of every one-frame signal event, and takes the latest of everything else, so no beat and
 * no time is lost to a slow frame. This module has no value imports, so it can be copied as plain script.
 */

// -- Type Imports --
import type { VisualSignal } from "../state/player/visualSignal";

/** The visualizer api number this protocol serves. */
export const VIS_API = 1;

/** The `type` of the window message that carries the port. */
export const VIS_INIT_TYPE = "plisto:vis-init";

/** Ticks the host may send before an ack. */
export const TICK_CREDITS = 2;

/** The bridge method a channel message travels as, from a visualizer frame and from a page alike. */
export const CHANNEL_METHOD = "channel.send";

/** The most a channel message may hold: the UTF-8 bytes of its JSON text. */
export const CHANNEL_MAX_BYTES = 16384;

/** The UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The JSON text of a channel message. Throws a TypeError when the data cannot be serialized and a
 * RangeError when its text is over the limit.
 */
export function channelText(data: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(data);
  } catch {
    text = undefined;
  }
  if (typeof text !== "string") throw new TypeError("channel data must be JSON-serializable");
  if (utf8Length(text) > CHANNEL_MAX_BYTES) {
    throw new RangeError(`channel data is over ${CHANNEL_MAX_BYTES} bytes`);
  }
  return text;
}

/** A rect in CSS pixels with a top-left origin: left, top, width, height. */
export type VisRect = [number, number, number, number];

/** An sRGB color in 0..1. */
export type VisRgb = [number, number, number];

/** How the runtime maps a scene onto the stage. */
export type VisComposite = "light" | "ink" | "image";

/** Where the stage and the cover sit, in CSS pixels relative to the frame's viewport. */
export interface VisLayout {
  width: number;
  height: number;
  cover: VisRect;
  radius: number;
  // The rect the layer feathers off outside; null draws the whole stage.
  mask: VisRect | null;
  // The top edge of the element the layer rests on, or null for none.
  floor: number | null;
  // The text blocks the layer may hush behind.
  hush: VisRect[];
}

/** The stage colors a scene paints with besides the palette. */
export interface VisColors {
  ground: VisRgb;
  backing: VisRgb;
  ink: VisRgb;
}

export type VisSettingValue = boolean | number | string;

/** A declared setting as the runtime needs it: a choice's option ids give its uniform index. */
export interface VisSettingShape {
  id: string;
  type: "choice" | "toggle" | "range" | "color";
  options?: string[];
}

/** The state that changes rarely and travels whole at init, then in part with `update`. */
export interface VisContext {
  layout: VisLayout;
  // Three sRGB colors in 0..1, flattened.
  palette: Float32Array;
  // The cover's pixels flipped for GL, or null.
  cover: ImageBitmap | null;
  colors: VisColors;
  // Whether the scene draws light: false for a dark-only kind in a light theme.
  light: boolean;
  reactivity: "calm" | "balanced" | "lively";
  ambient: boolean;
  reducedMotion: boolean;
  settings: Record<string, VisSettingValue>;
}

/** The pointer over the stage, normalized to 0..1, when a kind asks for it. */
export interface VisPointer {
  x: number;
  y: number;
  inside: boolean;
}

/** One display frame of the feed. */
export interface Tick {
  seq: number;
  t: number;
  // Seconds since the last consumed tick: a folded tick carries the sum.
  dt: number;
  sig: VisualSignal;
  // Beats fired since the last consumed tick.
  nBeats: number;
  // The playback position in seconds of the latest beat, or null before any.
  beatAt: number | null;
  // The latest raw engine bands, before any smoothing.
  rawBands: number[];
  fine: number[] | null;
  playing: boolean;
  // Bumps on a track change.
  trackSeq: number;
  progress: number | null;
  pointer: VisPointer | null;
  wave: Float32Array | null;
}

/** The window message that starts a mount; the port arrives as the event's first port. */
export interface VisInit {
  plisto: 1;
  type: typeof VIS_INIT_TYPE;
  api: number;
  kind: string;
  composite: { light: VisComposite; dark: VisComposite };
  fillsStage: boolean;
  needs: { fine: boolean; cover: boolean; pointer: boolean; waveform: boolean };
  settingShapes: VisSettingShape[];
  // Whether the flash meter runs at mount; `meter` messages switch it afterwards.
  meter: boolean;
  // Whether the plugin has a page or background frame to talk to, so `plistoVis.channel` exists.
  channel?: boolean;
  context: VisContext;
}

/** Messages the host sends on the port. */
export type HostMessage =
  | ({ type: "tick" } & Tick)
  | { type: "update"; context: Partial<VisContext> }
  | { type: "still"; id: number }
  | { type: "meter"; on: boolean }
  | { type: "dispose" };

/** What the frame reports with `error`: where the mount failed. */
export type VisErrorStage = "compile" | "setup" | "draw" | "still";

export type VisLogLevel = "debug" | "info" | "warn" | "error";

/** One reading of the flash meter over the registered canvas. */
export interface FlashReading {
  flashesPerSec: number;
  redFlashesPerSec: number;
  // The largest share of a one-third-stage window that flashed, 0..1.
  area: number;
}

/** Messages the frame sends on the port. */
export type FrameMessage =
  // Every tick up to `seq` is consumed. `ms` is the last completed step's cost, or null before one.
  | { type: "ack"; seq: number; ms: number | null }
  // The first frame is on the canvas. `metered` is whether a canvas is registered for the meter.
  | { type: "ready"; metered: boolean }
  // A kind that was not metered at ready registered a canvas afterwards; posted once.
  | { type: "metered" }
  // `error` says why a still was refused; the bitmap is then null.
  | { type: "still"; id: number; bitmap: ImageBitmap | null; error?: string }
  | { type: "lost" }
  | { type: "flash"; reading: FlashReading }
  | { type: "error"; stage: VisErrorStage; message: string }
  | { type: "log"; level: VisLogLevel; text: string };

// -- Folding --

/** How each signal field folds while ticks wait for credit. A new field must be classified here. */
export const SIGNAL_FOLD: Record<keyof VisualSignal, "max" | "latest"> = {
  bands: "latest",
  rms: "latest",
  peak: "latest",
  flux: "max",
  kick: "max",
  bass: "latest",
  mid: "latest",
  high: "latest",
  level: "latest",
  swell: "latest",
  bassMotion: "latest",
  midMotion: "latest",
  highMotion: "latest",
  beat: "max",
  drive: "latest",
  loudness: "latest",
  bassHit: "max",
  midHit: "max",
  highHit: "max",
  beatWeight: "max",
  surge: "max",
  cut: "max",
};

/** The one-frame event fields that keep their largest value across folded ticks. */
export const MAX_CARRY = (Object.keys(SIGNAL_FOLD) as (keyof VisualSignal)[]).filter(
  (key) => SIGNAL_FOLD[key] === "max",
);

/** Folds `next` onto the held tick `held`: sums `dt` and `nBeats`, carries the events' max. */
export function foldTick(held: Tick, next: Tick): Tick {
  const sig: VisualSignal = { ...next.sig };
  for (const key of MAX_CARRY) {
    (sig[key] as number) = Math.max(held.sig[key] as number, next.sig[key] as number);
  }
  return { ...next, sig, dt: held.dt + next.dt, nBeats: held.nBeats + next.nBeats };
}

// -- Host side --

/** The host's half of the credit window. */
export interface TickSender {
  // Sends the tick while credit remains, else folds it into the held tick.
  offer: (tick: Tick) => void;
  // Frees the credit of every sent tick up to `seq`, then sends the held tick if there is room.
  ack: (seq: number) => void;
  outstanding: () => number;
  // Drops the held tick and forgets the ticks in flight, for a frame that stopped consuming.
  reset: () => void;
}

export function createTickSender(send: (tick: Tick) => void, credits: number = TICK_CREDITS): TickSender {
  let inFlight: number[] = [];
  let held: Tick | null = null;

  const push = (tick: Tick) => {
    inFlight.push(tick.seq);
    send(tick);
  };

  return {
    offer(tick) {
      if (held) held = foldTick(held, tick);
      else if (inFlight.length < credits) push(tick);
      else held = tick;
    },
    ack(seq) {
      inFlight = inFlight.filter((s) => s > seq);
      if (held && inFlight.length < credits) {
        const tick = held;
        held = null;
        push(tick);
      }
    },
    outstanding: () => inFlight.length,
    reset() {
      inFlight = [];
      held = null;
    },
  };
}

// -- Reading messages --

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The init message, or null when `data` is not one. */
export function readInit(data: unknown): VisInit | null {
  if (!isObject(data) || data.plisto !== 1 || data.type !== VIS_INIT_TYPE) return null;
  if (!isCount(data.api) || typeof data.kind !== "string" || !isObject(data.context)) return null;
  if (!isObject(data.composite) || !isObject(data.needs) || !Array.isArray(data.settingShapes)) return null;
  if (typeof data.meter !== "boolean") return null;
  if (data.channel !== undefined && typeof data.channel !== "boolean") return null;
  return data as unknown as VisInit;
}

/** A host message, or null for anything malformed or unknown. */
export function readHostMessage(data: unknown): HostMessage | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case "tick":
      return isCount(data.seq) && isNum(data.t) && isNum(data.dt) && data.dt >= 0 && isObject(data.sig) && isCount(data.nBeats)
        ? (data as unknown as HostMessage)
        : null;
    case "update":
      return isObject(data.context) ? (data as unknown as HostMessage) : null;
    case "still":
      return isCount(data.id) ? (data as unknown as HostMessage) : null;
    case "meter":
      return typeof data.on === "boolean" ? { type: "meter", on: data.on } : null;
    case "dispose":
      return { type: "dispose" };
    default:
      return null;
  }
}

/** A frame message, or null for anything malformed or unknown. */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case "ack":
      return isCount(data.seq) && (data.ms === null || isNum(data.ms)) ? (data as unknown as FrameMessage) : null;
    case "ready":
      return typeof data.metered === "boolean" ? (data as unknown as FrameMessage) : null;
    case "metered":
      return { type: "metered" };
    case "still":
      return isCount(data.id) && (data.error === undefined || typeof data.error === "string")
        ? (data as unknown as FrameMessage)
        : null;
    case "lost":
      return { type: "lost" };
    case "flash":
      return isObject(data.reading) ? (data as unknown as FrameMessage) : null;
    case "error":
      return typeof data.stage === "string" && typeof data.message === "string" ? (data as unknown as FrameMessage) : null;
    case "log":
      return typeof data.level === "string" && typeof data.text === "string" ? (data as unknown as FrameMessage) : null;
    default:
      return null;
  }
}
