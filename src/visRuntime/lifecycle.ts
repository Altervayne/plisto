/*
 * One mount of a plugin visualizer inside its frame, from init to dispose. A GL kind compiles off the
 * main thread through the compile gate, and no draw reaches the renderer while a program is still
 * compiling, so the canvas and the trail keep their last image. A tick whose draw waited is folded into
 * the next one, so its beats and time are not lost. `ready` is posted once a frame is on the canvas;
 * until then the host keeps the slot hidden. Compiling advances on every draw attempt, and draw attempts
 * follow ticks, so a frame the webview throttles still finishes. A still is served only before the
 * first tick, since drawing one starts the scene over. While metering is on, the canvas the kind draws on
 * is metered after each drawn frame.
 */

// -- Local Imports --
import { createFrameBuilder } from "./frame";
import { MountError, errorText } from "./gate";
import { browserMeterEnv } from "./meter";
import { createMeterHub } from "./meterHub";
import { foldTick, readHostMessage } from "./protocol";
import { DT_MAX, createFrameTransport } from "./transport";
import { glSurface, rawSurface } from "./surfaces";
import { ProgramPending } from "../components/player/visualizers/gl/kit";
import { createRenderer } from "../components/player/visualizers/gl/renderer";

// -- Type Imports --
import type { VisFrame } from "./frame";
import type { StageMeter } from "./meter";
import type { MeterHub } from "./meterHub";
import type { FrameMessage, Tick, VisContext, VisErrorStage, VisInit, VisLayout } from "./protocol";
import type { Candidate, Kit, ProgramSource } from "../components/player/visualizers/gl/kit";
import type { Surface } from "./surfaces";

/** A GL kind: the programs it declares and the factory the stage calls once they have compiled. */
export interface GlMount {
  form: "gl";
  programs: ProgramSource[];
  factory: (kit: Kit) => Candidate;
}

/** A kind that draws itself. `setup` may return the canvas it draws on, for stills and the meter. */
export interface RawHandlers {
  setup?: (ctx: VisContext) => HTMLCanvasElement | void;
  frame: (frame: VisFrame) => void;
  resize?: (layout: VisLayout) => void;
  theme?: (ctx: VisContext) => void;
  settings?: (settings: VisContext["settings"]) => void;
  // Draws the still frame, or returns it as a bitmap; absent, `frame` draws it.
  still?: (frame: VisFrame) => void | ImageBitmap;
  dispose?: () => void;
}

export interface RawMount {
  form: "raw";
  handlers: RawHandlers;
}

export type Mount = GlMount | RawMount;

/** What a plugin registers: the mount it builds for an init. */
export type Registration = (init: VisInit) => Mount;

/** The port a mount talks over. */
export interface VisPort {
  post: (message: FrameMessage, transfer?: Transferable[]) => void;
  listen: (handler: (data: unknown) => void) => void;
  close: () => void;
}

/** What a mount needs from the page, so tests can stand in for it. */
export interface LifecycleEnv {
  now: () => number;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  // Styles the root for a transparent, full-viewport stage.
  prepareRoot: () => void;
  createCanvas: () => HTMLCanvasElement;
  snapshot: (canvas: HTMLCanvasElement) => Promise<ImageBitmap>;
  createRenderer: typeof createRenderer;
}

// How often a still waiting on a compile retries when no tick comes.
const STILL_POLL_MS = 50;
const STILL_REFUSED = "a still is only drawn before the first tick";

const stageOf = (e: unknown, fallback: VisErrorStage): VisErrorStage =>
  e instanceof MountError ? e.stage : fallback;

const isCanvas = (shot: HTMLCanvasElement | ImageBitmap): shot is HTMLCanvasElement =>
  typeof (shot as HTMLCanvasElement).getContext === "function";

/**
 * Runs one mount until the host disposes it, the context is lost, or it fails. `meters` is the mount's
 * meter hub; a kind's own meters come from it too.
 */
