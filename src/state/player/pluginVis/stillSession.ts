/*
 * One kind's still on one surface, off React. The session renders through short-lived mounts, one at a
 * time: the first as soon as the gate opens, then one after each quiet period that follows a change. A
 * change cancels the render in flight, since its still would already be out of date.
 *
 * Until the first meaningful outcome the session reports the stage phase: a still or none enters ready, a
 * failure, a still that does not paint included, ends the session and fails the stage as a live frame
 * does. After it, a new still replaces the painted one and anything else leaves the canvas and the phase
 * as they are. A render that ended only because the gate closed settles nothing and runs again when the
 * gate opens.
 */

// -- Local Imports --
import { reportPhase, type StageSurface } from "./frameCache";
import { isKindStopped, useNetPolicy } from "./netPolicy";
import { renderPluginStill, type StillOutcome, type StillRender } from "./stillMount";

// -- State Imports --
import { usePluginsStore } from "../../plugins/store";

// -- Type Imports --
import type { PluginRuntime } from "../../../types";
import type { VisContext } from "../../../visRuntime/protocol";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";
import type { StagePhase } from "./stageMount";

export type StillPhase = "mounting" | "slow" | "ready" | "ended";

/** Whether renders may run: the runtime and the marks answer, wait for them, or end for good. */
export type StillGate = "open" | "wait" | "blocked";

export function stillGate(runtime: PluginRuntime | null, marksLoaded: boolean, stopped: boolean): StillGate {
  if (runtime === "held" || runtime === "safe" || (marksLoaded && stopped)) return "blocked";
  return runtime === "running" && marksLoaded ? "open" : "wait";
}

/** The gate as the stores stand now. */
export function stillGateNow(kind: PluginVisualizerDescriptor["id"]): StillGate {
  const runtime = usePluginsStore.getState().boot?.runtime ?? null;
  return stillGate(runtime, useNetPolicy.getState().loaded, isKindStopped(kind));
}

/** How long changes must stop before the still renders again. */
export const REPAINT_DELAY_MS = 500;

export interface StillTiming {
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StillSessionOptions {
  descriptor: PluginVisualizerDescriptor;
  surface: StageSurface;
  // The context as of now; read when a render starts.
  context: () => VisContext;
  // Paints a bitmap, or clears the canvas for none; the bitmap is the callee's to close.
  paint: (bitmap: ImageBitmap | null) => void;
  setPhase: (phase: StillPhase) => void;
  // A mount failed before the first outcome, as a live frame's error does.
  onFail: () => void;
  gate?: () => StillGate;
  render?: typeof renderPluginStill;
  timing?: StillTiming;
}

export interface StillSession {
  // The gate is open: renders now if a render is owed.
  open: () => void;
  // The gate is blocked: cancels the render in flight; before the first outcome the stage gives up.
  block: () => void;
  // An input changed: cancels the render in flight and repaints after a quiet period.
  trigger: () => void;
  dispose: () => void;
}

export function createStillSession(options: StillSessionOptions): StillSession {
  const { descriptor, surface, setPhase } = options;
  const kind = descriptor.id;
  const gate = options.gate ?? (() => stillGateNow(kind));
  const render = options.render ?? renderPluginStill;
  const delay = options.timing?.delayMs ?? REPAINT_DELAY_MS;
  const setTimer = options.timing?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.timing?.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // A good still is on the canvas.
  let painted = false;
  // The first meaningful outcome is in.
  let firstSettled = false;
  // The first outcome was a failure: no render runs again, as a failed live mount stays down.
  let ended = false;
  // A render is due that nothing scheduled or in flight will run: the next open gate runs it.
  let owed = true;
  let flight: StillRender | null = null;
  // A render came due while one was still settling; it runs once that one is done.
  let again = false;
  let timer: unknown = null;
  let disposed = false;
  let phase: StillPhase = "mounting";

  const enter = (next: StillPhase, report: StagePhase) => {
    phase = next;
    setPhase(next);
    reportPhase(surface, kind, report);
  };

  // Paints, reading a throw as a failed outcome.
  const paint = (bitmap: ImageBitmap | null): StillOutcome | null => {
    try {
      options.paint(bitmap);
      return null;
    } catch {
      return { type: "failed", phase: "failed" };
    }
  };

  const settle = (settled: StillOutcome) => {
    let outcome = settled;
    if (disposed) {
      if (outcome.type === "still") outcome.bitmap.close();
      return;
    }
    if (outcome.type === "cancelled") return;
    if (outcome.type === "failed" && gate() !== "open") {
      owed = true;
      return;
    }
    if (outcome.type === "still") {
      const failed = paint(outcome.bitmap);
      if (failed) outcome = failed;
      else painted = true;
    } else if (outcome.type === "none" && !painted) {
      outcome = paint(null) ?? outcome;
    }
    if (firstSettled) return;
    firstSettled = true;
    if (outcome.type === "failed") {
      ended = true;
      enter("ended", outcome.phase);
      if (outcome.phase === "failed") options.onFail();
    } else {
      enter("ready", "ready");
    }
  };

  const run = () => {
    timer = null;
    if (disposed || ended) return;
    if (flight) {
      again = true;
      return;
    }
    if (gate() !== "open") {
      owed = true;
      return;
    }
    const context = options.context();
    // An unsized slot renders nothing; the resize watcher triggers once it has a size.
    if (context.layout.width <= 0 || context.layout.height <= 0) return;
    owed = false;
    if (!firstSettled && phase === "ended") enter("mounting", "mounting");
    const mount = render(descriptor, context, {
      onPhase: (p) => {
        if (p === "slow" && !firstSettled && flight === mount) enter("slow", "slow");
      },
    });
    flight = mount;
    mount.result.then(
      (outcome) => {
        flight = null;
        settle(outcome);
        if (again) {
          again = false;
          run();
        }
      },
      () => {
        flight = null;
      },
    );
  };

  const schedule = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(run, ms);
  };

  reportPhase(surface, kind, "mounting");
  return {
    open() {
      // Deferred, so a session made and disposed in one pass of effects never mounts a frame.
      if (!disposed && !ended && owed && !flight && timer === null) schedule(0);
    },
    block() {
      if (disposed || ended) return;
      if (flight) {
        owed = true;
        flight.cancel();
      }
      if (!firstSettled && phase !== "ended") enter("ended", "dropped");
    },
    trigger() {
      if (disposed || ended) return;
      flight?.cancel();
      schedule(delay);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      flight?.cancel();
    },
  };
}
