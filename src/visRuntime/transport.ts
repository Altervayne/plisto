/*
 * The frame's half of the tick feed. Ticks wait for the frame's own animation frame, so a visible frame
 * draws in step with the display. A frame the webview throttles gets animation frames rarely or never,
 * so a tick that finds them starved is consumed at once, and so is one that lands on a tick still
 * waiting: either way the host's credit comes back within one feed interval. Every consumed tick is
 * acked before the step runs; the drawn step never exceeds DT_MAX, so a resume after a long gap moves
 * the scene by one short step while the tick still carries the whole gap and every beat in it.
 */

// -- Local Imports --
import { foldTick } from "./protocol";

// -- Type Imports --
import type { Tick } from "./protocol";

// With no animation frame for this long, ticks are consumed as they arrive.
export const RAF_STARVED_MS = 100;
// With no tick for this long, the animation frame loop stops until the next one.
export const IDLE_STOP_MS = 250;
// The longest step a scene draws, in seconds.
export const DT_MAX = 0.05;

export interface FrameTransportDeps {
  now: () => number;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  // Acks every tick up to `seq`, with the last completed step's cost in ms or null.
  postAck: (seq: number, ms: number | null) => void;
  // Draws one consumed tick. `tick.dt` is the whole time it covers; `dt` is the clamped step.
  step: (tick: Tick, dt: number) => void;
}

export interface FrameTransport {
  onTick: (tick: Tick) => void;
  dispose: () => void;
}

export function createFrameTransport(deps: FrameTransportDeps): FrameTransport {
  let waiting: Tick | null = null;
  let lastTickAt = -Infinity;
  let lastFrameAt = -Infinity;
  let frameId: number | null = null;
  let lastMs: number | null = null;
  let disposed = false;

  const consume = () => {
    const tick = waiting;
    if (!tick) return;
    waiting = null;
    deps.postAck(tick.seq, lastMs);
    const start = deps.now();
    try {
      deps.step(tick, Math.min(DT_MAX, tick.dt));
    } finally {
      lastMs = deps.now() - start;
    }
  };

  const onFrame = () => {
    frameId = null;
    if (disposed) return;
    lastFrameAt = deps.now();
    consume();
    if (deps.now() - lastTickAt < IDLE_STOP_MS) frameId = deps.requestFrame(onFrame);
  };

  return {
    onTick(tick) {
      if (disposed) return;
      const now = deps.now();
      lastTickAt = now;
      const queued = waiting !== null;
      waiting = waiting ? foldTick(waiting, tick) : tick;
      if (frameId === null) {
        // A restarted loop counts from now, so its first tick waits for the frame it asked for.
        lastFrameAt = now;
        frameId = deps.requestFrame(onFrame);
      }
      if (queued || now - lastFrameAt > RAF_STARVED_MS) consume();
    },
    dispose() {
      disposed = true;
      waiting = null;
      if (frameId !== null) deps.cancelFrame(frameId);
      frameId = null;
    },
  };
}