export function startMount(
  init: VisInit,
  port: VisPort,
  mount: Mount,
  env: LifecycleEnv,
  meters: MeterHub = createMeterHub(
    init.meter,
    (reading) => port.post({ type: "flash", reading }),
    browserMeterEnv(),
  ),
): { dispose: () => void } {
  let ctx = init.context;
  let shown = false;
  let stopped = false;
  let ticked = false;
  // The ticks whose draws waited on a compile, folded together.
  let carry: Tick | null = null;
  let stillTimer: number | null = null;
  const stills: number[] = [];
  const frames = createFrameBuilder();
  let surface: Surface | null = null;
  let transport: ReturnType<typeof createFrameTransport> | null = null;
  let stage: StageMeter | null = null;
  let announced = false;

  const clearStillTimer = () => {
    if (stillTimer !== null) env.clearTimer(stillTimer);
    stillTimer = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    transport?.dispose();
    clearStillTimer();
    meters.dispose();
    try {
      surface?.dispose();
    } catch {
      // A plugin's own teardown failing changes nothing for the host.
    }
  };

  const dispose = () => {
    stop();
    port.close();
  };

  const fail = (stage: VisErrorStage, e: unknown) => {
    if (stopped) return;
    for (const id of stills.splice(0)) port.post({ type: "still", id, bitmap: null });
    port.post({ type: "error", stage, message: errorText(e) });
    stop();
  };

  const markShown = () => {
    if (shown) return;
    shown = true;
    announced = surface?.canvas != null || meters.hasAuthored();
    port.post({ type: "ready", metered: announced });
  };

  // A kind that first makes a meter after ready tells the host once.
  meters.onAuthored(() => {
    if (!shown || announced || stopped) return;
    announced = true;
    port.post({ type: "metered" });
  });

  // Whether the frame reached the canvas.
  const draw = (frame: VisFrame): boolean => {
    try {
      surface?.draw(frame);
    } catch (e) {
      if (!(e instanceof ProgramPending)) fail(stageOf(e, "draw"), e);
      return false;
    }
    markShown();
    if (surface?.canvas) (stage ??= meters.stage(surface.canvas)).frame();
    return true;
  };

  const refuseStills = () => {
    clearStillTimer();
    for (const id of stills.splice(0)) port.post({ type: "still", id, bitmap: null, error: STILL_REFUSED });
  };

  const serveStills = () => {
    if (stopped || stills.length === 0 || !surface) return;
    let shot: HTMLCanvasElement | ImageBitmap | null;
    try {
      shot = surface.still(frames.rest(ctx));
    } catch (e) {
      if (!(e instanceof ProgramPending)) fail(stageOf(e, "still"), e);
      else if (stillTimer === null) {
        stillTimer = env.setTimer(() => {
          stillTimer = null;
          surface?.nextFrame();
          serveStills();
        }, STILL_POLL_MS);
      }
      return;
    }
    markShown();
    const ids = stills.splice(0);
    if (shot && !isCanvas(shot)) {
      port.post({ type: "still", id: ids[0], bitmap: shot }, [shot]);
      for (const id of ids.slice(1)) port.post({ type: "still", id, bitmap: null });
      return;
    }
    for (const id of ids) {
      if (!shot) {
        port.post({ type: "still", id, bitmap: null });
        continue;
      }
      // Read in this task: the drawing buffer is cleared once the task ends.
      env.snapshot(shot).then(
        (bitmap) => port.post({ type: "still", id, bitmap }, [bitmap]),
        () => port.post({ type: "still", id, bitmap: null }),
      );
    }
  };

  const lose = () => {
    if (stopped) return;
    port.post({ type: "lost" });
    stop();
  };

  port.listen((data) => {
    const msg = readHostMessage(data);
    if (!msg) return;
    if (msg.type === "dispose") return dispose();
    if (stopped) return;
    switch (msg.type) {
      case "tick":
        transport?.onTick(msg);
        break;
      case "update":
        ctx = { ...ctx, ...msg.context };
        try {
          surface?.update(ctx, msg.context);
        } catch (e) {
          fail("draw", e);
        }
        break;
      case "meter":
        meters.setOn(msg.on);
        break;
      case "still":
        stills.push(msg.id);
        if (ticked) refuseStills();
        else serveStills();
        break;
    }
  });

  env.prepareRoot();
  try {
    surface = mount.form === "gl" ? glSurface(init, mount, env, lose) : rawSurface(init, mount.handlers);
  } catch (e) {
    // Nothing more can come of a mount that never set up.
    fail(stageOf(e, "setup"), e);
    port.close();
    return { dispose };
  }

  transport = createFrameTransport({
    now: env.now,
    requestFrame: env.requestFrame,
    cancelFrame: env.cancelFrame,
    postAck: (seq, ms) => port.post({ type: "ack", seq, ms }),
    step(tick) {
      if (!ticked) {
        ticked = true;
        refuseStills();
      }
      surface?.nextFrame();
      const next = carry ? foldTick(carry, tick) : tick;
      carry = null;
      if (!draw(frames.build(next, Math.min(DT_MAX, next.dt), ctx))) carry = next;
    },
  });

  return { dispose };
}

/** The port a mount talks over, from the one the host transferred. */
export function wrapPort(port: MessagePort): VisPort {
  return {
    post: (message, transfer = []) => port.postMessage(message, transfer),
    listen(handler) {
      port.onmessage = (e) => handler(e.data);
    },
    close: () => port.close(),
  };
}

/** The page the runtime runs in. Touches the document only when called. */
export function browserEnv(): LifecycleEnv {
  return {
    now: () => performance.now(),
    requestFrame: (cb) => requestAnimationFrame(() => cb()),
    cancelFrame: (id) => cancelAnimationFrame(id),
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (id) => window.clearTimeout(id),
    prepareRoot() {
      const root = document.documentElement;
      root.style.colorScheme = "normal";
      root.style.background = "transparent";
      root.style.overflow = "hidden";
      if (document.body) document.body.style.margin = "0";
    },
    createCanvas() {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block";
      (document.body ?? document.documentElement).appendChild(canvas);
      return canvas;
    },
    snapshot: (canvas) => createImageBitmap(canvas),
    createRenderer,
  };
}
